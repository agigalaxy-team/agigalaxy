ALTER TABLE operations_autonomy_tasks_v1 ADD COLUMN result jsonb;
ALTER TABLE operations_autonomy_tasks_v1 ADD CONSTRAINT operations_autonomy_task_result_size_v1 CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=16384));
