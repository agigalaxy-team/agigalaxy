import {operationsPermissionCodes} from '../operations-permission-catalog.mjs';
const allowed="ARRAY["+operationsPermissionCodes.map(code=>"'"+code+"'").join(',')+"]::text[]";
export const operationsPermissionsV1MigrationSql=`
CREATE TABLE operations_permission_authority_v1(endpoint text PRIMARY KEY,version bigint NOT NULL DEFAULT 0 CHECK(version>=0));
CREATE TABLE operations_business_roles_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),description text NOT NULL DEFAULT '',
 enabled boolean NOT NULL,version integer NOT NULL CHECK(version>0),permissions text[] NOT NULL CHECK(permissions<@${allowed}),
 created_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),updated_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(endpoint,name));
CREATE INDEX operations_business_roles_endpoint_v1 ON operations_business_roles_v1(endpoint,id);
CREATE TABLE operations_role_assignments_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 role_id uuid NOT NULL REFERENCES operations_business_roles_v1(id),enabled boolean NOT NULL,version integer NOT NULL CHECK(version>0),
 created_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),updated_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(endpoint,operator_id,role_id));
CREATE INDEX operations_role_assignments_operator_v1 ON operations_role_assignments_v1(endpoint,operator_id);
CREATE TABLE operations_automation_grants_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,name text NOT NULL,executor_kind text NOT NULL CHECK(executor_kind IN ('program','ai')),
 mode text NOT NULL CHECK(mode IN ('assisted','automatic')),enabled boolean NOT NULL,version integer NOT NULL CHECK(version>0),
 permissions text[] NOT NULL CHECK(permissions<@${allowed}),resource_ids uuid[] NOT NULL DEFAULT '{}',
 created_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),updated_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE operations_permission_events_v1(
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,
 operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),kind text NOT NULL CHECK(kind IN ('role-save','assignment-save','automation-save')),
 resource_id uuid NOT NULL,version integer NOT NULL,changed_fields text[] NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(endpoint,id));
CREATE INDEX operations_permission_events_endpoint_v1 ON operations_permission_events_v1(endpoint,sequence DESC);
`;
