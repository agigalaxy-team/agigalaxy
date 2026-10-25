import {operationsPermissionCatalogV2Codes} from './operations-permission-catalog-v2-schema.mjs';

export const registeredUsersPermissionCodes=Object.freeze(['accounts.registered.read','accounts.password.reset','accounts.login.disable','accounts.login.restore','accounts.sessions.revoke','accounts.profile.correct']);
const allowed='ARRAY['+[...operationsPermissionCatalogV2Codes,...registeredUsersPermissionCodes].map(code=>"'"+code+"'").join(',')+']::text[]';

// Derived website-realm directory and original command records. Neither table
// creates an authenticated account or changes identity/permission authority.
export const operationsRegisteredUsersV1MigrationSql=`
CREATE TABLE operations_registered_subjects_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,issuer text NOT NULL,external_subject text NOT NULL,
 UNIQUE(endpoint,issuer,external_subject));
CREATE TABLE operations_registered_generations_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,issuer text NOT NULL,state text NOT NULL CHECK(state IN ('building','complete','failed')),
 started_at timestamptz NOT NULL,completed_at timestamptz,source_count_before bigint,source_count_after bigint,
 observed_count bigint NOT NULL DEFAULT 0,code text);
CREATE TABLE operations_registered_entries_v1(
 generation_id uuid NOT NULL REFERENCES operations_registered_generations_v1(id) ON DELETE CASCADE,
 registration_id uuid NOT NULL REFERENCES operations_registered_subjects_v1(id),present boolean NOT NULL,
 email text,email_verified boolean,enabled boolean,registered_at timestamptz,identity_display_name text,observed_at timestamptz NOT NULL,
 PRIMARY KEY(generation_id,registration_id));
CREATE INDEX operations_registered_entries_order_v1 ON operations_registered_entries_v1(generation_id,registered_at,registration_id);
CREATE INDEX operations_registered_entries_email_v1 ON operations_registered_entries_v1(generation_id,lower(email));
CREATE TABLE operations_registered_directory_v1(
 endpoint text PRIMARY KEY,issuer text NOT NULL,generation_id uuid REFERENCES operations_registered_generations_v1(id),
 sync_id uuid,lease_until timestamptz,last_started_at timestamptz,last_completed_at timestamptz,last_error text);
CREATE TABLE operations_registered_commands_v1(
 sequence bigserial PRIMARY KEY,operation_id uuid NOT NULL UNIQUE,endpoint text NOT NULL,
 operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),registration_id uuid NOT NULL REFERENCES operations_registered_subjects_v1(id),
 kind text NOT NULL CHECK(kind IN ('password-reset','login-disable','login-restore','sessions-revoke','profile-correct')),
 state text NOT NULL CHECK(state IN ('accepted','submitted','completed','partial','failed','unknown')),
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE INDEX operations_registered_commands_target_v1 ON operations_registered_commands_v1(endpoint,registration_id,sequence DESC);
CREATE TABLE operations_registered_login_fences_v1(
 scope_hash text NOT NULL,issuer text NOT NULL,external_subject text NOT NULL,revoked_before timestamptz NOT NULL,
 PRIMARY KEY(scope_hash,issuer,external_subject));
ALTER TABLE official_account_logins_v1 ADD COLUMN started_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE operations_business_roles_v1 DROP CONSTRAINT operations_business_roles_v1_permissions_check,
 ADD CONSTRAINT operations_business_roles_v1_permissions_check CHECK(permissions<@${allowed});
ALTER TABLE operations_automation_grants_v1 DROP CONSTRAINT operations_automation_grants_v1_permissions_check,
 ADD CONSTRAINT operations_automation_grants_v1_permissions_check CHECK(permissions<@${allowed});
`;
