
CREATE TABLE audit_access_grants (
  id uuid PRIMARY KEY,reviewer_id text NOT NULL REFERENCES subjects(id),reviewer_binding_id uuid NOT NULL REFERENCES bindings(id),
  reader_id text NOT NULL REFERENCES subjects(id),payload_text text NOT NULL,payload_hash text NOT NULL,signature text NOT NULL,
  expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CHECK(reviewer_id<>reader_id)
);
CREATE INDEX audit_grants_reader ON audit_access_grants(reader_id,id);
CREATE TABLE audit_reads (
  id uuid PRIMARY KEY,actor_id text NOT NULL REFERENCES subjects(id),subject_id text NOT NULL,
  grant_id uuid REFERENCES audit_access_grants(id),action text NOT NULL CHECK(action IN ('query','export')),
  selection jsonb NOT NULL,result_hash text NOT NULL,result_count integer NOT NULL,created_at timestamptz NOT NULL
);
CREATE INDEX audit_actor_sequence ON audit_events(actor,sequence);
CREATE INDEX audit_binding_sequence ON audit_events(binding_id,sequence);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL
   AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
   ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export') AND consent_id IS NULL) OR
    (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export') AND consent_id IS NOT NULL))));
