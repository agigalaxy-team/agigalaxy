
ALTER TABLE audit_events ADD COLUMN caller_binding_id uuid;
ALTER TABLE audit_events ADD COLUMN caller_client_id text;
ALTER TABLE audit_events ADD COLUMN caller_audience text;
ALTER TABLE audit_events ADD COLUMN caller_binding_scopes jsonb;
ALTER TABLE audit_events ADD CONSTRAINT audit_caller_complete CHECK (
  (caller_binding_id IS NULL AND caller_client_id IS NULL AND caller_audience IS NULL AND caller_binding_scopes IS NULL)
  OR (caller_binding_id IS NOT NULL AND caller_client_id IS NOT NULL AND caller_audience IS NOT NULL
      AND caller_binding_scopes IS NOT NULL AND jsonb_typeof(caller_binding_scopes) = 'array'));
