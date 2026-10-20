// Account chat participants are independent of local identities. Existing GUID
// keys, room IDs, author references and archive records retain their values.
export const accountChatV3MigrationSql=`
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
`;
