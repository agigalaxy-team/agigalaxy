CREATE SCHEMA IF NOT EXISTS galaxy_go_jobs;
CREATE SCHEMA IF NOT EXISTS galaxy_river;
REVOKE ALL ON SCHEMA galaxy_go_jobs,galaxy_river FROM PUBLIC;

-- No endpoint is activated by migration. The legacy Node worker does not read
-- this gate: stop its migrated consumers before explicitly selecting river.
CREATE TABLE IF NOT EXISTS galaxy_go_jobs.control_v1(
 endpoint text PRIMARY KEY,
 backend text NOT NULL DEFAULT 'disabled' CHECK(backend IN('disabled','river')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Public UUIDs, source/operation UUIDs and results survive River retention.
-- A River bigint is private transport identity, never a public operation ID.
CREATE TABLE IF NOT EXISTS galaxy_go_jobs.executions_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,action text NOT NULL,
 source_id uuid NOT NULL,operation_id uuid,request_hash text NOT NULL,
 river_id bigint NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','deferred','succeeded','failed')),
 result jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT(endpoint,action,source_id,operation_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA galaxy_go_jobs FROM PUBLIC;
ALTER TABLE galaxy_go_jobs.executions_v1 DROP CONSTRAINT IF EXISTS executions_v1_state_check;
ALTER TABLE galaxy_go_jobs.executions_v1 ADD CONSTRAINT executions_v1_state_check
 CHECK(state IN('queued','running','deferred','succeeded','failed','cancelled'));
