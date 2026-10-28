
ALTER TABLE operations_product_rules_v1 DROP CONSTRAINT operations_product_rules_v1_policy_key_check;
ALTER TABLE operations_product_rules_v1 ADD CONSTRAINT operations_product_rules_v1_policy_key_check
 CHECK(policy_key IN('resource-budget','community-quota','forum-quota','business-controls'));
CREATE TABLE operations_p14_rule_versions_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,policy_key text NOT NULL,
 version integer NOT NULL CHECK(version>0),policy jsonb NOT NULL,
 source text NOT NULL CHECK(source IN('configured-baseline','business-operator','restore')),
 created_by text,created_at timestamptz NOT NULL,restored_from uuid REFERENCES operations_p14_rule_versions_v1(id),
 published_version integer,UNIQUE(endpoint,policy_key,version),
 FOREIGN KEY(endpoint,policy_key,published_version) REFERENCES operations_product_rules_v1(endpoint,policy_key,version)
);
CREATE TABLE operations_p14_rule_heads_v1(
 endpoint text NOT NULL,policy_key text NOT NULL CHECK(policy_key IN('resource-budget','community-quota','forum-quota','business-controls')),
 revision integer NOT NULL CHECK(revision>=0),active_id uuid NOT NULL REFERENCES operations_p14_rule_versions_v1(id),
 draft_id uuid REFERENCES operations_p14_rule_versions_v1(id),updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,policy_key)
);
CREATE TABLE operations_p14_rule_commands_v1(
 endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL,
 policy_key text NOT NULL,kind text NOT NULL CHECK(kind IN('draft','publish','restore')),
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,operation_id)
);
CREATE TABLE operations_p14_rule_events_v1(
 sequence bigserial UNIQUE,id uuid PRIMARY KEY,endpoint text NOT NULL,policy_key text NOT NULL,
 operation_id uuid NOT NULL,version_id uuid NOT NULL REFERENCES operations_p14_rule_versions_v1(id),
 kind text NOT NULL CHECK(kind IN('draft','publish','restore')),operator_id text NOT NULL,
 reason text NOT NULL,changes jsonb NOT NULL,created_at timestamptz NOT NULL
);
CREATE INDEX operations_p14_rule_events_page_v1 ON operations_p14_rule_events_v1(endpoint,policy_key,sequence DESC);
CREATE TABLE operations_p14_rule_decisions_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,target text NOT NULL,operation_ref uuid NOT NULL,
 stage text NOT NULL CHECK(stage IN('write','prepare','upload-start','upload-bytes')),
 policy_key text NOT NULL DEFAULT 'business-controls' CHECK(policy_key='business-controls'),
 policy_version integer NOT NULL,matched_rule_ids uuid[] NOT NULL,exception_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL,UNIQUE(endpoint,target,operation_ref,stage),
 FOREIGN KEY(endpoint,policy_key,policy_version) REFERENCES operations_product_rules_v1(endpoint,policy_key,version)
);
