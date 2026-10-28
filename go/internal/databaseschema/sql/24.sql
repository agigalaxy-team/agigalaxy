
CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY,subject_id text NOT NULL,binding_id uuid NOT NULL,requester_public_key text NOT NULL,
  payload_text text NOT NULL,payload_hash text NOT NULL,signature text NOT NULL,
  state text NOT NULL CHECK(state IN ('requested','review-needed','approved','rejected','cancelled')),
  revision integer NOT NULL CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deletion_active_subject ON deletion_requests(subject_id) WHERE state IN ('requested','review-needed','approved');
CREATE TABLE deletion_events (
  id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES deletion_requests(id),revision integer NOT NULL CHECK(revision>0),
  actor_kind text NOT NULL CHECK(actor_kind IN ('subject','operator')),actor_ref text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('request','cancel','needs-information','approve','reject')),
  payload_text text NOT NULL,payload_hash text NOT NULL,signature text,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,revision),CHECK((actor_kind='subject')=(signature IS NOT NULL))
);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
  (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
  ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel') AND consent_id IS NULL) OR
   (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel') AND consent_id IS NOT NULL))));
