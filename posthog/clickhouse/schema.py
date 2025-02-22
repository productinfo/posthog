# This file contains all CREATE TABLE queries, used to sync and test schema
import re

from posthog.clickhouse.dead_letter_queue import *
from posthog.clickhouse.plugin_log_entries import *
from posthog.models.app_metrics.sql import *
from posthog.models.cohort.sql import *
from posthog.models.event.sql import *
from posthog.models.group.sql import *
from posthog.models.ingestion_warnings.sql import (
    DISTRIBUTED_INGESTION_WARNINGS_TABLE_SQL,
    INGESTION_WARNINGS_DATA_TABLE_SQL,
    INGESTION_WARNINGS_MV_TABLE_SQL,
    KAFKA_INGESTION_WARNINGS_TABLE_SQL,
)
from posthog.models.performance.sql import (
    DISTRIBUTED_PERFORMANCE_EVENTS_TABLE_SQL,
    KAFKA_PERFORMANCE_EVENTS_TABLE_SQL,
    PERFORMANCE_EVENTS_TABLE_MV_SQL,
    PERFORMANCE_EVENTS_TABLE_SQL,
    WRITABLE_PERFORMANCE_EVENTS_TABLE_SQL,
)
from posthog.models.person.sql import *
from posthog.models.session_recording_event.sql import *

CREATE_MERGETREE_TABLE_QUERIES = (
    CREATE_COHORTPEOPLE_TABLE_SQL,
    PERSON_STATIC_COHORT_TABLE_SQL,
    DEAD_LETTER_QUEUE_TABLE_SQL,
    EVENTS_TABLE_SQL,
    GROUPS_TABLE_SQL,
    PERSONS_TABLE_SQL,
    PERSONS_DISTINCT_ID_TABLE_SQL,
    PERSON_DISTINCT_ID2_TABLE_SQL,
    PLUGIN_LOG_ENTRIES_TABLE_SQL,
    SESSION_RECORDING_EVENTS_TABLE_SQL,
    INGESTION_WARNINGS_DATA_TABLE_SQL,
    APP_METRICS_DATA_TABLE_SQL,
    PERFORMANCE_EVENTS_TABLE_SQL,
)
CREATE_DISTRIBUTED_TABLE_QUERIES = (
    WRITABLE_EVENTS_TABLE_SQL,
    DISTRIBUTED_EVENTS_TABLE_SQL,
    WRITABLE_SESSION_RECORDING_EVENTS_TABLE_SQL,
    DISTRIBUTED_SESSION_RECORDING_EVENTS_TABLE_SQL,
    DISTRIBUTED_INGESTION_WARNINGS_TABLE_SQL,
    DISTRIBUTED_APP_METRICS_TABLE_SQL,
    WRITABLE_PERFORMANCE_EVENTS_TABLE_SQL,
    DISTRIBUTED_PERFORMANCE_EVENTS_TABLE_SQL,
)
CREATE_KAFKA_TABLE_QUERIES = (
    KAFKA_DEAD_LETTER_QUEUE_TABLE_SQL,
    KAFKA_EVENTS_TABLE_JSON_SQL,
    KAFKA_GROUPS_TABLE_SQL,
    KAFKA_PERSONS_TABLE_SQL,
    KAFKA_PERSONS_DISTINCT_ID_TABLE_SQL,
    KAFKA_PERSON_DISTINCT_ID2_TABLE_SQL,
    KAFKA_PLUGIN_LOG_ENTRIES_TABLE_SQL,
    KAFKA_SESSION_RECORDING_EVENTS_TABLE_SQL,
    KAFKA_INGESTION_WARNINGS_TABLE_SQL,
    KAFKA_APP_METRICS_TABLE_SQL,
    KAFKA_PERFORMANCE_EVENTS_TABLE_SQL,
)
CREATE_MV_TABLE_QUERIES = (
    DEAD_LETTER_QUEUE_TABLE_MV_SQL,
    EVENTS_TABLE_JSON_MV_SQL,
    GROUPS_TABLE_MV_SQL,
    PERSONS_TABLE_MV_SQL,
    PERSONS_DISTINCT_ID_TABLE_MV_SQL,
    PERSON_DISTINCT_ID2_MV_SQL,
    PLUGIN_LOG_ENTRIES_TABLE_MV_SQL,
    SESSION_RECORDING_EVENTS_TABLE_MV_SQL,
    INGESTION_WARNINGS_MV_TABLE_SQL,
    APP_METRICS_MV_TABLE_SQL,
    PERFORMANCE_EVENTS_TABLE_MV_SQL,
)

CREATE_TABLE_QUERIES = (
    CREATE_MERGETREE_TABLE_QUERIES
    + CREATE_DISTRIBUTED_TABLE_QUERIES
    + CREATE_KAFKA_TABLE_QUERIES
    + CREATE_MV_TABLE_QUERIES
)

build_query = lambda query: query if isinstance(query, str) else query()
get_table_name = lambda query: re.findall(r" ([a-z0-9_]+) ON CLUSTER", build_query(query))[0]
