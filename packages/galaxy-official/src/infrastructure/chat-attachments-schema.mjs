export const chatAttachmentsMigrationSql=`
CREATE TABLE chat_attachments (
 id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES chat_rooms(room_id), subject_id text NOT NULL REFERENCES subjects(id),
 request_hash text NOT NULL, name text NOT NULL, media_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0),
 sha256 text NOT NULL, storage_key text NOT NULL UNIQUE, encryption_key_id text NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','uploading','scan-pending','scanning','available','blocked','erased')),
 message_id uuid REFERENCES chat_message_refs(message_id), agent_grant_id uuid,
 created_at timestamptz NOT NULL, prepare_expires_at timestamptz NOT NULL, uploaded_at timestamptz, expires_at timestamptz,
 lease_id uuid, lease_until timestamptz, scan_attempts integer NOT NULL DEFAULT 0, scan_result jsonb,
 last_error text, revoked_at timestamptz, purge_pending boolean NOT NULL DEFAULT false, purged_at timestamptz,
 policy_version text NOT NULL DEFAULT 'galaxy-retention/v1-attachment-30d'
);
CREATE INDEX chat_attachment_owner ON chat_attachments(subject_id,id);
CREATE INDEX chat_attachment_message ON chat_attachments(message_id);
CREATE INDEX chat_attachment_pending ON chat_attachments(state,created_at) WHERE state IN ('scan-pending','scanning');
CREATE INDEX chat_attachment_expiry ON chat_attachments(expires_at) WHERE purged_at IS NULL;
`;
