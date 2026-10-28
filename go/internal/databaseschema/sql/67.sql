
CREATE TABLE trust_package_permissions (
 id UUID PRIMARY KEY,
 subject_id TEXT NOT NULL REFERENCES subjects(id),
 grantee_id TEXT NOT NULL,
 operation_id UUID NOT NULL UNIQUE,
 payload_text TEXT NOT NULL,
 signed TEXT NOT NULL,
 signature_hash TEXT NOT NULL,
 identity JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 revoke_operation_id UUID UNIQUE,
 revoke_payload_text TEXT,
 revoke_signed TEXT,
 revoke_signature_hash TEXT,
 CHECK(expires_at>created_at)
);
CREATE INDEX trust_package_permissions_author ON trust_package_permissions(subject_id,id);
CREATE INDEX trust_package_permissions_recipient ON trust_package_permissions(grantee_id,id);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
 (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
 ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink','oauth.access','trust.permission.grant','trust.permission.revoke') AND consent_id IS NULL) OR
 (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink','oauth.access','trust.permission.grant','trust.permission.revoke') AND consent_id IS NOT NULL))));
