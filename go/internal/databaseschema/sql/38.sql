
CREATE TABLE honor_rule_versions (
  sequence bigserial UNIQUE NOT NULL,endpoint text NOT NULL,rule_id text NOT NULL,rule_version text NOT NULL,
  definition_hash text NOT NULL CHECK(definition_hash ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
  introduced_config_id uuid NOT NULL REFERENCES runtime_config_events(id),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(endpoint,rule_id,rule_version)
);
CREATE INDEX honor_rule_versions_history ON honor_rule_versions(endpoint,sequence);
