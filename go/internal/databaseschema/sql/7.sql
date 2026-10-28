
ALTER TABLE audit_events ADD COLUMN context_version integer NOT NULL DEFAULT 0 CHECK (context_version IN (0,1));
ALTER TABLE audit_events ADD COLUMN client_id text;
ALTER TABLE audit_events ADD COLUMN audience text;
ALTER TABLE audit_events ADD COLUMN scope text;
ALTER TABLE audit_events ADD COLUMN consent_id uuid;
ALTER TABLE audit_events ADD COLUMN binding_id uuid;
ALTER TABLE audit_events ADD COLUMN http_request_id uuid;
ALTER TABLE audit_events ADD COLUMN idempotency_key text;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND consent_id IS NOT NULL
   AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL));
