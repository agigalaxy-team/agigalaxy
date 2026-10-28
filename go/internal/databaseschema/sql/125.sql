
CREATE TABLE account_follows_v1(
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
 target_account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
 following boolean NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL,
 followed_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 CHECK(account_id<>target_account_id),
 UNIQUE(account_id,target_account_id)
);
CREATE INDEX account_follows_owner_v1 ON account_follows_v1(account_id,following,followed_at DESC,id DESC);
CREATE TABLE account_follow_operations_v1(
 account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,operation_id)
);
