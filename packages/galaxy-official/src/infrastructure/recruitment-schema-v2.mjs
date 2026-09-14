export const recruitmentV2MigrationSql=`
CREATE TABLE recruitment_opportunities (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects_v2(id),creator_id text NOT NULL REFERENCES subjects(id),
 publisher_id text NOT NULL REFERENCES subjects(id),contact_subject_id text NOT NULL REFERENCES subjects(id),
 revision integer NOT NULL CHECK(revision>0),state text NOT NULL CHECK(state IN ('active','paused','closed')),
 current_event_id uuid NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL
);
CREATE TABLE recruitment_events (
 operation_id uuid PRIMARY KEY,recruitment_id uuid NOT NULL REFERENCES recruitment_opportunities(id),
 subject_id text NOT NULL REFERENCES subjects(id),revision integer NOT NULL CHECK(revision>0),kind text NOT NULL,
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(recruitment_id,revision)
);
CREATE TABLE recruitment_task_links (
 recruitment_id uuid NOT NULL REFERENCES recruitment_opportunities(id),task_id uuid NOT NULL REFERENCES task_requests(id),
 subject_id text NOT NULL REFERENCES subjects(id),operation_id uuid NOT NULL REFERENCES recruitment_events(operation_id),
 created_at timestamptz NOT NULL,PRIMARY KEY(recruitment_id,task_id)
);
CREATE INDEX recruitment_contact ON recruitment_opportunities(contact_subject_id,id);
CREATE INDEX recruitment_project ON recruitment_opportunities(project_id,id);
ALTER TABLE community_write_receipts ADD COLUMN recruitment_id uuid;
ALTER TABLE community_write_receipts DROP CONSTRAINT community_invitation_target;
ALTER TABLE community_write_receipts ADD CONSTRAINT community_invitation_target
 CHECK(num_nonnulls(task_id,room_id,contact_id,recruitment_id)<=1);
`;
