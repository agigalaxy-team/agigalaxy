ALTER TABLE operations_autonomy_tasks_v1 ADD COLUMN native_attempt_id uuid;
ALTER TABLE operations_autonomy_tool_calls_v1 ADD COLUMN native_run_id text;
ALTER TABLE operations_autonomy_tool_calls_v1 ADD COLUMN native_attempt_id uuid;
ALTER TABLE operations_autonomy_tasks_v1 ADD COLUMN control_revision bigint NOT NULL DEFAULT 1;
