
ALTER TABLE audit_events ADD COLUMN binding_scopes jsonb;
ALTER TABLE audit_events ADD CONSTRAINT audit_binding_scopes_array CHECK
  (binding_scopes IS NULL OR jsonb_typeof(binding_scopes) = 'array');
