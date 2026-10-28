
CREATE TABLE feedback_attachments_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,account_id uuid NOT NULL REFERENCES community_accounts(id),
 submission_operation_id uuid NOT NULL,feedback_id uuid REFERENCES operations_feedback_v1(id),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),name text NOT NULL,media_type text NOT NULL,
 byte_size bigint NOT NULL CHECK(byte_size>0),sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 storage_key text NOT NULL UNIQUE,encryption_key_id text NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','uploading','scan-pending','scanning','available','blocked','erased')),
 created_at timestamptz NOT NULL,prepare_expires_at timestamptz NOT NULL,uploaded_at timestamptz,expires_at timestamptz,bound_at timestamptz,
 lease_id uuid,lease_until timestamptz,scan_attempts integer NOT NULL DEFAULT 0,scan_result jsonb,
 last_error text,revoked_at timestamptz,purge_pending boolean NOT NULL DEFAULT false,purged_at timestamptz,
 CHECK((feedback_id IS NULL AND bound_at IS NULL) OR (feedback_id IS NOT NULL AND bound_at IS NOT NULL))
);
CREATE INDEX feedback_attachment_owner_v1 ON feedback_attachments_v1(endpoint,account_id,submission_operation_id,id);
CREATE INDEX feedback_attachment_source_v1 ON feedback_attachments_v1(endpoint,feedback_id,id);
CREATE INDEX feedback_attachment_pending_v1 ON feedback_attachments_v1(state,uploaded_at) WHERE state IN ('scan-pending','scanning');
CREATE INDEX feedback_attachment_expiry_v1 ON feedback_attachments_v1(expires_at) WHERE purged_at IS NULL;
