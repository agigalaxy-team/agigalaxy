
CREATE TABLE moderation_reports (
  id uuid PRIMARY KEY, assistance_id uuid NOT NULL REFERENCES assistance_requests(id), reporter_id text NOT NULL REFERENCES subjects(id),
  participant_ids jsonb NOT NULL, consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL,payload_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'open',paused boolean NOT NULL DEFAULT false,
  appeal_count integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE moderation_events (
  id uuid PRIMARY KEY,report_id uuid NOT NULL REFERENCES moderation_reports(id),subject_id text NOT NULL REFERENCES subjects(id),
  consent_id uuid NOT NULL REFERENCES consents(id),version integer NOT NULL,payload_text text NOT NULL,payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(report_id,version)
);
CREATE INDEX moderation_assistance ON moderation_reports(assistance_id,paused,id);
