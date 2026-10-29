ALTER TABLE operations_autonomy_tool_calls_v1 ADD COLUMN read_outcome jsonb;
ALTER TABLE operations_autonomy_tool_calls_v1 ADD CONSTRAINT operations_autonomy_read_outcome_v1 CHECK(read_outcome IS NULL OR (jsonb_typeof(read_outcome)='object' AND octet_length(read_outcome::text)<=8192));
