
CREATE TABLE context_grants (
  id uuid PRIMARY KEY, assistance_id uuid NOT NULL REFERENCES assistance_requests(id),
  subject_id text NOT NULL REFERENCES subjects(id), participant_id text NOT NULL REFERENCES subjects(id),
  consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL, payload_hash text NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE context_acceptances (
  id uuid PRIMARY KEY, grant_id uuid NOT NULL UNIQUE REFERENCES context_grants(id),
  subject_id text NOT NULL REFERENCES subjects(id), consent_id uuid NOT NULL REFERENCES consents(id),
  payload_text text NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_assistance ON context_grants(assistance_id,id);
