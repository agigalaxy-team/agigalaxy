
CREATE TABLE context_grants_v2 (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES task_requests(id),
  participation_id uuid NOT NULL REFERENCES task_participations(id),
  subject_id text NOT NULL REFERENCES subjects(id), participant_id text NOT NULL REFERENCES subjects(id),
  scope_version integer NOT NULL CHECK(scope_version>0), scope_event_id uuid NOT NULL REFERENCES task_events(id),
  consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL, payload_hash text NOT NULL,
  materials_hash text NOT NULL, expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','declined','revoked')),
  response_event_id uuid, revoked_at timestamptz, erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(subject_id<>participant_id)
);
CREATE INDEX context_grants_v2_task ON context_grants_v2(task_id,id);
CREATE INDEX context_grants_v2_owner ON context_grants_v2(subject_id,id);
CREATE INDEX context_grants_v2_recipient ON context_grants_v2(participant_id,id);
CREATE TABLE context_events_v2 (
  id uuid PRIMARY KEY, grant_id uuid NOT NULL REFERENCES context_grants_v2(id),
  subject_id text NOT NULL REFERENCES subjects(id), kind text NOT NULL CHECK(kind IN ('accept','decline','revoke')),
  consent_id uuid NOT NULL REFERENCES consents(id), payload_text text NOT NULL, payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX context_events_v2_response ON context_events_v2(grant_id) WHERE kind IN ('accept','decline');
CREATE UNIQUE INDEX context_events_v2_revocation ON context_events_v2(grant_id) WHERE kind='revoke';
CREATE INDEX context_events_v2_owner ON context_events_v2(subject_id,id);
