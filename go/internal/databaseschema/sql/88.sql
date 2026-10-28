
CREATE TABLE account_external_credentials_v1 (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES community_accounts(id),
 issuer_id text NOT NULL,issuer_uri text NOT NULL,issuer_name text NOT NULL,
 credential_jws text,metadata jsonb NOT NULL,revocation jsonb NOT NULL,
 imported_at timestamptz NOT NULL,checked_at timestamptz NOT NULL,withdrawn_at timestamptz
);
CREATE INDEX account_external_credentials_owner_v1 ON account_external_credentials_v1(account_id,imported_at DESC,id DESC);
CREATE INDEX account_external_credentials_issuer_v1 ON account_external_credentials_v1(account_id,issuer_id) WHERE withdrawn_at IS NULL;
