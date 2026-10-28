
CREATE TABLE lifecycle_erasure_records (
  id uuid PRIMARY KEY,
  table_name text NOT NULL,
  object_key text NOT NULL,
  subject_id text NOT NULL,
  reason text NOT NULL CHECK(reason IN ('subject-deletion','temporary-content-expired','derived-content-erased')),
  policy_version text NOT NULL,
  original_payload_hash text,
  request_id uuid,
  erased_at timestamptz NOT NULL,
  retained_until timestamptz NOT NULL,
  UNIQUE(table_name,object_key)
);
CREATE INDEX lifecycle_erasure_expiry ON lifecycle_erasure_records(retained_until,id);
CREATE INDEX lifecycle_erasure_subject ON lifecycle_erasure_records(subject_id,id);
