export const contactsV2MigrationSql = `
CREATE TABLE contacts_v2 (
 id uuid PRIMARY KEY, initiator_id text NOT NULL REFERENCES subjects(id), recipient_id text NOT NULL REFERENCES subjects(id),
 purpose text NOT NULL CHECK(purpose IN ('conversation','reuse','collaboration','recruitment')),
 state text NOT NULL CHECK(state IN ('sent','accepted','declined','withdrawn','expired')),
 revision integer NOT NULL CHECK(revision>0), create_event_id uuid NOT NULL, response_event_id uuid,
 room_id uuid UNIQUE REFERENCES chat_rooms(room_id), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, CHECK(initiator_id<>recipient_id)
);
CREATE TABLE contact_events_v2 (
 operation_id uuid PRIMARY KEY, contact_id uuid NOT NULL REFERENCES contacts_v2(id), subject_id text NOT NULL REFERENCES subjects(id),
 revision integer NOT NULL CHECK(revision>0), kind text NOT NULL CHECK(kind IN ('send','accept','decline','withdraw')),
 consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(contact_id,revision)
);
CREATE INDEX contact_inbox_v2 ON contacts_v2(recipient_id,created_at,id);
CREATE INDEX contact_outbox_v2 ON contacts_v2(initiator_id,created_at,id);
ALTER TABLE community_write_receipts ADD COLUMN contact_id uuid;
ALTER TABLE community_write_receipts DROP CONSTRAINT community_invitation_target;
ALTER TABLE community_write_receipts ADD CONSTRAINT community_invitation_target
 CHECK(num_nonnulls(task_id,room_id,contact_id)<=1);
CREATE INDEX community_contact_invitation_response ON community_write_receipts(contact_id,recipient_id)
 WHERE category='invitation' AND responded_at IS NULL;
`;
