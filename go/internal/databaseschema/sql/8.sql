
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL
   AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
   ((action IN ('binding.create','binding.revoke','session.create') AND consent_id IS NULL) OR
    (action NOT IN ('binding.create','binding.revoke','session.create') AND consent_id IS NOT NULL))));
