
CREATE TABLE runtime_config_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,id uuid NOT NULL UNIQUE,
  endpoint text NOT NULL,component text NOT NULL CHECK(component IN ('api','worker')),
  command_hash text NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),event_hash text NOT NULL CHECK(event_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_config_history ON runtime_config_events(endpoint,component,sequence);
