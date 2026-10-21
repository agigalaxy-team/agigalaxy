export const officialAccountSessionsV1MigrationSql = `
CREATE TABLE oidc_login_transactions_v1 (
  namespace text NOT NULL CHECK(length(namespace) BETWEEN 1 AND 256),
  provider_key text NOT NULL CHECK(provider_key ~ '^[a-f0-9]{64}$'),
  login_id uuid NOT NULL,
  verifier text NOT NULL CHECK(length(verifier) BETWEEN 43 AND 128),
  state text NOT NULL CHECK(length(state) BETWEEN 1 AND 512),
  nonce text NOT NULL CHECK(length(nonce) BETWEEN 1 AND 512),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK(expires_at > created_at AND expires_at <= created_at + 600),
  PRIMARY KEY(namespace,provider_key,login_id)
);
CREATE INDEX oidc_login_transactions_expiry_v1 ON oidc_login_transactions_v1(namespace,expires_at);

CREATE TABLE official_account_logins_v1 (
  scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
  login_hash text NOT NULL CHECK(login_hash ~ '^[a-f0-9]{64}$'),
  state_hash text NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  preview jsonb NOT NULL CHECK(jsonb_typeof(preview)='object' AND octet_length(preview::text)<=16384),
  return_to text NOT NULL CHECK(length(return_to) BETWEEN 1 AND 4096),
  status text NOT NULL CHECK(status IN ('pending','exchanging','completed','revoked')),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK(expires_at > created_at AND expires_at <= created_at + 600),
  PRIMARY KEY(scope_hash,login_hash)
);
CREATE INDEX official_account_logins_expiry_v1 ON official_account_logins_v1(scope_hash,expires_at);

CREATE TABLE official_account_sessions_v1 (
  scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
  token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  login_hash text NOT NULL CHECK(login_hash ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
  external_subject text NOT NULL CHECK(length(external_subject) BETWEEN 1 AND 256),
  email text CHECK(length(email)<=320),
  email_verified boolean NOT NULL,
  csrf_token text NOT NULL CHECK(csrf_token ~ '^[A-Za-z0-9_-]{43}$'),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK(expires_at > created_at AND expires_at <= created_at + 86400),
  revoked_at bigint,
  PRIMARY KEY(scope_hash,token_hash)
);
CREATE INDEX official_account_sessions_account_v1 ON official_account_sessions_v1(scope_hash,account_id);
CREATE INDEX official_account_sessions_expiry_v1 ON official_account_sessions_v1(scope_hash,expires_at);
CREATE INDEX official_account_sessions_login_v1 ON official_account_sessions_v1(scope_hash,login_hash);
`;
