// Account-private source locators. Content remains with the source service.
export const accountReadingBookmarksV2MigrationSql = `
CREATE TABLE account_reading_bookmarks_v2(
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
 origin_subject_id text,
 reference_key text NOT NULL,
 reference jsonb NOT NULL,
 saved boolean NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL,
 saved_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(account_id,reference_key)
);
CREATE INDEX account_reading_bookmarks_owner_v2 ON account_reading_bookmarks_v2(account_id,saved,saved_at DESC,id DESC);
CREATE TABLE account_reading_bookmark_operations_v2(
 account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 origin_subject_id text,
 authorization_kind text NOT NULL CHECK(authorization_kind IN ('official-account','identity')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,operation_id)
);
`;
