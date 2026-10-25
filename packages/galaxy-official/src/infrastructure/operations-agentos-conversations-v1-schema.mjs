export const operationsAgentOsConversationsMigrationSql=`
CREATE TABLE operations_agentos_conversations_v1 (
 id uuid PRIMARY KEY, endpoint text NOT NULL, operator_id text NOT NULL,
 domain text NOT NULL CHECK(domain IN ('overview','governance','messaging','discovery','maintenance')),
 permission_key text NOT NULL, session_id uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL,
 UNIQUE(endpoint,operator_id,domain,permission_key)
);
CREATE TABLE operations_agentos_conversation_commands_v1 (
 id uuid PRIMARY KEY, endpoint text NOT NULL,
 conversation_id uuid NOT NULL REFERENCES operations_agentos_conversations_v1(id),
 operator_id text NOT NULL, message_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('dispatching','accepted','unknown','not-started')),
 result jsonb NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(endpoint,id)
);
`;
