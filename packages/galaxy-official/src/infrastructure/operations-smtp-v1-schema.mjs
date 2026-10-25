// Non-secret transport settings and safe test receipts only. Passwords and
// arbitrary environment keys never enter these tables.
export const operationsSmtpV1MigrationSql=`
CREATE TABLE operations_smtp_settings_v1(
 endpoint text PRIMARY KEY,version integer NOT NULL CHECK(version>0),configuration jsonb NOT NULL,
 updated_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),updated_at timestamptz NOT NULL
);
CREATE TABLE operations_smtp_commands_v1(
 endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,operation_id)
);
CREATE TABLE operations_smtp_events_v1(
 id uuid PRIMARY KEY,sequence bigserial UNIQUE,endpoint text NOT NULL,operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 version integer NOT NULL CHECK(version>0),changed_fields jsonb NOT NULL,created_at timestamptz NOT NULL
);
CREATE INDEX operations_smtp_events_endpoint_sequence ON operations_smtp_events_v1(endpoint,sequence DESC);
CREATE TABLE operations_smtp_tests_v1(
 id uuid PRIMARY KEY,sequence bigserial UNIQUE,endpoint text NOT NULL,operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 kind text NOT NULL CHECK(kind IN('connection','delivery')),configuration_version integer NOT NULL CHECK(configuration_version>0),
 account_id uuid REFERENCES community_accounts(id),sender_key text CHECK(sender_key IN('account','notice','community','updates','team')),
 input jsonb NOT NULL,state text NOT NULL CHECK(state IN('testing','connected','submitted','not-configured','ineligible','failed','unknown')),
 code text,started_at timestamptz NOT NULL,finished_at timestamptz
);
CREATE INDEX operations_smtp_tests_endpoint_sequence ON operations_smtp_tests_v1(endpoint,sequence DESC);
`;
