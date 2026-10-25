export const operationsAgentOsV1MigrationSql=`
CREATE TABLE operations_agentos_executions_v1 (
 id uuid PRIMARY KEY,endpoint text NOT NULL,grant_id uuid NOT NULL REFERENCES operations_automation_grants_v1(id),
 grant_version integer NOT NULL,domain text NOT NULL CHECK(domain IN ('overview','governance','messaging','discovery','maintenance')),
 executor_kind text NOT NULL CHECK(executor_kind IN ('program','ai')),mode text NOT NULL CHECK(mode IN ('assisted','automatic')),
 operator_id text,created_by text NOT NULL,actions text[] NOT NULL,resource_ids uuid[] NOT NULL,
 state text NOT NULL CHECK(state IN ('active','paused','stopped')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 session_id uuid NOT NULL UNIQUE,prepared_command jsonb,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 CHECK((mode='assisted' AND operator_id IS NOT NULL) OR (mode='automatic' AND operator_id IS NULL))
);
CREATE INDEX operations_agentos_owner_v1 ON operations_agentos_executions_v1(endpoint,created_by,created_at DESC,id);
CREATE TABLE operations_agentos_source_refs_v1 (
 execution_id uuid NOT NULL REFERENCES operations_agentos_executions_v1(id),
 target_kind text NOT NULL CHECK(target_kind IN ('post','reply')),target_id uuid NOT NULL,source_version integer NOT NULL,
 PRIMARY KEY(execution_id,target_kind,target_id)
);
CREATE TABLE operations_agentos_commands_v1 (
 id uuid PRIMARY KEY,endpoint text NOT NULL,execution_id uuid NOT NULL REFERENCES operations_agentos_executions_v1(id),
 kind text NOT NULL CHECK(kind IN ('create','pause','resume','stop','run','review','continue','cancel')),operator_id text NOT NULL,
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(endpoint,id)
);
CREATE TABLE operations_agentos_tool_calls_v1 (
 id uuid PRIMARY KEY,endpoint text NOT NULL,execution_id uuid NOT NULL REFERENCES operations_agentos_executions_v1(id),
 run_id text NOT NULL,call_id text NOT NULL,tool text NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed','failed','unknown')),
 operation_id uuid NOT NULL UNIQUE,arguments jsonb NOT NULL,result jsonb,code text,
 created_at timestamptz NOT NULL,completed_at timestamptz,
 UNIQUE(endpoint,execution_id,run_id,call_id)
);
ALTER TABLE business_admin_audit_v1 ADD COLUMN actor_kind text NOT NULL DEFAULT 'business-operator'
 CHECK(actor_kind IN ('business-operator','operations-executor'));
ALTER TABLE business_admin_audit_v1 ADD COLUMN execution_id uuid REFERENCES operations_agentos_executions_v1(id);
ALTER TABLE business_admin_audit_v1 ADD COLUMN grant_id uuid REFERENCES operations_automation_grants_v1(id);
ALTER TABLE business_admin_audit_v1 ALTER COLUMN operator_role DROP NOT NULL;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_executor_source_v1 CHECK(
 (actor_kind='business-operator' AND operator_role IS NOT NULL AND operator_role IN ('reader','administrator') AND execution_id IS NULL AND grant_id IS NULL) OR
 (actor_kind='operations-executor' AND operator_role IS NULL AND execution_id IS NOT NULL AND grant_id IS NOT NULL)
);
`;
