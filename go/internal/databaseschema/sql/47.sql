
CREATE TABLE chat_rooms (
 room_id uuid PRIMARY KEY, creator_subject_id text NOT NULL REFERENCES subjects(id), operation_id uuid NOT NULL,
 request_hash text NOT NULL, title text NOT NULL, kind text NOT NULL DEFAULT 'ordinary' CHECK(kind IN ('ordinary','ai-subzone')),
 parent_room_id uuid REFERENCES chat_rooms(room_id), task_refs jsonb NOT NULL DEFAULT '[]',
 mode text NOT NULL DEFAULT 'ownerless' CHECK(mode IN ('ownerless','owned')),
 state text NOT NULL DEFAULT 'waiting-members' CHECK(state IN ('waiting-members','active','single-member-decision','owner-succession','archived')),
 owner_subject_id text, persistent boolean NOT NULL DEFAULT false, retention_days integer NOT NULL DEFAULT 90 CHECK(retention_days IN (7,30,90)),
 revision integer NOT NULL DEFAULT 1, member_revision integer NOT NULL DEFAULT 1, had_multiple boolean NOT NULL DEFAULT false,
 succession_expires_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(creator_subject_id,operation_id)
);
CREATE TABLE chat_memberships (
 room_id uuid NOT NULL REFERENCES chat_rooms(room_id), subject_id text NOT NULL REFERENCES subjects(id), controller_ref text NOT NULL,
 joined_at timestamptz NOT NULL, left_at timestamptz, dismissed_revision integer, PRIMARY KEY(room_id,subject_id)
);
CREATE TABLE chat_decisions (
 decision_id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES chat_rooms(room_id), proposer_subject_id text NOT NULL,
 member_revision integer NOT NULL, required_parties jsonb NOT NULL, votes jsonb NOT NULL DEFAULT '{}',
 action text NOT NULL, payload jsonb NOT NULL, request_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','approved','rejected','accepted','cancelled','expired','stale')),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE chat_message_refs (
 message_id uuid PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 room_id uuid NOT NULL REFERENCES chat_rooms(room_id), subject_id text NOT NULL, client_message_id uuid NOT NULL,
 payload_hash text NOT NULL, actor_kind text NOT NULL CHECK(actor_kind IN ('human','agent')), agent_grant_id uuid,
 archive_id text, reply_to uuid, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','retracted','expired')),
 revision integer NOT NULL DEFAULT 1, sent_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 edited_at timestamptz, retracted_at timestamptz, purge_pending boolean NOT NULL DEFAULT false,
 UNIQUE(room_id,subject_id,client_message_id)
);
CREATE INDEX chat_message_page ON chat_message_refs(room_id,sequence);
CREATE INDEX chat_message_cleanup ON chat_message_refs(expires_at) WHERE state IN ('pending','accepted');
CREATE TABLE chat_message_operations (
 operation_id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES chat_rooms(room_id), message_id uuid NOT NULL REFERENCES chat_message_refs(message_id),
 subject_id text NOT NULL, kind text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE chat_cursors (
 room_id uuid NOT NULL REFERENCES chat_rooms(room_id), subject_id text NOT NULL, cursor_kind text NOT NULL CHECK(cursor_kind IN ('human','agent')),
 agent_ref text NOT NULL DEFAULT '', sequence bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL,
 PRIMARY KEY(room_id,subject_id,cursor_kind,agent_ref)
);
CREATE TABLE chat_message_preferences (
 room_id uuid NOT NULL REFERENCES chat_rooms(room_id), subject_id text NOT NULL, message_id uuid NOT NULL REFERENCES chat_message_refs(message_id),
 hidden boolean NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(room_id,subject_id,message_id)
);
CREATE TABLE chat_agent_grants (
 grant_id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES chat_rooms(room_id), subject_id text NOT NULL,
 binding_id uuid NOT NULL REFERENCES bindings(id), mode text NOT NULL CHECK(mode IN ('read','draft','respond')),
 primary_responder boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL
);
CREATE INDEX chat_agent_room ON chat_agent_grants(room_id,subject_id) WHERE revoked_at IS NULL;
