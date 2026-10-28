
CREATE TABLE consents (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  binding_id uuid NOT NULL REFERENCES bindings(id),
  intent jsonb NOT NULL,
  signature_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_owner ON consents(subject_id, created_at, id);
