
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN
 ('assistance','context','context-accept','capsule','incident','room-message','room-invite','task-v2'));
CREATE TABLE notification_options_v2 (
 subject_id text PRIMARY KEY REFERENCES subjects(id), revision integer NOT NULL DEFAULT 0,
 settings jsonb NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE notification_presentations (
 subject_id text NOT NULL REFERENCES subjects(id), kind text NOT NULL, event_id uuid NOT NULL,
 client_id uuid NOT NULL, claim_id uuid NOT NULL, lease_until timestamptz NOT NULL,
 presented_at timestamptz, expires_at timestamptz NOT NULL,
 PRIMARY KEY(subject_id,kind,event_id)
);
CREATE TABLE personal_summary_preferences (
 subject_id text PRIMARY KEY REFERENCES subjects(id), revision integer NOT NULL,
 endpoint text NOT NULL, enabled boolean NOT NULL DEFAULT false, room_ids jsonb,
 include_existing boolean NOT NULL DEFAULT true, enabled_since timestamptz NOT NULL,
 updated_at timestamptz NOT NULL
);
CREATE TABLE personal_summary_heads (
 subject_id text NOT NULL REFERENCES subjects(id), summary_id uuid NOT NULL, room_id uuid NOT NULL REFERENCES chat_rooms(room_id),
 revision integer NOT NULL DEFAULT 0, current_version_id uuid, deleted_at timestamptz,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 PRIMARY KEY(subject_id,summary_id)
);
CREATE TABLE personal_summary_versions (
 subject_id text NOT NULL, summary_id uuid NOT NULL, version_id uuid NOT NULL,
 base_revision integer NOT NULL, revision integer NOT NULL, request_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('current','conflict','superseded','deleted','expired')),
 content jsonb NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(subject_id,version_id), FOREIGN KEY(subject_id,summary_id) REFERENCES personal_summary_heads(subject_id,summary_id)
);
CREATE INDEX personal_summary_versions_source ON personal_summary_versions USING gin(content);
CREATE INDEX personal_summary_versions_summary ON personal_summary_versions(subject_id,summary_id,revision);
CREATE INDEX personal_summary_versions_expiry ON personal_summary_versions(expires_at) WHERE state IN ('current','conflict');
CREATE INDEX notification_presentations_expiry ON notification_presentations(expires_at);
