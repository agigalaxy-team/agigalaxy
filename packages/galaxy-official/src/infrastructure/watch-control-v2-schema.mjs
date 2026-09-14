export const watchControlV2MigrationSql=`
CREATE TABLE watch_controls_v2 (
 watch_id uuid PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects(id),
 room_id uuid NOT NULL REFERENCES chat_rooms(room_id), task_id uuid,
 purpose text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','stopped')),
 current_grant_id uuid NOT NULL UNIQUE REFERENCES chat_agent_grants(grant_id),
 current_binding_id uuid NOT NULL REFERENCES bindings(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 stopped_at timestamptz
);
CREATE INDEX watch_control_owner_page ON watch_controls_v2(subject_id,watch_id);
CREATE TABLE watch_control_operations_v2 (
 operation_id uuid PRIMARY KEY, watch_id uuid NOT NULL REFERENCES watch_controls_v2(watch_id),
 subject_id text NOT NULL, binding_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('register','takeover','stop')),
 request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX watch_control_operation_owner ON watch_control_operations_v2(subject_id,watch_id);
`;
