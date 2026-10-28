
CREATE TABLE task_requests (
  id uuid PRIMARY KEY,
  case_id uuid REFERENCES cases(id),
  requester_id text NOT NULL REFERENCES subjects(id),
  root_event_id uuid NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task_participations (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES task_requests(id),
  subject_id text NOT NULL REFERENCES subjects(id),
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task_events (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES task_requests(id),
  participation_id uuid REFERENCES task_participations(id),
  subject_id text NOT NULL REFERENCES subjects(id),
  version integer NOT NULL CHECK (version > 0),
  participation_version integer,
  kind text NOT NULL,
  consent_id uuid NOT NULL REFERENCES consents(id),
  payload_text text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, version),
  UNIQUE(participation_id, participation_version)
);
CREATE INDEX task_requests_requester ON task_requests(requester_id,id);
CREATE INDEX task_requests_case ON task_requests(case_id) WHERE case_id IS NOT NULL;
CREATE INDEX task_participations_subject ON task_participations(subject_id,task_id);
CREATE INDEX task_events_author ON task_events(subject_id,task_id);
