
CREATE TABLE notification_preferences (
  subject_id text PRIMARY KEY REFERENCES subjects(id), revision integer NOT NULL DEFAULT 0,
  settings jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_reads (
  subject_id text NOT NULL REFERENCES subjects(id), kind text NOT NULL CHECK(kind IN ('assistance','context','context-accept')),
  event_id uuid NOT NULL, read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(subject_id,kind,event_id)
);
