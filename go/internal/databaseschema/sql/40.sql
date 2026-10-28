
CREATE TABLE external_identity_links (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),binding_id uuid NOT NULL REFERENCES bindings(id),
  endpoint text NOT NULL,provider_id text NOT NULL,issuer text NOT NULL,external_subject text NOT NULL,client_id text NOT NULL,
  payload_text text NOT NULL,payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz
);
CREATE UNIQUE INDEX external_identity_active_account ON external_identity_links(endpoint,issuer,external_subject) WHERE revoked_at IS NULL;
CREATE INDEX external_identity_owner ON external_identity_links(subject_id,endpoint,id);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink') AND consent_id IS NOT NULL))));
