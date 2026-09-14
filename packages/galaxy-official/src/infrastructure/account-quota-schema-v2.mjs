// CUR-35 / PWP-M13: append-only migration; no inferred verification for old links.
export const accountQuotaMigrationSql = `
CREATE TABLE community_accounts (
  id uuid PRIMARY KEY, endpoint text NOT NULL, issuer text NOT NULL, external_subject text NOT NULL,
  verification_method text NOT NULL CHECK(verification_method IN ('email','external-account')),
  verified_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
  tier_override text CHECK(tier_override IN ('new','normal')),
  restricted_until timestamptz, restriction_reason text,
  UNIQUE(endpoint,issuer,external_subject)
);
CREATE TABLE community_account_links (
  identity_link_id uuid PRIMARY KEY REFERENCES external_identity_links(id),
  account_id uuid NOT NULL REFERENCES community_accounts(id), subject_id text NOT NULL REFERENCES subjects(id),
  created_at timestamptz NOT NULL
);
CREATE INDEX community_account_subject ON community_account_links(subject_id,account_id);
DROP INDEX external_identity_active_account;
CREATE UNIQUE INDEX external_identity_active_account ON external_identity_links(endpoint,issuer,external_subject,subject_id)
  WHERE revoked_at IS NULL;
CREATE TABLE community_interactions (
  account_id uuid NOT NULL REFERENCES community_accounts(id), source_id uuid NOT NULL,
  source_kind text NOT NULL, counterparty_id text NOT NULL REFERENCES subjects(id),
  created_at timestamptz NOT NULL, invalidated_at timestamptz,
  PRIMARY KEY(account_id,source_id)
);
CREATE TABLE community_daily_usage (
  account_id uuid NOT NULL REFERENCES community_accounts(id), day date NOT NULL,
  category text NOT NULL CHECK(category IN ('task','comment','invitation')), used integer NOT NULL CHECK(used>=0),
  PRIMARY KEY(account_id,day,category)
);
CREATE TABLE community_write_receipts (
  account_id uuid NOT NULL REFERENCES community_accounts(id), operation_id uuid NOT NULL,
  category text NOT NULL CHECK(category IN ('task','comment','invitation')),
  subject_id text NOT NULL REFERENCES subjects(id), payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  task_id uuid, recipient_id text, created_at timestamptz NOT NULL, responded_at timestamptz,
  PRIMARY KEY(account_id,category,operation_id)
);
CREATE INDEX community_invitation_cooldown ON community_write_receipts(account_id,recipient_id,created_at)
  WHERE category='invitation' AND responded_at IS NULL;
`;
