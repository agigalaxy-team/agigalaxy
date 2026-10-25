// Released admin41 fixed108 plus AI123's four explicit human management codes.
// No held120 dependency, account initialization, role seed or legacy rebinding.
export const aiWorkAccountsPermissionCodes=Object.freeze([
 "ai.accounts.read",
 "ai.accounts.profile.write",
 "ai.accounts.state.write",
 "ai.accounts.roles.write"
]);
export const aiWorkAccountsCatalogCodes=Object.freeze([
 "workbench.read",
 "accounts.read",
 "accounts.identity.read",
 "accounts.type.change",
 "accounts.restriction.apply",
 "accounts.restriction.release",
 "analytics.read",
 "sections.read",
 "sections.classify",
 "sections.hide",
 "sections.restore",
 "content.read",
 "content.hide",
 "content.restore",
 "content.curate",
 "content.batch.hide",
 "content.batch.restore",
 "content.tags.read",
 "content.tags.manage",
 "recommendations.read",
 "recommendations.configure",
 "cases.read",
 "cases.resolve",
 "chat-reports.read",
 "chat-reports.materials.read",
 "chat-reports.attachments.read",
 "chat-reports.moderate",
 "chat-messages.hide",
 "chat-messages.restore",
 "chat-messages.keep",
 "resources.read",
 "resources.hide",
 "resources.restore",
 "files.read",
 "files.scan.retry",
 "files.access.stop",
 "files.access.restore",
 "files.cleanup.plan",
 "files.cleanup.approve",
 "feedback.read",
 "feedback.attachments.read",
 "feedback.update",
 "notices.read",
 "notices.create",
 "notices.update",
 "notices.publish",
 "notices.withdraw",
 "smtp.read",
 "smtp.configure",
 "smtp.test.connection",
 "smtp.test.delivery",
 "rules.read",
 "rules.write",
 "strategies.read",
 "strategies.configure",
 "strategies.publish",
 "strategies.run",
 "strategies.control",
 "strategies.ordinary.configure",
 "strategies.ordinary.publish",
 "audit.read",
 "jobs.read",
 "jobs.cancel",
 "jobs.retry",
 "search.read",
 "search.retry",
 "search-quality.read",
 "search-quality.configure",
 "search-quality.publish",
 "search-quality.restore",
 "maintenance.read",
 "maintenance.logs.read",
 "maintenance.backups.create",
 "maintenance.backups.verify",
 "maintenance.restore.plan",
 "maintenance.restore.approve",
 "maintenance.restore.execute",
 "models.read",
 "models.configure",
 "models.apply",
 "retention.read",
 "retention.request",
 "cms.read",
 "cms.edit",
 "cms.publish",
 "permissions.read",
 "permissions.roles.write",
 "permissions.assignments.write",
 "permissions.automation.write",
 "accounts.registered.read",
 "accounts.password.reset",
 "accounts.login.disable",
 "accounts.login.restore",
 "accounts.sessions.revoke",
 "accounts.profile.correct",
 "management.accounts.read",
 "management.accounts.create",
 "management.accounts.profile.write",
 "management.accounts.login.disable",
 "management.accounts.login.restore",
 "management.accounts.password.reset",
 "management.accounts.sessions.revoke",
 "management.accounts.delete",
 "ai.use.overview",
 "ai.use.governance",
 "ai.use.messaging",
 "ai.use.discovery",
 "ai.use.maintenance",
 "ai.accounts.read",
 "ai.accounts.profile.write",
 "ai.accounts.state.write",
 "ai.accounts.roles.write"
]);
const allowed="ARRAY["+aiWorkAccountsCatalogCodes.map(code=>"'"+code+"'").join(',')+"]::text[]";
export const operationsAiWorkAccountsV1MigrationSql=`
CREATE TABLE operations_ai_work_accounts_v1(
 id uuid PRIMARY KEY, endpoint text NOT NULL,
 domain text NOT NULL CHECK(domain IN ('overview','governance','messaging','discovery','maintenance')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 description text NOT NULL CHECK(length(description)<=1000),
 enabled boolean NOT NULL,
 version integer NOT NULL CHECK(version>0),
 authorization_version integer NOT NULL CHECK(authorization_version>0),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,domain),UNIQUE(endpoint,id)
);
CREATE TABLE operations_ai_work_assignments_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,ai_account_id uuid NOT NULL,
 role_id uuid NOT NULL REFERENCES operations_business_roles_v1(id),
 enabled boolean NOT NULL,version integer NOT NULL CHECK(version>0),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 FOREIGN KEY(endpoint,ai_account_id) REFERENCES operations_ai_work_accounts_v1(endpoint,id),
 UNIQUE(endpoint,ai_account_id,role_id)
);
CREATE TABLE operations_ai_work_commands_v1(
 sequence bigserial PRIMARY KEY,endpoint text NOT NULL,operation_id uuid NOT NULL,
 ai_account_id uuid NOT NULL,domain text NOT NULL CHECK(domain IN ('overview','governance','messaging','discovery','maintenance')),
 operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 kind text NOT NULL CHECK(kind IN ('profile-save','state-save','assignment-save')),
 selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='object'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 reason text NOT NULL CHECK(length(reason)<=1000),created_at timestamptz NOT NULL,
 FOREIGN KEY(endpoint,ai_account_id) REFERENCES operations_ai_work_accounts_v1(endpoint,id),
 UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_ai_work_commands_history_v1 ON operations_ai_work_commands_v1(endpoint,domain,sequence DESC);
ALTER TABLE operations_automation_grants_v1 ADD COLUMN ai_account_id uuid;
ALTER TABLE operations_automation_grants_v1 ADD CONSTRAINT operations_automation_ai_account_v1
 FOREIGN KEY(endpoint,ai_account_id) REFERENCES operations_ai_work_accounts_v1(endpoint,id);
ALTER TABLE operations_automation_grants_v1 ADD CONSTRAINT operations_automation_ai_kind_v1
 CHECK(ai_account_id IS NULL OR executor_kind='ai');

ALTER TABLE operations_agentos_conversations_v1 ADD COLUMN ai_account_id uuid;
ALTER TABLE operations_agentos_conversations_v1 ADD CONSTRAINT operations_conversation_ai_account_v1
 FOREIGN KEY(endpoint,ai_account_id) REFERENCES operations_ai_work_accounts_v1(endpoint,id);
ALTER TABLE operations_agentos_executions_v1 ADD COLUMN ai_account_id uuid;
ALTER TABLE operations_agentos_executions_v1 ADD CONSTRAINT operations_execution_ai_account_v1
 FOREIGN KEY(endpoint,ai_account_id) REFERENCES operations_ai_work_accounts_v1(endpoint,id);
ALTER TABLE operations_agentos_executions_v1 ADD CONSTRAINT operations_execution_ai_kind_v1
 CHECK(ai_account_id IS NULL OR executor_kind='ai');
ALTER TABLE operations_business_roles_v1 DROP CONSTRAINT operations_business_roles_v1_permissions_check;
ALTER TABLE operations_business_roles_v1 ADD CONSTRAINT operations_business_roles_v1_permissions_check CHECK(permissions<@${allowed});
ALTER TABLE operations_automation_grants_v1 DROP CONSTRAINT operations_automation_grants_v1_permissions_check;
ALTER TABLE operations_automation_grants_v1 ADD CONSTRAINT operations_automation_grants_v1_permissions_check CHECK(permissions<@${allowed});
`;
