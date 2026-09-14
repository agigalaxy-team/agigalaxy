// Migration55. Experience statements and reviewer reports have separate owners.
export const experienceReviewMigrationSql=`
CREATE TABLE experience_objects (
 id uuid PRIMARY KEY,object_type text NOT NULL CHECK(object_type IN ('experience','review')),subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 source_key text,experience_id uuid REFERENCES experience_objects(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((object_type='experience' AND source_key IS NOT NULL AND experience_id IS NULL) OR (object_type='review' AND source_key IS NULL AND experience_id IS NOT NULL)),
 UNIQUE(subject_id,source_key)
);
CREATE TABLE experience_events (
 operation_id uuid PRIMARY KEY,object_id uuid NOT NULL REFERENCES experience_objects(id),version integer NOT NULL,
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
 context jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(object_id,version)
);
CREATE INDEX experience_object_owner ON experience_objects(subject_id,id);
CREATE INDEX experience_object_source ON experience_objects(experience_id,id);
CREATE TABLE qualification_calculation_grants (
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),task_id uuid NOT NULL REFERENCES task_requests(id),
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
 revoked_at timestamptz,revoke_id uuid UNIQUE,revoke_consent_id uuid REFERENCES consents(id),revoke_payload_text text,revoke_payload_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((revoked_at IS NULL AND revoke_id IS NULL AND revoke_consent_id IS NULL AND revoke_payload_text IS NULL AND revoke_payload_hash IS NULL)
 OR(revoked_at IS NOT NULL AND revoke_id IS NOT NULL AND revoke_consent_id IS NOT NULL AND revoke_payload_text IS NOT NULL AND revoke_payload_hash IS NOT NULL))
);
CREATE INDEX qualification_grant_owner ON qualification_calculation_grants(subject_id,id);
`;
