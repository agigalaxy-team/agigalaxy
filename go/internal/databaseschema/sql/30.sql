
CREATE TABLE profile_statements (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),
  revision integer NOT NULL CHECK(revision>0),consent_id uuid NOT NULL REFERENCES consents(id),
  payload_text text NOT NULL,payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(subject_id,revision)
);
