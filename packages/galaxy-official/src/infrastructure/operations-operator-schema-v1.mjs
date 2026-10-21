export const operationsOperatorV1MigrationSql = `
CREATE TABLE operations_operator_principals_v1 (
  operator_id text PRIMARY KEY, endpoint text NOT NULL, issuer text NOT NULL,
  external_subject text NOT NULL, display_name text NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(endpoint,issuer,external_subject)
);
CREATE TABLE operations_operator_logins_v1 (
  endpoint text NOT NULL, configuration_id text NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  preview jsonb NOT NULL, return_to text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exchanging','completed','revoked')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint, configuration_id, token_hash)
);
CREATE INDEX operations_operator_logins_expiry ON operations_operator_logins_v1(expires_at);
CREATE TABLE operations_operator_sessions_v1 (
  endpoint text NOT NULL, configuration_id text NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  operator_id text NOT NULL, issuer text NOT NULL, external_subject text NOT NULL,
  display_name text NOT NULL, role text NOT NULL CHECK (role IN ('administrator','reader')),
  csrf_token text NOT NULL CHECK (csrf_token ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint, configuration_id, token_hash)
);
CREATE INDEX operations_operator_sessions_expiry ON operations_operator_sessions_v1(expires_at);
CREATE INDEX operations_operator_sessions_principal ON operations_operator_sessions_v1(endpoint, issuer, external_subject);
`;
