
ALTER TABLE verification_attempts ADD COLUMN ordinal bigint GENERATED ALWAYS AS IDENTITY;
CREATE TABLE proofs (
  id uuid PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  evidence_id uuid NOT NULL REFERENCES evidence_submissions(id),
  observation_id uuid NOT NULL REFERENCES verification_attempts(id),
  consent_id uuid NOT NULL REFERENCES consents(id),
  payload_text text NOT NULL,
  payload_hash text NOT NULL,
  signed text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proofs_owner ON proofs(subject_id,created_at,id);
