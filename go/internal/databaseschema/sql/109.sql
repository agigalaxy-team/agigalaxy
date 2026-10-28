
CREATE TABLE operations_maintenance_plans_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,revision integer NOT NULL CHECK(revision>0),
 point_id text NOT NULL CHECK(point_id ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('blocked','awaiting-approval','approved','preparing','restoring','validating','ready-to-open','opening','completed','failed','cancelled')),
 plan jsonb NOT NULL,plan_digest text NOT NULL CHECK(plan_digest ~ '^[a-f0-9]{64}$'),
 created_by text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 approved_by text,approved_at timestamptz,approved_revision integer,
 execution_id uuid,UNIQUE(endpoint,id)
);
CREATE INDEX operations_maintenance_plans_endpoint_v1 ON operations_maintenance_plans_v1(endpoint,created_at DESC,id);
CREATE TABLE operations_maintenance_events_v1(
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,
 operation_id uuid NOT NULL,operator_id text NOT NULL,operator_role text NOT NULL CHECK(operator_role IN ('reader','administrator')),action text NOT NULL
 CHECK(action IN ('backup-create','backup-verify','restore-plan','restore-approve','restore-execute','restore-cancel')),
 plan_id uuid REFERENCES operations_maintenance_plans_v1(id),revision integer,
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_maintenance_events_plan_v1 ON operations_maintenance_events_v1(endpoint,plan_id,sequence DESC);
DO $maintenance$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint
 WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'maintenance_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
  'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''maintenance-query'',''maintenance-logs-query'',''maintenance-backup-create'',''maintenance-backup-verify'',''maintenance-restore-plan'',''maintenance-restore-approve'',''maintenance-restore-execute'',''maintenance-restore-cancel''))';
END $maintenance$;
