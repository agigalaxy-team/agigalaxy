
ALTER TABLE operations_agentos_conversations_v1 ADD COLUMN retired_at timestamptz;
ALTER TABLE operations_agentos_conversations_v1 ADD COLUMN retirement_reason text
 CHECK(retirement_reason IS NULL OR retirement_reason IN ('source-changed','authority-changed'));
DO $$ DECLARE constraint_name text; BEGIN
 SELECT c.conname INTO STRICT constraint_name FROM pg_constraint c
 WHERE c.conrelid='operations_agentos_conversations_v1'::regclass AND c.contype='u'
 AND (SELECT array_agg(a.attname::text ORDER BY n.ordinality) FROM unnest(c.conkey) WITH ORDINALITY n(attnum,ordinality)
 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=n.attnum)
 =ARRAY['endpoint','operator_id','domain','permission_key'];
 EXECUTE format('ALTER TABLE operations_agentos_conversations_v1 DROP CONSTRAINT %I',constraint_name);
END $$;
CREATE UNIQUE INDEX operations_agentos_active_conversation_v1
 ON operations_agentos_conversations_v1(endpoint,operator_id,domain,permission_key) WHERE retired_at IS NULL;
ALTER TABLE operations_agentos_conversation_commands_v1 ADD COLUMN native_run_id text;
CREATE TABLE operations_agentos_conversation_tool_calls_v1 (
 id uuid PRIMARY KEY, endpoint text NOT NULL,
 conversation_id uuid NOT NULL REFERENCES operations_agentos_conversations_v1(id),
 turn_id uuid NOT NULL REFERENCES operations_agentos_conversation_commands_v1(id),
 native_run_id text NOT NULL, call_id text NOT NULL, tool text NOT NULL,
 arguments_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('started','completed','unavailable')),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,conversation_id,native_run_id,call_id)
);
CREATE TABLE operations_agentos_conversation_sources_v1 (
 conversation_id uuid NOT NULL REFERENCES operations_agentos_conversations_v1(id),
 source_key text NOT NULL, evidence_ref jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(conversation_id,source_key)
);
CREATE TABLE operations_agentos_conversation_cards_v1 (
 id uuid PRIMARY KEY, endpoint text NOT NULL,
 conversation_id uuid NOT NULL REFERENCES operations_agentos_conversations_v1(id),
 turn_id uuid NOT NULL REFERENCES operations_agentos_conversation_commands_v1(id),
 tool_call_id uuid NOT NULL UNIQUE REFERENCES operations_agentos_conversation_tool_calls_v1(id),
 operator_id text NOT NULL, domain text NOT NULL, operation_id uuid NOT NULL UNIQUE,
 request_digest text NOT NULL,
 proposal jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','processing','completed','unknown','not-available')),
 result jsonb, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,turn_id,request_digest)
);
CREATE INDEX operations_agentos_conversation_cards_owner_v1
 ON operations_agentos_conversation_cards_v1(endpoint,operator_id,conversation_id,created_at DESC);
