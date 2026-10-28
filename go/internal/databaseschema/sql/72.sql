
CREATE TABLE identity_groups_v2 (
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),version integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','active','revoked')),
 current_operation_id uuid,member_ids jsonb NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,source_erased_at timestamptz
);
CREATE INDEX identity_groups_v2_members ON identity_groups_v2 USING gin(member_ids);
CREATE TABLE identity_group_operations_v2 (
 id uuid PRIMARY KEY,group_id uuid NOT NULL REFERENCES identity_groups_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 kind text NOT NULL CHECK(kind IN ('create','revise','revoke')),expected_version integer NOT NULL,required_ids jsonb NOT NULL,
 payload_text text NOT NULL,payload_hash text NOT NULL,state text NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','committed','declined','cancelled','expired','conflict')),result_version integer,
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,closed_at timestamptz,erased_at timestamptz
);
CREATE INDEX identity_group_operations_v2_group ON identity_group_operations_v2(group_id,id);
CREATE INDEX identity_group_operations_v2_subject ON identity_group_operations_v2(subject_id,id);
CREATE TABLE identity_group_approvals_v2 (
 id uuid PRIMARY KEY,operation_id uuid NOT NULL REFERENCES identity_group_operations_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 decision text NOT NULL CHECK(decision IN ('approve','decline','cancel')),proof_text text NOT NULL,signature text NOT NULL,
 key_id text NOT NULL,epoch integer NOT NULL,public_key text NOT NULL,chain_head text,created_at timestamptz NOT NULL,
 sequence bigserial NOT NULL UNIQUE
);
CREATE INDEX identity_group_approvals_v2_subject ON identity_group_approvals_v2(subject_id,id);
ALTER TABLE identity_groups_v2 ADD FOREIGN KEY(current_operation_id) REFERENCES identity_group_operations_v2(id);
ALTER TABLE audit_events DROP CONSTRAINT audit_context_complete;
ALTER TABLE audit_events ADD CONSTRAINT audit_context_complete CHECK (context_version=0 OR
 (client_id IS NOT NULL AND audience IS NOT NULL AND scope IS NOT NULL AND binding_id IS NOT NULL AND idempotency_key IS NOT NULL AND
 ((action IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink','oauth.access','trust.permission.grant','trust.permission.revoke','identity.group.approval') AND consent_id IS NULL) OR
 (action NOT IN ('binding.create','binding.revoke','session.create','audit.grant','audit.grant.revoke','audit.query','audit.export','data.export.create','data.export.page','data.export.revoke','data.deletion.request','data.deletion.cancel','context.query','notification.preferences','notification.read','notification.archive','identity.link','identity.unlink','oauth.access','trust.permission.grant','trust.permission.revoke','identity.group.approval') AND consent_id IS NOT NULL))));
