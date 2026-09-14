// Migration71: independent Task/Room handling, not an alteration of comment61.
export const targetGovernanceV2MigrationSql = `
CREATE TABLE target_reports_v2 (
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),
 target_type text NOT NULL CHECK(target_type IN ('task','room')),task_id uuid REFERENCES task_requests(id),room_id uuid REFERENCES chat_rooms(room_id),
 target_version integer NOT NULL CHECK(target_version>0),root_event_id uuid REFERENCES task_events(id),
 party_ids jsonb NOT NULL,version integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'received' CHECK(state IN ('received','reviewing','resolved','appealed','withdrawn')),
 restriction_scopes jsonb NOT NULL DEFAULT '[]',restriction_until timestamptz,restriction_event_id uuid,
 decision_event_id uuid,closed_at timestamptz,appeal_count integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL,
 CHECK((target_type='task' AND task_id IS NOT NULL AND room_id IS NULL AND root_event_id IS NOT NULL) OR
       (target_type='room' AND room_id IS NOT NULL AND task_id IS NULL AND root_event_id IS NULL))
);
CREATE INDEX target_reports_v2_task ON target_reports_v2(task_id,restriction_until);
CREATE INDEX target_reports_v2_room ON target_reports_v2(room_id,restriction_until);
CREATE INDEX target_reports_v2_owner ON target_reports_v2(subject_id,id);
CREATE TABLE target_governance_events_v2 (
 id uuid PRIMARY KEY,report_id uuid NOT NULL REFERENCES target_reports_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL,kind text NOT NULL CHECK(kind IN ('report','review','supplement','appeal','withdraw-report','pause','resume','resolve')),
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
 created_at timestamptz NOT NULL,erased_at timestamptz,UNIQUE(report_id,version)
);
CREATE INDEX target_governance_events_v2_owner ON target_governance_events_v2(subject_id,id);
ALTER TABLE target_reports_v2 ADD FOREIGN KEY(restriction_event_id) REFERENCES target_governance_events_v2(id);
ALTER TABLE target_reports_v2 ADD FOREIGN KEY(decision_event_id) REFERENCES target_governance_events_v2(id);
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN
 ('assistance','context','context-accept','capsule','incident','room-message','room-invite','task-v2','task-comment','comment-governance','qualification-request','information-change','target-governance'));
`;
