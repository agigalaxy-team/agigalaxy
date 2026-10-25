// Migration110: human-managed model versions and nonsecret command ledger.
// Keys, key hashes, provider responses and prompts never enter these tables.
export const operationsModelSettingsMigrationSql=`
CREATE TABLE operations_model_settings_state_v1(
 endpoint text PRIMARY KEY,revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 active_id uuid,draft_id uuid,pending_operation uuid,updated_at timestamptz NOT NULL
);
CREATE TABLE operations_model_settings_versions_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,version integer NOT NULL CHECK(version>0),
 configuration jsonb NOT NULL,operator_id text NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(endpoint,version)
);
CREATE TABLE operations_model_settings_operations_v1(
 sequence bigserial PRIMARY KEY,endpoint text NOT NULL,operation_id uuid NOT NULL,
 operator_id text NOT NULL,operator_role text NOT NULL CHECK(operator_role IN ('administrator','reader')),
 kind text NOT NULL CHECK(kind IN ('draft','apply','credential-provision')),
 request_hash text NOT NULL,input jsonb NOT NULL,version_id uuid,
 phase text NOT NULL CHECK(phase IN ('prepared','submitting','pending','applied','failed','result-unknown')),
 error_code text,credential_ref text,changes jsonb NOT NULL,reason text,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_model_settings_history_v1 ON operations_model_settings_operations_v1(endpoint,sequence DESC);
DO $model_settings$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint
 WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'model_settings_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
  'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''models.configure'',''models.apply''))';
END $model_settings$;
`;
export const operationsModelSettingsApiGrantsSql=`
GRANT SELECT,INSERT ON operations_model_settings_state_v1,operations_model_settings_versions_v1,operations_model_settings_operations_v1 TO galaxy_api;
GRANT UPDATE(revision,active_id,draft_id,pending_operation,updated_at) ON operations_model_settings_state_v1 TO galaxy_api;
GRANT UPDATE(phase,error_code,credential_ref,updated_at) ON operations_model_settings_operations_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_model_settings_operations_v1_sequence_seq TO galaxy_api;
`;

