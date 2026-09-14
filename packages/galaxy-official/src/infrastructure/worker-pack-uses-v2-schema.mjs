// Additive migration69. References do not own or copy source content.
export const workerPackUsesV2MigrationSql = `
CREATE TABLE worker_pack_uses (
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),
 builder_id uuid NOT NULL,manifest_id uuid NOT NULL,case_id uuid NOT NULL,attempt_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(subject_id,manifest_id,attempt_id)
);
CREATE INDEX worker_pack_use_builder ON worker_pack_uses(builder_id,id);
CREATE TABLE worker_pack_use_events (
 operation_id uuid PRIMARY KEY,use_id uuid NOT NULL REFERENCES worker_pack_uses(id),
 subject_id text NOT NULL REFERENCES subjects(id),version integer NOT NULL,kind text NOT NULL CHECK(kind IN ('record','revoke')),
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(use_id,version)
);
CREATE INDEX worker_pack_use_event_owner ON worker_pack_use_events(subject_id,operation_id);
`;
