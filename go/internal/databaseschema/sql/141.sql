ALTER TABLE operations_autonomy_tasks_v1 ADD COLUMN control_state jsonb;
ALTER TABLE operations_autonomy_tasks_v1 ADD CONSTRAINT operations_autonomy_task_control_state_size_v1 CHECK (control_state IS NULL OR (jsonb_typeof(control_state)='object' AND octet_length(control_state::text)<=8192));
