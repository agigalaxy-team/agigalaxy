-- A manual source retry may supersede cancelled recovery transport. Keep the
-- original transport state, payload/hash and result as historical facts.
ALTER TABLE galaxy_go_jobs.executions_v1 ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE galaxy_go_jobs.executions_v1 DROP CONSTRAINT IF EXISTS executions_v1_superseded_check;
ALTER TABLE galaxy_go_jobs.executions_v1 ADD CONSTRAINT executions_v1_superseded_check
 CHECK(superseded_at IS NULL OR (action='search-recovery' AND state='cancelled'));
