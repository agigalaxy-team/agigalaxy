
ALTER TABLE jobs ADD COLUMN lease_id uuid;
CREATE TABLE evidence_submissions (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  result_id uuid NOT NULL REFERENCES case_events(id),
  consent_id uuid NOT NULL REFERENCES consents(id),
  source_key text NOT NULL,
  payload_text text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','observed','unavailable','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_id,source_key)
);
CREATE TABLE verification_attempts (
  id uuid PRIMARY KEY,
  evidence_id uuid NOT NULL REFERENCES evidence_submissions(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  attempt integer NOT NULL,
  observation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,attempt)
);
CREATE INDEX verification_evidence ON verification_attempts(evidence_id,created_at,id);
