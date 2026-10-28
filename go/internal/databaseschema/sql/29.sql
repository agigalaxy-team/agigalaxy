
CREATE TABLE incident_notices (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),
  runtime_config_id uuid NOT NULL REFERENCES runtime_config_events(id),
  incident_id text NOT NULL,incident_revision integer NOT NULL CHECK(incident_revision>0),
  operator_ref text NOT NULL,title text NOT NULL,summary text NOT NULL,
  command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_notices_subject ON incident_notices(subject_id,id);
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN ('assistance','context','context-accept','capsule','incident'));
