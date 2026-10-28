
ALTER TABLE audit_events ADD COLUMN credential_scopes jsonb;
ALTER TABLE audit_events ADD CONSTRAINT audit_credential_scopes_array CHECK
  (credential_scopes IS NULL OR jsonb_typeof(credential_scopes) = 'array');
