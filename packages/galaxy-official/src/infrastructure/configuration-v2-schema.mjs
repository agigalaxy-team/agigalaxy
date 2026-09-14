export const configurationV2MigrationSql=`
CREATE TABLE configuration_objects (
 id uuid PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0), state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX configuration_owner ON configuration_objects(subject_id,id);
CREATE TABLE configuration_events (
 operation_id uuid PRIMARY KEY, configuration_id uuid NOT NULL REFERENCES configuration_objects(id),
 subject_id text NOT NULL REFERENCES subjects(id), version integer NOT NULL CHECK(version>0),
 kind text NOT NULL CHECK(kind IN ('record','revoke')), consent_id uuid NOT NULL REFERENCES consents(id),
 payload_text text NOT NULL, payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(configuration_id,version)
);
CREATE INDEX configuration_event_owner ON configuration_events(subject_id,operation_id);
`;
