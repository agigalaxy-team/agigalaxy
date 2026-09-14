// Migration49; append only. v1 Capsule event/use bytes and uniqueness remain.
export const capsuleV2MigrationSql = `
CREATE TABLE capsule_permissions (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),
  consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
  revoked_at timestamptz,revoke_id uuid UNIQUE,revoke_consent_id uuid REFERENCES consents(id),
  revoke_payload_text text,revoke_payload_hash text,created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((revoked_at IS NULL AND revoke_id IS NULL AND revoke_consent_id IS NULL AND revoke_payload_text IS NULL AND revoke_payload_hash IS NULL)
    OR (revoked_at IS NOT NULL AND revoke_id IS NOT NULL AND revoke_consent_id IS NOT NULL AND revoke_payload_text IS NOT NULL AND revoke_payload_hash IS NOT NULL))
);
CREATE INDEX capsule_permissions_owner ON capsule_permissions(subject_id,id);
CREATE TABLE capsule_uses_v2 (
  id uuid PRIMARY KEY,capsule_id uuid NOT NULL REFERENCES capsules(id),version_id uuid NOT NULL REFERENCES capsule_events(id),
  subject_id text NOT NULL REFERENCES subjects(id),case_id uuid NOT NULL REFERENCES cases(id),
  attempt_id uuid REFERENCES case_events(id),attempt_version integer,result_id uuid REFERENCES case_events(id),result_version integer,
  prior_use_id uuid REFERENCES capsule_uses_v2(id),kind text NOT NULL CHECK(kind IN ('reference','apply','reverify')),
  observed_revision integer NOT NULL,verification_fingerprint text NOT NULL,
  consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='reference' AND attempt_id IS NULL AND attempt_version IS NULL AND result_id IS NULL AND result_version IS NULL AND prior_use_id IS NULL)
    OR (kind IN ('apply','reverify') AND attempt_id IS NOT NULL AND attempt_version>0 AND result_id IS NOT NULL AND result_version>0)),
  CHECK ((kind='reverify')=(prior_use_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT(version_id,case_id,subject_id,kind,result_id,result_version,verification_fingerprint)
);
CREATE INDEX capsule_uses_v2_case ON capsule_uses_v2(case_id,id);
CREATE INDEX capsule_uses_v2_owner ON capsule_uses_v2(subject_id,id);
`;
