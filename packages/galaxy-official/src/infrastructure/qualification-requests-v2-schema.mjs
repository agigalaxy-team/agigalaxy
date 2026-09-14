// Migration66: a request never substitutes for a source-author permission.
// Responses are independently owned; deleting a candidate cannot delete another
// author's signed response. Retention clears the owner's body, preserving receipts.
export const qualificationRequestsV2MigrationSql=`
CREATE TABLE qualification_permission_requests (
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),source_author_id text NOT NULL REFERENCES subjects(id),
 task_id uuid NOT NULL REFERENCES task_requests(id),scope_hash text NOT NULL,root_event_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','declined','cancelled','permission-recorded')),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qualification_request_inbox ON qualification_permission_requests(source_author_id,id);
CREATE INDEX qualification_request_owner ON qualification_permission_requests(subject_id,task_id,id);
CREATE TABLE qualification_permission_request_events (
 id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES qualification_permission_requests(id),subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL,kind text NOT NULL CHECK(kind IN ('request','decline','cancel','record-permission')),
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(request_id,version)
);
CREATE INDEX qualification_request_event_owner ON qualification_permission_request_events(subject_id,id);
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN
 ('assistance','context','context-accept','capsule','incident','room-message','room-invite','task-v2','task-comment','comment-governance','qualification-request'));
`;
