
CREATE TABLE cases (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  local_ref text NOT NULL,
  source_ref text NOT NULL,
  version integer NOT NULL CHECK (version>0),
  state text NOT NULL CHECK (state IN ('open','resolution-proposed','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_id,local_ref),
  UNIQUE(subject_id,source_ref)
);
CREATE TABLE case_events (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases(id),
  subject_id text NOT NULL REFERENCES subjects(id),
  kind text NOT NULL CHECK (kind IN ('case','attempt','result','revision','withdrawal')),
  version integer NOT NULL,
  consent_id uuid NOT NULL REFERENCES consents(id),
  payload jsonb NOT NULL,
  payload_text text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id,version)
);
CREATE INDEX case_events_parent ON case_events(case_id,version);
