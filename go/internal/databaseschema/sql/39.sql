
ALTER TABLE notification_preferences ADD COLUMN archived_before timestamptz;
CREATE INDEX notification_reads_retention ON notification_reads(subject_id,read_at);
CREATE INDEX assistance_invitation_rate ON assistance_events(subject_id,created_at)
  WHERE payload_text::jsonb->'event'->>'kind'='invite';
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive') AND consent_id IS NOT NULL))));
