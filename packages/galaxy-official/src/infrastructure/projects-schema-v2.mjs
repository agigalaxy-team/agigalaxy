export const projectsV2MigrationSql = `
CREATE TABLE projects_v2 (
 id uuid PRIMARY KEY, creator_id text NOT NULL REFERENCES subjects(id), owner_id text NOT NULL REFERENCES subjects(id),
 revision integer NOT NULL CHECK(revision>0), state text NOT NULL CHECK(state IN ('active','archived')),
 document_event_id uuid NOT NULL, policy_event_id uuid NOT NULL, source_statement_id uuid,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE project_events_v2 (
 operation_id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects_v2(id), subject_id text NOT NULL REFERENCES subjects(id),
 revision integer NOT NULL CHECK(revision>0), kind text NOT NULL, consent_id uuid NOT NULL REFERENCES consents(id),
 payload_text text NOT NULL, payload_hash text NOT NULL, affected_fields jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL,
 UNIQUE(project_id,revision)
);
CREATE TABLE project_roles_v2 (
 project_id uuid NOT NULL REFERENCES projects_v2(id), subject_id text NOT NULL REFERENCES subjects(id),
 role text NOT NULL CHECK(role IN ('editor','representative')), grant_event_id uuid NOT NULL REFERENCES project_events_v2(operation_id),
 revoke_event_id uuid REFERENCES project_events_v2(operation_id), state text NOT NULL CHECK(state IN ('active','revoked')),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(project_id,subject_id,role)
);
CREATE TABLE project_field_sources_v2 (
 project_id uuid NOT NULL REFERENCES projects_v2(id), field_name text NOT NULL,
 event_id uuid NOT NULL REFERENCES project_events_v2(operation_id), PRIMARY KEY(project_id,field_name)
);
CREATE TABLE project_transfers_v2 (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects_v2(id), from_subject_id text NOT NULL REFERENCES subjects(id),
 to_subject_id text NOT NULL REFERENCES subjects(id), state text NOT NULL CHECK(state IN ('offered','accepted','cancelled')),
 offer_event_id uuid NOT NULL REFERENCES project_events_v2(operation_id), response_event_id uuid REFERENCES project_events_v2(operation_id),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX project_single_transfer_v2 ON project_transfers_v2(project_id) WHERE state='offered';
CREATE TABLE project_preferences_v2 (
 project_id uuid NOT NULL REFERENCES projects_v2(id), subject_id text NOT NULL REFERENCES subjects(id), revision integer NOT NULL,
 settings jsonb NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(project_id,subject_id)
);
CREATE INDEX project_owner_v2 ON projects_v2(owner_id,id);
CREATE INDEX project_role_subject_v2 ON project_roles_v2(subject_id,project_id) WHERE state='active';
`;
