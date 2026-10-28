
CREATE TABLE assistance_requests (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES cases(id), requester_id text NOT NULL REFERENCES subjects(id),
  version integer NOT NULL CHECK(version>0), snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assistance_events (
  id uuid PRIMARY KEY, assistance_id uuid NOT NULL REFERENCES assistance_requests(id),
  subject_id text NOT NULL REFERENCES subjects(id), version integer NOT NULL CHECK(version>0),
  consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL, payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(assistance_id,version)
);
CREATE INDEX assistance_case ON assistance_requests(case_id,id);
