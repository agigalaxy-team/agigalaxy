export const officialAccountDataV1MigrationSql = `
CREATE TABLE official_account_profiles_v1 (
 account_id uuid PRIMARY KEY REFERENCES community_accounts(id),
 subject_type text CHECK(subject_type IN ('person','organization','agent')),
 display_name text, revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 query_enabled boolean NOT NULL DEFAULT false,
 query_scope text NOT NULL DEFAULT 'profile' CHECK(query_scope IN ('profile','profile-and-public-posts')),
 archive_retention_days integer CHECK(archive_retention_days BETWEEN 1 AND 36500),
 updated_at timestamptz NOT NULL
);
CREATE TABLE official_account_type_history_v1 (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES community_accounts(id),
 revision integer NOT NULL,previous_type text,next_type text NOT NULL,
 reason text NOT NULL,basis text NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(account_id,revision)
);
CREATE TABLE private_conversation_archives_v1 (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES community_accounts(id),origin_subject_id text,
 title text NOT NULL,selection jsonb NOT NULL,state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready')),
 byte_length bigint NOT NULL DEFAULT 0 CHECK(byte_length>=0),chunk_count integer,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,expires_at timestamptz
);
CREATE INDEX private_archives_owner_v1 ON private_conversation_archives_v1(account_id,created_at DESC,id);
CREATE INDEX private_archives_cleanup_v1 ON private_conversation_archives_v1(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE private_conversation_chunks_v1 (
 archive_id uuid NOT NULL REFERENCES private_conversation_archives_v1(id) ON DELETE CASCADE,
 sequence integer NOT NULL CHECK(sequence>=0),content text NOT NULL,byte_length integer NOT NULL,
 PRIMARY KEY(archive_id,sequence)
);
CREATE TABLE private_conversation_deletions_v1 (
 archive_id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES community_accounts(id),scope_id uuid,origin_subject_id text,
 reason text NOT NULL CHECK(reason IN ('owner-deleted','expired')),deleted_at timestamptz NOT NULL
);
CREATE INDEX private_archive_deleted_scope_v1 ON private_conversation_deletions_v1(account_id,scope_id) WHERE scope_id IS NOT NULL;
`;
