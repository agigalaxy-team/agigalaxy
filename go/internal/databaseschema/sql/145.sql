CREATE TABLE operations_autonomy_dispatches_v1 (
 id uuid PRIMARY KEY,
 endpoint text NOT NULL,
 operator_id text NOT NULL,
 domain text NOT NULL CHECK (domain IN ('overview','governance','messaging','discovery','maintenance')),
 ai_account_id uuid NOT NULL REFERENCES operations_ai_work_accounts_v1(id),
 revision bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT true,
 title text NOT NULL,
 configuration jsonb NOT NULL,
 next_due_at timestamptz,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,id)
);
CREATE INDEX operations_autonomy_dispatches_due_v1 ON operations_autonomy_dispatches_v1(endpoint,next_due_at) WHERE enabled;
CREATE INDEX operations_autonomy_dispatched_tasks_v1 ON operations_autonomy_tasks_v1(endpoint,(configuration->'dispatch'->>'id'),created_at DESC) WHERE configuration ? 'dispatch';

DO $dispatch_audit$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'dispatch_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
 'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''autonomy-dispatch'',''autonomy-dispatch-control''))';
END $dispatch_audit$;
