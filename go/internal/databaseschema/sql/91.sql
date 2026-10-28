
CREATE TABLE chat_participants_v3 (
 actor_ref text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('identity','official-account')),
 subject_id text UNIQUE REFERENCES subjects(id) ON DELETE CASCADE, account_id uuid UNIQUE REFERENCES community_accounts(id) ON DELETE CASCADE,
 CHECK((kind='identity' AND subject_id IS NOT NULL AND account_id IS NULL AND actor_ref=subject_id)
   OR (kind='official-account' AND subject_id IS NULL AND account_id IS NOT NULL AND actor_ref='account:'||account_id::text))
);
INSERT INTO chat_participants_v3(actor_ref,kind,subject_id) SELECT id,'identity',id FROM subjects;
CREATE FUNCTION galaxy_chat_register_subject_v3() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN INSERT INTO chat_participants_v3(actor_ref,kind,subject_id) VALUES(NEW.id,'identity',NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END;
$$;
CREATE TRIGGER chat_register_subject_v3 AFTER INSERT ON subjects FOR EACH ROW EXECUTE FUNCTION galaxy_chat_register_subject_v3();
ALTER TABLE chat_rooms DROP CONSTRAINT chat_rooms_creator_subject_id_fkey;
ALTER TABLE chat_rooms ADD CONSTRAINT chat_rooms_creator_actor_v3 FOREIGN KEY(creator_subject_id) REFERENCES chat_participants_v3(actor_ref);
ALTER TABLE chat_memberships DROP CONSTRAINT chat_memberships_subject_id_fkey;
ALTER TABLE chat_memberships ADD CONSTRAINT chat_memberships_actor_v3 FOREIGN KEY(subject_id) REFERENCES chat_participants_v3(actor_ref);
ALTER TABLE chat_attachments DROP CONSTRAINT chat_attachments_subject_id_fkey;
ALTER TABLE chat_attachments ADD CONSTRAINT chat_attachments_actor_v3 FOREIGN KEY(subject_id) REFERENCES chat_participants_v3(actor_ref);
ALTER TABLE chat_human_message_reads DROP CONSTRAINT chat_human_message_reads_subject_id_fkey;
ALTER TABLE chat_human_message_reads ADD CONSTRAINT chat_human_message_reads_actor_v3 FOREIGN KEY(subject_id) REFERENCES chat_participants_v3(actor_ref);
ALTER TABLE community_write_receipts ALTER COLUMN subject_id DROP NOT NULL;
ALTER TABLE community_write_receipts ADD COLUMN actor_kind text NOT NULL DEFAULT 'identity' CHECK(actor_kind IN ('identity','official-account'));
ALTER TABLE community_write_receipts ADD COLUMN actor_ref text;
UPDATE community_write_receipts SET actor_ref=subject_id;
CREATE FUNCTION galaxy_community_receipt_actor_v3() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF NEW.actor_ref IS NULL AND NEW.actor_kind='identity' AND NEW.subject_id IS NOT NULL THEN NEW.actor_ref=NEW.subject_id; END IF;
  RETURN NEW;
 END;
$$;
CREATE TRIGGER community_receipt_actor_v3 BEFORE INSERT ON community_write_receipts FOR EACH ROW EXECUTE FUNCTION galaxy_community_receipt_actor_v3();
ALTER TABLE community_write_receipts ALTER COLUMN actor_ref SET NOT NULL;
ALTER TABLE community_write_receipts ADD CONSTRAINT community_write_actor_v3 CHECK(
 (actor_kind='identity' AND subject_id IS NOT NULL AND actor_ref=subject_id)
 OR (actor_kind='official-account' AND subject_id IS NULL AND actor_ref='account:'||account_id::text));


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
