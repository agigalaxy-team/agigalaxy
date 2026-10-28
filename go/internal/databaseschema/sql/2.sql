
CREATE TABLE session_challenges (
  id uuid PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES bindings(id),
  challenge_hash text NOT NULL UNIQUE,
  credential_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
