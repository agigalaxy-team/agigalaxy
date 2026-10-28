
ALTER TABLE account_chat_governance_events_v1 DROP CONSTRAINT account_chat_governance_events_v1_kind_check;
ALTER TABLE account_chat_governance_events_v1 ADD CONSTRAINT account_chat_governance_events_v1_kind_check
 CHECK(kind IN ('report','review','supplement','appeal','withdraw-report','pause','resume','resolve',
  'message-hide','message-restore','message-keep'));
CREATE TABLE operations_chat_message_visibility_v1 (
 endpoint text NOT NULL,report_id uuid NOT NULL REFERENCES account_chat_reports_v1(id),
 message_id uuid NOT NULL REFERENCES chat_message_refs(message_id),message_revision integer NOT NULL CHECK(message_revision>0),
 revision integer NOT NULL CHECK(revision>0),hidden boolean NOT NULL,
 initial_event_id uuid NOT NULL REFERENCES account_chat_governance_events_v1(id),
 current_event_id uuid NOT NULL REFERENCES account_chat_governance_events_v1(id),updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,report_id,message_id)
);
CREATE INDEX operations_chat_message_visibility_blocked_v1 ON operations_chat_message_visibility_v1(message_id) WHERE hidden;
