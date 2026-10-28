
CREATE TABLE data_exports (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),binding_id uuid NOT NULL REFERENCES bindings(id),
  datasets jsonb NOT NULL,bounds jsonb NOT NULL,selection_cutoff timestamptz NOT NULL,expires_at timestamptz NOT NULL,
  revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_exports_expiry ON data_exports(expires_at);
CREATE INDEX data_exports_owner ON data_exports(binding_id,expires_at);
CREATE TABLE data_export_reads (
  id uuid PRIMARY KEY,export_id uuid REFERENCES data_exports(id) ON DELETE SET NULL,subject_id text NOT NULL REFERENCES subjects(id),
  dataset text NOT NULL,after_cursor text NOT NULL,result_hash text NOT NULL,result_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke') AND consent_id IS NOT NULL))));
 