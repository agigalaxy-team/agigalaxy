
CREATE TABLE operations_p13_strategy_versions_v1 (
 id uuid PRIMARY KEY,endpoint text NOT NULL,version integer NOT NULL CHECK(version>0),
 configuration jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL,
 parent_id uuid REFERENCES operations_p13_strategy_versions_v1(id),ordinary_strategy_id uuid,ordinary_execution_id uuid REFERENCES operations_agentos_executions_v1(id),
 UNIQUE(endpoint,version)
);
CREATE TABLE operations_p13_strategy_heads_v1 (
 endpoint text PRIMARY KEY,revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 active_id uuid REFERENCES operations_p13_strategy_versions_v1(id),draft_id uuid REFERENCES operations_p13_strategy_versions_v1(id),
 paused boolean NOT NULL DEFAULT true,blocked_version_ids uuid[] NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL
);
CREATE TABLE operations_p13_strategy_rehearsals_v1 (
 id uuid PRIMARY KEY,endpoint text NOT NULL,version_id uuid NOT NULL REFERENCES operations_p13_strategy_versions_v1(id),
 operator_id text NOT NULL,execution_ids uuid[] NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL
);
CREATE TABLE operations_p13_strategy_runs_v1 (
 id uuid PRIMARY KEY,endpoint text NOT NULL,version_id uuid NOT NULL REFERENCES operations_p13_strategy_versions_v1(id),strategy_id uuid NOT NULL,
 execution_id uuid NOT NULL REFERENCES operations_agentos_executions_v1(id),operator_id text NOT NULL,
 workflow_id text NOT NULL,workflow_version integer NOT NULL,session_id uuid NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN ('post','reply')),target_id uuid NOT NULL,source_version integer NOT NULL,decision_revision integer NOT NULL,
 rule_refs jsonb NOT NULL DEFAULT '[]',route text NOT NULL CHECK(route IN ('code','ai','human','blocked')),
 state text NOT NULL CHECK(state IN ('prepared','dispatching','running','awaiting-human','completed','blocked','unknown','no-action')),
 native_run_id text,approved_by text,approval_native_run_id text,decision text CHECK(decision IN ('proceed','human-required','needs-input','no-action')),
 effect_result jsonb,code text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,execution_id)
);
CREATE INDEX operations_p13_runs_latest_v1 ON operations_p13_strategy_runs_v1(endpoint,created_at DESC,id);
CREATE TABLE operations_p13_strategy_commands_v1 (
 endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL,kind text NOT NULL,
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,operation_id)
);
CREATE TABLE operations_p13_strategy_events_v1 (
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,version_id uuid,
 strategy_id uuid,run_id uuid,kind text NOT NULL,operator_id text,operation_id uuid,metadata jsonb NOT NULL,created_at timestamptz NOT NULL
);
DO $p13_strategies$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint
 WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'p13_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
  'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''strategies.configure'',''strategies.publish'',''strategies.control'',''strategies.run'',''strategies.ordinary.configure'',''strategies.ordinary.publish''))';
END $p13_strategies$;
