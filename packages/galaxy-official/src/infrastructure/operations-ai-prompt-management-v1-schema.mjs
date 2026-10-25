import {operationsPermissionCodes} from '../operations-permission-catalog.mjs';

const allowed='ARRAY['+operationsPermissionCodes.map(code=>"'"+code+"'").join(',')+']::text[]';
// Existing roles, delegations, running tasks and enabled state are unchanged.
// Independent prompt rights and explicit new delegation actions start empty.
export const operationsAiPromptManagementMigrationSql=`
ALTER TABLE operations_business_roles_v1 DROP CONSTRAINT operations_business_roles_v1_permissions_check;
ALTER TABLE operations_business_roles_v1 ADD CONSTRAINT operations_business_roles_v1_permissions_check CHECK(permissions<@${allowed});
ALTER TABLE operations_automation_grants_v1 DROP CONSTRAINT operations_automation_grants_v1_permissions_check;
ALTER TABLE operations_automation_grants_v1 ADD CONSTRAINT operations_automation_grants_v1_permissions_check CHECK(permissions<@${allowed});
ALTER TABLE operations_ai_role_delegations_v1 DROP CONSTRAINT operations_ai_role_delegations_v1_grantable_permissions_check;
ALTER TABLE operations_ai_role_delegations_v1 ADD CONSTRAINT operations_ai_role_delegations_v1_grantable_permissions_check CHECK(grantable_permissions<@${allowed});
DO $ai_management_actions$ DECLARE previous text; BEGIN
 SELECT conname INTO STRICT previous FROM pg_constraint WHERE conrelid='operations_ai_role_delegations_v1'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%allowed_management_actions%';
 EXECUTE format('ALTER TABLE operations_ai_role_delegations_v1 DROP CONSTRAINT %I',previous);
END $ai_management_actions$;
ALTER TABLE operations_ai_role_delegations_v1 ADD CONSTRAINT operations_ai_management_actions_v2 CHECK(allowed_management_actions<@ARRAY['read','create','update','assign','revoke','prompt-read','prompt-update']::text[]);
ALTER TABLE operations_ai_role_delegation_events_v1 DROP CONSTRAINT operations_ai_role_delegation_events_v1_kind_check;
ALTER TABLE operations_ai_role_delegation_events_v1 ADD CONSTRAINT operations_ai_management_event_kind_v2 CHECK(kind IN ('config-save','role-create','role-update','assignment-save','prompt-save'));
ALTER TABLE operations_autonomy_configs_v1 ADD COLUMN updated_by_ai_account_id uuid REFERENCES operations_ai_work_accounts_v1(id);
ALTER TABLE operations_autonomy_configs_v1 ADD CONSTRAINT operations_ai_prompt_updater_v1 CHECK(updated_by_ai_account_id IS NULL OR updated_by IS NULL);
ALTER TABLE operations_autonomy_versions_v1 ADD COLUMN managed_by_ai_account_id uuid REFERENCES operations_ai_work_accounts_v1(id),
 ADD COLUMN management_operation_id uuid,ADD COLUMN management_delegation_id uuid REFERENCES operations_ai_role_delegations_v1(id),ADD COLUMN management_delegation_version integer;
ALTER TABLE operations_autonomy_versions_v1 ADD CONSTRAINT operations_ai_prompt_version_source_v1 CHECK(
 (management_operation_id IS NULL AND management_delegation_id IS NULL AND management_delegation_version IS NULL AND managed_by_ai_account_id IS NULL) OR
 (management_operation_id IS NOT NULL AND management_delegation_id IS NOT NULL AND management_delegation_version IS NOT NULL AND management_delegation_version>0 AND (managed_by_ai_account_id IS NOT NULL)<>(operator_id IS NOT NULL)));
DO $ai_prompt_audit$ DECLARE previous text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'ai_prompt_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
 'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''ai-prompt-read'',''ai-prompt-save''))';
END $ai_prompt_audit$;
DO $ai_management_tool$ DECLARE item record; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='operations_agentos_conversation_tool_calls_v1'::regclass AND contype='c' AND pg_get_constraintdef(oid) ~ '\\mtool\\M' LOOP
  EXECUTE format('ALTER TABLE operations_agentos_conversation_tool_calls_v1 DROP CONSTRAINT %I',item.conname);
 END LOOP;
END $ai_management_tool$;
ALTER TABLE operations_agentos_conversation_tool_calls_v1 ADD CONSTRAINT operations_conversation_tool_v2 CHECK(tool IN ('workbench-summary','query-operations','read-operation-object','list-authorized-work','run-authorized-work','prepare-operation','read-ai-delegation'));
`;
