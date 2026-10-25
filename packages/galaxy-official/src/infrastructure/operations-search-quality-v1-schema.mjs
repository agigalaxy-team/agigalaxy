// Migration 108: search quality provenance, immutable versions and durable native tasks.
// No new index, preview engine, data retention duration or active exclusion policy.
export const operationsSearchQualityMigrationSql=`
CREATE TABLE operations_search_quality_state_v1(
 endpoint text PRIMARY KEY,revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 active_id uuid,draft_id uuid,pending_operation uuid,updated_at timestamptz NOT NULL
);
CREATE TABLE operations_search_quality_versions_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,version integer NOT NULL CHECK(version>=0),
 settings jsonb,native_settings jsonb NOT NULL,kind text NOT NULL CHECK(kind IN ('baseline','draft','restore')),
 restored_from uuid,operator_id text NOT NULL,created_at timestamptz NOT NULL,UNIQUE(endpoint,version)
);
CREATE TABLE operations_search_quality_operations_v1(
 sequence bigserial PRIMARY KEY,endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('draft','apply','restore')),request_hash text NOT NULL,input jsonb NOT NULL,
 version_id uuid NOT NULL,phase text NOT NULL CHECK(phase IN ('prepared','submitting','task-pending','applied','failed','result-unknown')),
 native_task_id bigint,native_watermark bigint,submitted_at timestamptz,error_code text,
 changes jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_search_quality_history_v1 ON operations_search_quality_operations_v1(endpoint,sequence DESC);
CREATE TABLE discovery_search_requests_v1(
 endpoint text NOT NULL,id uuid NOT NULL,profile_id text NOT NULL,query text NOT NULL,
 configuration_version integer,source_offset integer NOT NULL,result_state text NOT NULL CHECK(result_state IN ('has-results','no-results','scan-limited')),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,id)
);
CREATE INDEX discovery_search_profile_v1 ON discovery_search_requests_v1(endpoint,profile_id,created_at DESC);
`;
export const operationsSearchQualityApiGrantsSql=`
GRANT SELECT,INSERT ON operations_search_quality_state_v1,operations_search_quality_versions_v1,operations_search_quality_operations_v1,discovery_search_requests_v1 TO galaxy_api;
GRANT UPDATE(revision,active_id,draft_id,pending_operation,updated_at) ON operations_search_quality_state_v1 TO galaxy_api;
GRANT UPDATE(phase,native_task_id,submitted_at,error_code,updated_at) ON operations_search_quality_operations_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_search_quality_operations_v1_sequence_seq TO galaxy_api;
`;

