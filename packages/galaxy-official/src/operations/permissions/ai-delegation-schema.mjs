import {z} from 'zod';
import {operationsPermissionCodes} from '../../operations-permission-catalog.mjs';
import {operationsPermissionListSchema} from '../../shared/operations-permissions-schema.mjs';

export const aiRoleManagementActions=Object.freeze(['read','create','update','assign','revoke','prompt-read','prompt-update']);
const ids=z.array(z.uuid()).max(4).refine(items=>new Set(items).size===items.length);
export const aiRoleDelegationSaveSchema=z.strictObject({operationId:z.uuid(),expectedVersion:z.number().int().nonnegative(),enabled:z.boolean(),
 targetAiAccountIds:ids,grantablePermissions:operationsPermissionListSchema,
 allowedManagementActions:z.array(z.enum(aiRoleManagementActions)).max(7).refine(items=>new Set(items).size===items.length)});
const roleFields={operationId:z.uuid(),expectedVersion:z.number().int().nonnegative(),name:z.string().trim().min(1).max(120).refine(value=>!/[\p{Cc}]/u.test(value)),description:z.string().trim().max(1000),enabled:z.boolean(),permissions:operationsPermissionListSchema};
export const delegatedAiRoleCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('role-create'),...roleFields,targetAiAccountIds:ids.refine(items=>items.length>0)}),
 z.strictObject({kind:z.literal('role-update'),...roleFields,id:z.uuid(),targetAiAccountIds:ids.refine(items=>items.length>0)}),
 z.strictObject({kind:z.literal('assignment-save'),operationId:z.uuid(),expectedVersion:z.number().int().nonnegative(),id:z.uuid().optional(),aiAccountId:z.uuid(),roleId:z.uuid(),enabled:z.boolean()}),
]);
export const delegatedAiRolePreparationSchema=z.discriminatedUnion('kind',delegatedAiRoleCommandSchema.options.map(schema=>schema.omit({operationId:true})));
export const delegatedAiPromptReadSchema=z.strictObject({aiAccountId:z.uuid()});
export const delegatedAiPromptSaveSchema=z.strictObject({operationId:z.uuid(),aiAccountId:z.uuid(),expectedRevision:z.number().int().positive(),expectedPromptVersion:z.number().int().positive(),prompt:z.string().max(16000)});
export const delegatedAiManagementReadSchema=z.strictObject({aiAccountId:z.uuid().optional()});
// Migration129 is already deployed. New prompt permissions are introduced by
// the additive131 migration, never by changing the historical129 SQL.
const allowed='ARRAY['+operationsPermissionCodes.filter(code=>!code.startsWith('ai.prompts.')).map(code=>"'"+code+"'").join(',')+']::text[]';
export const operationsAiDelegationMigrationSql=`
ALTER TABLE operations_business_roles_v1 ADD COLUMN subject_scope text NOT NULL DEFAULT 'shared' CHECK(subject_scope IN ('shared','ai-only'));
ALTER TABLE operations_business_roles_v1 ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE operations_business_roles_v1 ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE operations_business_roles_v1 ADD COLUMN created_by_ai_account_id uuid REFERENCES operations_ai_work_accounts_v1(id);
ALTER TABLE operations_business_roles_v1 ADD COLUMN updated_by_ai_account_id uuid REFERENCES operations_ai_work_accounts_v1(id);
ALTER TABLE operations_business_roles_v1 ADD COLUMN managed_ai_account_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE operations_business_roles_v1 ADD CONSTRAINT operations_ai_role_creator_v1 CHECK((created_by IS NOT NULL)<>(created_by_ai_account_id IS NOT NULL));
ALTER TABLE operations_business_roles_v1 ADD CONSTRAINT operations_ai_role_updater_v1 CHECK((updated_by IS NOT NULL)<>(updated_by_ai_account_id IS NOT NULL));
CREATE TABLE operations_ai_role_delegations_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,source_ai_account_id uuid NOT NULL REFERENCES operations_ai_work_accounts_v1(id),
 version integer NOT NULL CHECK(version>0),enabled boolean NOT NULL,target_ai_account_ids uuid[] NOT NULL,
 grantable_permissions text[] NOT NULL CHECK(grantable_permissions<@${allowed}),allowed_management_actions text[] NOT NULL CHECK(allowed_management_actions<@ARRAY['read','create','update','assign','revoke']::text[]),
 created_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),updated_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(endpoint,source_ai_account_id)
);
CREATE TABLE operations_ai_role_delegation_events_v1(
 sequence bigserial PRIMARY KEY,endpoint text NOT NULL,operation_id uuid NOT NULL,delegation_id uuid NOT NULL REFERENCES operations_ai_role_delegations_v1(id),
 version integer NOT NULL,actor_kind text NOT NULL CHECK(actor_kind IN ('business-operator','operations-ai-service')),actor_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('config-save','role-create','role-update','assignment-save')),selection jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_ai_role_delegation_events_history_v1 ON operations_ai_role_delegation_events_v1(endpoint,delegation_id,sequence DESC);
CREATE TABLE operations_ai_duty_operations_v1(
 operation_id uuid NOT NULL,endpoint text NOT NULL,task_id uuid NOT NULL,ai_account_id uuid NOT NULL REFERENCES operations_ai_work_accounts_v1(id),
 kind text NOT NULL,request jsonb NOT NULL,proposal jsonb NOT NULL,binding jsonb NOT NULL,state text NOT NULL CHECK(state IN ('prepared','dispatching','completed','failed','unknown')),
 result jsonb,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(endpoint,operation_id)
);
ALTER TABLE forum_section_events_v2 DROP CONSTRAINT forum_section_events_v2_actor_kind_check;
ALTER TABLE forum_section_events_v2 ADD CONSTRAINT forum_section_events_v2_actor_kind_check CHECK(actor_kind IN ('identity','official-account','business-operator','operations-ai-service'));
ALTER TABLE forum_operations_events_v1 ADD COLUMN actor_kind text NOT NULL DEFAULT 'business-operator' CHECK(actor_kind IN ('business-operator','operations-ai-service'));
DO $ai_case_actor$ DECLARE item record; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='account_chat_governance_events_v1'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%actor_kind%' LOOP
  EXECUTE format('ALTER TABLE account_chat_governance_events_v1 DROP CONSTRAINT %I',item.conname);
 END LOOP;
END $ai_case_actor$;
ALTER TABLE account_chat_governance_events_v1 ADD CONSTRAINT account_chat_event_actor_kind_v2 CHECK(actor_kind IN ('official-account','business-operator','operations-ai-service'));
ALTER TABLE account_chat_governance_events_v1 ADD CONSTRAINT account_chat_event_actor_identity_v2 CHECK(
 (actor_kind='official-account' AND account_id IS NOT NULL AND operator_id IS NULL) OR
 (actor_kind IN ('business-operator','operations-ai-service') AND account_id IS NULL AND operator_id IS NOT NULL));
ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_actor_kind_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_actor_kind_check CHECK(actor_kind IN ('business-operator','operations-executor','operations-ai-service'));
ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_executor_source_v1;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_executor_source_v1 CHECK(
 (actor_kind='business-operator' AND operator_role IS NOT NULL AND operator_role IN ('reader','administrator') AND execution_id IS NULL AND grant_id IS NULL) OR
 (actor_kind='operations-executor' AND operator_role IS NULL AND execution_id IS NOT NULL AND grant_id IS NOT NULL) OR
 (actor_kind='operations-ai-service' AND operator_role IS NULL AND execution_id IS NULL AND operator_id LIKE 'ai:%')
);
ALTER TABLE operations_business_roles_v1 DROP CONSTRAINT operations_business_roles_v1_permissions_check;
ALTER TABLE operations_business_roles_v1 ADD CONSTRAINT operations_business_roles_v1_permissions_check CHECK(permissions<@${allowed});
ALTER TABLE operations_automation_grants_v1 DROP CONSTRAINT operations_automation_grants_v1_permissions_check;
ALTER TABLE operations_automation_grants_v1 ADD CONSTRAINT operations_automation_grants_v1_permissions_check CHECK(permissions<@${allowed});
`;
export const operationsAiDelegationApiRoleSql=`
GRANT SELECT,INSERT,UPDATE ON operations_ai_role_delegations_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_ai_role_delegation_events_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_ai_role_delegation_events_v1_sequence_seq TO galaxy_api;
GRANT SELECT,INSERT,UPDATE ON operations_ai_duty_operations_v1 TO galaxy_api;
GRANT UPDATE(subject_scope,created_by_ai_account_id,updated_by_ai_account_id,managed_ai_account_ids) ON operations_business_roles_v1 TO galaxy_api;
`;
