export const accountChatGovernanceV1MigrationSql=`
CREATE TABLE account_chat_reports_v1 (
 id uuid PRIMARY KEY,endpoint text NOT NULL,room_id uuid NOT NULL REFERENCES chat_rooms(room_id),
 reporter_account_id uuid NOT NULL REFERENCES community_accounts(id),target_version integer NOT NULL CHECK(target_version>0),
 category text NOT NULL CHECK(category IN ('advertising','harassment','privacy','misrepresentation','other')),
 party_refs jsonb NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 state text NOT NULL DEFAULT 'received' CHECK(state IN ('received','reviewing','resolved','appealed','withdrawn')),
 restriction_scopes jsonb NOT NULL DEFAULT '[]',restriction_until timestamptz,restriction_event_id uuid,
 decision_event_id uuid,closed_at timestamptz,appeal_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL
);
CREATE INDEX account_chat_reports_room_v1 ON account_chat_reports_v1(room_id,restriction_until);
CREATE INDEX account_chat_reports_reporter_v1 ON account_chat_reports_v1(endpoint,reporter_account_id,id);
CREATE TABLE account_chat_governance_events_v1 (
 id uuid PRIMARY KEY,report_id uuid NOT NULL REFERENCES account_chat_reports_v1(id),
 actor_kind text NOT NULL CHECK(actor_kind IN ('official-account','business-operator')),
 account_id uuid REFERENCES community_accounts(id),operator_id text,http_request_id uuid,
 version integer NOT NULL CHECK(version>0),kind text NOT NULL CHECK(kind IN ('report','review','supplement','appeal','withdraw-report','pause','resume','resolve')),
 input jsonb NOT NULL,summary text NOT NULL,created_at timestamptz NOT NULL,erased_at timestamptz,
 CHECK((actor_kind='official-account' AND account_id IS NOT NULL AND operator_id IS NULL) OR
       (actor_kind='business-operator' AND account_id IS NULL AND operator_id IS NOT NULL)),
 UNIQUE(report_id,version)
);
CREATE TABLE account_chat_governance_materials_v1 (
 report_id uuid NOT NULL REFERENCES account_chat_reports_v1(id),event_id uuid NOT NULL REFERENCES account_chat_governance_events_v1(id),
 message_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),room_id uuid NOT NULL,
 author_ref text NOT NULL,sent_at timestamptz NOT NULL,source_expires_at timestamptz NOT NULL,
 text text NOT NULL,attachments jsonb NOT NULL DEFAULT '[]',erased_at timestamptz,
 PRIMARY KEY(event_id,message_id)
);
ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN
 ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change',
  'chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment'));
`;
