export const forumAttachmentsV1MigrationSql=`
CREATE TABLE forum_attachments_v1 (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES community_accounts(id), subject_id text REFERENCES subjects(id),
 request_hash text NOT NULL, name text NOT NULL, media_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0),
 sha256 text NOT NULL, storage_key text NOT NULL UNIQUE, encryption_key_id text NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','uploading','scan-pending','scanning','available','blocked','erased')),
 created_at timestamptz NOT NULL, prepare_expires_at timestamptz NOT NULL, uploaded_at timestamptz, expires_at timestamptz, published_at timestamptz,
 lease_id uuid, lease_until timestamptz, scan_attempts integer NOT NULL DEFAULT 0, scan_result jsonb,
 last_error text, revoked_at timestamptz, purge_pending boolean NOT NULL DEFAULT false, purged_at timestamptz
);
CREATE INDEX forum_attachment_owner_v1 ON forum_attachments_v1(account_id,id);
CREATE INDEX forum_attachment_pending_v1 ON forum_attachments_v1(state,uploaded_at) WHERE state IN ('scan-pending','scanning');
CREATE TABLE forum_attachment_links_v1 (
 attachment_id uuid NOT NULL REFERENCES forum_attachments_v1(id) ON DELETE CASCADE,
 source_key text NOT NULL, post_id uuid NOT NULL REFERENCES forum_posts_v1(id) ON DELETE CASCADE,
 version_id uuid NOT NULL REFERENCES forum_versions_v1(id) ON DELETE CASCADE,
 reply_id uuid REFERENCES forum_replies_v1(id) ON DELETE CASCADE,
 published_until timestamptz NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(attachment_id,source_key)
);
CREATE INDEX forum_attachment_source_v1 ON forum_attachment_links_v1(source_key,attachment_id);
`;
