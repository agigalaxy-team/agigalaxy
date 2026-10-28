
CREATE TABLE builders (
  id uuid PRIMARY KEY,owner_id text NOT NULL REFERENCES subjects(id),type text NOT NULL CHECK(type IN ('worker','bridge','hub')),
  revision integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE builder_events (
  id uuid PRIMARY KEY,builder_id uuid NOT NULL REFERENCES builders(id),subject_id text NOT NULL REFERENCES subjects(id),
  revision integer NOT NULL,kind text NOT NULL CHECK(kind IN ('declare','maintenance','heartbeat','compatibility')),
  consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
  received_at bigint NOT NULL,UNIQUE(builder_id,revision)
);
CREATE INDEX builders_owner ON builders(owner_id,id);
CREATE INDEX builders_type ON builders(type,id);
