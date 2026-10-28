
CREATE TABLE subjects (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  genesis_proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE binding_challenges (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL,
  payload jsonb NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bindings (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  challenge_id uuid NOT NULL UNIQUE REFERENCES binding_challenges(id),
  request_hash text NOT NULL,
  audience text NOT NULL,
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  receipt text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE access_credentials (
  token_hash text PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES bindings(id),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  object_id text NOT NULL,
  request_id text NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  deduplication_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pending ON jobs (available_at) WHERE state = 'pending';
CREATE INDEX bindings_subject ON bindings (subject_id);
CREATE INDEX audit_object ON audit_events (object_id, sequence);
