import { PluginEvent, ProcessedPluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'

import { runInSpan } from '../../../sentry'
import { Hub, PipelineEvent, PostIngestionEvent } from '../../../types'
import { DependencyUnavailableError } from '../../../utils/db/error'
import { timeoutGuard } from '../../../utils/db/utils'
import { status } from '../../../utils/status'
import { LazyPersonContainer } from '../lazy-person-container'
import { generateEventDeadLetterQueueMessage } from '../utils'
import { populateTeamDataStep } from './1-populateTeamDataStep'
import { emitToBufferStep } from './2-emitToBufferStep'
import { pluginsProcessEventStep } from './3-pluginsProcessEventStep'
import { processPersonsStep } from './4-processPersonsStep'
import { prepareEventStep } from './5-prepareEventStep'
import { createEventStep } from './6-createEventStep'
import { runAsyncHandlersStep } from './7-runAsyncHandlersStep'

export type StepParameters<T extends (...args: any[]) => any> = T extends (
    runner: EventPipelineRunner,
    ...args: infer P
) => any
    ? P
    : never

const EVENT_PIPELINE_STEPS = {
    populateTeamDataStep,
    emitToBufferStep,
    pluginsProcessEventStep,
    processPersonsStep,
    prepareEventStep,
    createEventStep,
    runAsyncHandlersStep,
}

export type EventPipelineStepsType = typeof EVENT_PIPELINE_STEPS
export type StepType = keyof EventPipelineStepsType
export type NextStep<Step extends StepType> = [StepType, StepParameters<EventPipelineStepsType[Step]>]

export type StepResult =
    | null
    | NextStep<'populateTeamDataStep'>
    | NextStep<'emitToBufferStep'>
    | NextStep<'pluginsProcessEventStep'>
    | NextStep<'processPersonsStep'>
    | NextStep<'prepareEventStep'>
    | NextStep<'createEventStep'>
    | NextStep<'runAsyncHandlersStep'>

// Only used in tests
export type EventPipelineResult = {
    lastStep: StepType
    args: any[]
    error?: string
}

const STEPS_TO_EMIT_TO_DLQ_ON_FAILURE: Array<StepType> = [
    'populateTeamDataStep',
    'emitToBufferStep',
    'pluginsProcessEventStep',
    'processPersonsStep',
    'prepareEventStep',
    'createEventStep',
]

export class EventPipelineRunner {
    hub: Hub
    originalEvent: PipelineEvent | ProcessedPluginEvent

    constructor(hub: Hub, originalEvent: PipelineEvent | ProcessedPluginEvent) {
        this.hub = hub
        this.originalEvent = originalEvent
    }

    // KLUDGE: This is a temporary entry point for the pipeline while we transition away from
    // hitting Postgres in the capture endpoint. Eventually the entire pipeline should
    // follow this route and we can rename it to just be `runEventPipeline`.
    async runLightweightCaptureEndpointEventPipeline(event: PipelineEvent): Promise<EventPipelineResult> {
        this.hub.statsd?.increment('kafka_queue.lightweight_capture_endpoint_event_pipeline.start', {
            pipeline: 'lightweight_capture',
        })
        const result = await this.runPipeline('populateTeamDataStep', event)
        this.hub.statsd?.increment('kafka_queue.single_event.processed_and_ingested')
        return result
    }

    async runEventPipeline(event: PluginEvent): Promise<EventPipelineResult> {
        this.hub.statsd?.increment('kafka_queue.event_pipeline.start', { pipeline: 'event' })
        const result = await this.runPipeline('emitToBufferStep', event)
        this.hub.statsd?.increment('kafka_queue.single_event.processed_and_ingested')
        return result
    }

    async runBufferEventPipeline(event: PluginEvent): Promise<EventPipelineResult> {
        this.hub.statsd?.increment('kafka_queue.event_pipeline.start', { pipeline: 'buffer' })
        const personContainer = new LazyPersonContainer(event.team_id, event.distinct_id, this.hub)
        // We fetch person and check for existence for metrics for buffer efficiency
        const didPersonExistAtStart = !!(await personContainer.get())

        const result = await this.runPipeline('pluginsProcessEventStep', event, personContainer)

        this.hub.statsd?.increment('kafka_queue.buffer_event.processed_and_ingested', {
            didPersonExistAtStart: String(!!didPersonExistAtStart),
        })
        return result
    }

    async runAsyncHandlersEventPipeline(event: PostIngestionEvent): Promise<EventPipelineResult> {
        this.hub.statsd?.increment('kafka_queue.event_pipeline.start', { pipeline: 'asyncHandlers' })
        const personContainer = new LazyPersonContainer(event.teamId, event.distinctId, this.hub)
        const result = await this.runPipeline('runAsyncHandlersStep', event, personContainer)
        this.hub.statsd?.increment('kafka_queue.async_handlers.processed')
        return result
    }

    private async runPipeline<Step extends StepType, ArgsType extends StepParameters<EventPipelineStepsType[Step]>>(
        name: Step,
        ...args: ArgsType
    ): Promise<EventPipelineResult> {
        let currentStepName: StepType = name
        let currentArgs: any = args

        while (true) {
            const timer = new Date()
            try {
                const stepResult = await this.runStep(currentStepName, ...currentArgs)

                this.hub.statsd?.increment('kafka_queue.event_pipeline.step', { step: currentStepName })
                this.hub.statsd?.timing('kafka_queue.event_pipeline.step.timing', timer, { step: currentStepName })

                if (stepResult) {
                    ;[currentStepName, currentArgs] = stepResult
                } else {
                    this.hub.statsd?.increment('kafka_queue.event_pipeline.step.last', {
                        step: currentStepName,
                        team_id: String(this.originalEvent?.team_id),
                    })
                    return {
                        lastStep: currentStepName,
                        args: currentArgs.map((arg: any) => this.serialize(arg)),
                    }
                }
            } catch (error) {
                await this.handleError(error, currentStepName, currentArgs)
                return {
                    lastStep: currentStepName,
                    args: currentArgs.map((arg: any) => this.serialize(arg)),
                    error: error.message,
                }
            }
        }
    }

    protected runStep<Step extends StepType, ArgsType extends StepParameters<EventPipelineStepsType[Step]>>(
        name: Step,
        ...args: ArgsType
    ): Promise<StepResult> {
        return runInSpan(
            {
                op: 'runStep',
                description: name,
            },
            () => {
                const timeout = timeoutGuard('Event pipeline step stalled. Timeout warning after 30 sec!', {
                    step: name,
                    event: JSON.stringify(this.originalEvent),
                })
                try {
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-expect-error
                    return EVENT_PIPELINE_STEPS[name](this, ...args)
                } finally {
                    clearTimeout(timeout)
                }
            }
        )
    }

    nextStep<Step extends StepType, ArgsType extends StepParameters<EventPipelineStepsType[Step]>>(
        name: Step,
        ...args: ArgsType
    ): NextStep<Step> {
        return [name, args]
    }

    private async handleError(err: any, currentStepName: StepType, currentArgs: any) {
        const serializedArgs = currentArgs.map((arg: any) => this.serialize(arg))
        status.info('🔔', err)
        Sentry.captureException(err, { extra: { currentStepName, serializedArgs, originalEvent: this.originalEvent } })
        this.hub.statsd?.increment('kafka_queue.event_pipeline.step.error', { step: currentStepName })

        if (err instanceof DependencyUnavailableError) {
            // If this is an error with a dependency that we control, we want to
            // ensure that the caller knows that the event was not processed,
            // for a reason that we control and that is transient.
            throw err
        }

        if (STEPS_TO_EMIT_TO_DLQ_ON_FAILURE.includes(currentStepName)) {
            try {
                const message = generateEventDeadLetterQueueMessage(this.originalEvent, err)
                await this.hub.db.kafkaProducer!.queueMessage(message)
                this.hub.statsd?.increment('events_added_to_dead_letter_queue')
            } catch (dlqError) {
                status.info('🔔', `Errored trying to add event to dead letter queue. Error: ${dlqError}`)
                Sentry.captureException(dlqError, {
                    extra: { currentStepName, serializedArgs, originalEvent: this.originalEvent, err },
                })
            }
        }
    }

    private serialize(arg: any) {
        if (arg instanceof LazyPersonContainer) {
            // :KLUDGE: cloneObject fails with hub if we don't do this
            return { teamId: arg.teamId, distinctId: arg.distinctId, loaded: arg.loaded }
        }
        return arg
    }
}
