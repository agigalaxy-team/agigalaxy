
CREATE TABLE task_comments_v2 (
 id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES task_requests(id),subject_id text NOT NULL REFERENCES subjects(id),
 account_id uuid REFERENCES community_accounts(id),revision integer NOT NULL CHECK(revision>0),current_event_id uuid NOT NULL,
 reply_to_id uuid REFERENCES task_comments_v2(id),reply_to_revision integer,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','retracted')),
 review_state text NOT NULL DEFAULT 'clear' CHECK(review_state IN ('clear','pending-review','approved','rejected')),
 rule_version text NOT NULL,rule_reasons jsonb NOT NULL DEFAULT '[]',review_event_id uuid,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 CHECK((reply_to_id IS NULL)=(reply_to_revision IS NULL))
);
CREATE INDEX task_comments_v2_task ON task_comments_v2(task_id,id);
CREATE INDEX task_comments_v2_owner ON task_comments_v2(subject_id,id);
CREATE TABLE task_comment_events_v2 (
 id uuid PRIMARY KEY,comment_id uuid NOT NULL REFERENCES task_comments_v2(id),task_id uuid NOT NULL REFERENCES task_requests(id),
 subject_id text NOT NULL REFERENCES subjects(id),revision integer NOT NULL,kind text NOT NULL CHECK(kind IN ('create','edit','correct','retract')),
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
 text_fingerprint text,link_fingerprints jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL,erased_at timestamptz,
 UNIQUE(comment_id,revision)
);
CREATE INDEX task_comment_events_v2_owner ON task_comment_events_v2(subject_id,id);
CREATE TABLE comment_reports_v2 (
 id uuid PRIMARY KEY,comment_id uuid NOT NULL REFERENCES task_comments_v2(id),comment_revision integer NOT NULL,
 reporter_id text NOT NULL REFERENCES subjects(id),subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'received' CHECK(state IN ('received','resolved','appealed','withdrawn')),
 pause_until timestamptz,pause_event_id uuid,decision_event_id uuid,closed_at timestamptz,appeal_count integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL,
 FOREIGN KEY(comment_id,comment_revision) REFERENCES task_comment_events_v2(comment_id,revision)
);
CREATE INDEX comment_reports_v2_target ON comment_reports_v2(comment_id,comment_revision);
CREATE INDEX comment_reports_v2_reporter ON comment_reports_v2(reporter_id,id);
CREATE TABLE comment_governance_events_v2 (
 id uuid PRIMARY KEY,report_id uuid NOT NULL REFERENCES comment_reports_v2(id),subject_id text NOT NULL REFERENCES subjects(id),
 version integer NOT NULL,kind text NOT NULL CHECK(kind IN ('report','supplement','appeal','withdraw-report','pause','resume','resolve')),
 consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,created_at timestamptz NOT NULL,
 erased_at timestamptz,UNIQUE(report_id,version)
);
CREATE INDEX comment_governance_events_v2_owner ON comment_governance_events_v2(subject_id,id);
ALTER TABLE task_comments_v2 ADD FOREIGN KEY(review_event_id) REFERENCES comment_governance_events_v2(id);
ALTER TABLE comment_reports_v2 ADD FOREIGN KEY(pause_event_id) REFERENCES comment_governance_events_v2(id);
ALTER TABLE comment_reports_v2 ADD FOREIGN KEY(decision_event_id) REFERENCES comment_governance_events_v2(id);
