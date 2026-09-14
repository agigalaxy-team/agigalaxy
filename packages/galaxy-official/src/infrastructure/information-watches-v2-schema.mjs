export const informationWatchesV2MigrationSql = `
CREATE TABLE information_watches_v2(
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),revision integer NOT NULL CHECK(revision>0),check_revision integer NOT NULL DEFAULT 0,
 state text NOT NULL CHECK(state IN ('active','paused','ended')),plan jsonb NOT NULL,
 expires_at timestamptz NOT NULL,baseline jsonb NOT NULL DEFAULT '{}',scan jsonb NOT NULL DEFAULT '{}',
 last_checked_at timestamptz,next_check_at timestamptz,failures integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,ended_at timestamptz
);
CREATE INDEX information_watches_owner ON information_watches_v2(subject_id,id);
CREATE TABLE information_watch_operations_v2(
 operation_id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),watch_id uuid NOT NULL REFERENCES information_watches_v2(id),
 request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL
);
CREATE TABLE information_watch_changes_v2(
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),watch_id uuid NOT NULL REFERENCES information_watches_v2(id),
 batch_key text NOT NULL,watch_revision integer NOT NULL,changes jsonb NOT NULL,created_at timestamptz NOT NULL,available_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 UNIQUE(watch_id,batch_key)
);
CREATE INDEX information_watch_changes_owner ON information_watch_changes_v2(subject_id,id);
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN
 ('assistance','context','context-accept','capsule','incident','room-message','room-invite','task-v2','task-comment','comment-governance','qualification-request','information-change'));
`;
