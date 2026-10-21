export const businessAdminV1MigrationSql=`
ALTER TABLE community_accounts ADD COLUMN restriction_revision integer NOT NULL DEFAULT 0 CHECK(restriction_revision>=0);
ALTER TABLE official_account_type_history_v1 ADD COLUMN actor_kind text NOT NULL DEFAULT 'account-owner'
 CHECK(actor_kind IN ('account-owner','business-operator'));
ALTER TABLE official_account_type_history_v1 ADD COLUMN operator_id text;
ALTER TABLE official_account_type_history_v1 ADD CONSTRAINT account_type_actor_v1 CHECK(
 (actor_kind='account-owner' AND operator_id IS NULL) OR (actor_kind='business-operator' AND operator_id IS NOT NULL));
CREATE TABLE business_admin_audit_v1 (
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,
 operator_id text NOT NULL,operator_role text NOT NULL CHECK(operator_role IN ('administrator','reader')),
 action text NOT NULL CHECK(action IN ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change')),
 account_id uuid,operation_id uuid,http_request_id uuid,
 selection jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(endpoint,operation_id)
);
CREATE INDEX business_admin_account_audit_v1 ON business_admin_audit_v1(endpoint,account_id,sequence DESC);
CREATE INDEX business_admin_operator_audit_v1 ON business_admin_audit_v1(endpoint,operator_id,sequence DESC);
`;
