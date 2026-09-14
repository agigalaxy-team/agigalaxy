export const evidenceVerificationV2MigrationSql = `
CREATE TABLE verification_objects (
  id uuid PRIMARY KEY,
  object_type text NOT NULL CHECK (object_type IN ('evidence','verification')),
  case_id uuid NOT NULL REFERENCES cases(id),
  subject_id text NOT NULL REFERENCES subjects(id),
  version integer NOT NULL CHECK (version>=0),
  state text NOT NULL CHECK (state IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_objects_case ON verification_objects(case_id,object_type);
CREATE TABLE verification_events (
  operation_id uuid PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES verification_objects(id),
  version integer NOT NULL CHECK (version>0),
  consent_id uuid NOT NULL REFERENCES consents(id),
  payload jsonb NOT NULL,
  payload_text text NOT NULL,
  payload_hash text NOT NULL,
  context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(object_id,version)
);
CREATE TABLE verification_dependencies (
  object_id uuid NOT NULL,
  object_version integer NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('attempt','intervention','result','evidence')),
  target_id uuid NOT NULL,
  target_version integer NOT NULL,
  PRIMARY KEY (object_id,object_version,target_type,target_id,target_version),
  FOREIGN KEY (object_id,object_version) REFERENCES verification_events(object_id,version)
);
CREATE INDEX verification_dependencies_target ON verification_dependencies(target_type,target_id,target_version);
`;
