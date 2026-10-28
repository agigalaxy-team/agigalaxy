
CREATE TABLE operations_feedback_v1(
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,
 account_id uuid NOT NULL REFERENCES community_accounts(id),submission_operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 6000),
 submitted_category text CHECK(submitted_category IN ('problem','suggestion')),
 submitted_module text NOT NULL CHECK(submitted_module IN ('account','community','chat','work','discovery','other')),
 category text CHECK(category IN ('problem','suggestion')),
 module text NOT NULL CHECK(module IN ('account','community','chat','work','discovery','other')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','closed')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,account_id,submission_operation_id)
);
CREATE INDEX operations_feedback_v1_directory ON operations_feedback_v1(endpoint,sequence DESC);
CREATE INDEX operations_feedback_v1_intake ON operations_feedback_v1(endpoint,account_id,created_at DESC);
CREATE INDEX operations_feedback_v1_status ON operations_feedback_v1(endpoint,state,created_at DESC);
CREATE TABLE operations_feedback_events_v1(
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,
 feedback_id uuid NOT NULL REFERENCES operations_feedback_v1(id),endpoint text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('submitted','updated')),operator_id text,
 operation_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 category text CHECK(category IN ('problem','suggestion')),
 module text NOT NULL CHECK(module IN ('account','community','chat','work','discovery','other')),
 state text NOT NULL CHECK(state IN ('pending','processing','closed')),
 note text CHECK(length(note) BETWEEN 1 AND 2000),http_request_id uuid,created_at timestamptz NOT NULL,
 CHECK((kind='submitted' AND operator_id IS NULL AND note IS NULL) OR (kind='updated' AND operator_id IS NOT NULL)),
 UNIQUE(feedback_id,revision)
);
CREATE INDEX operations_feedback_events_v1_history ON operations_feedback_events_v1(endpoint,feedback_id,sequence DESC);


ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN
 ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change','chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment','job-cancel','job-retry','search-retry','operations-summary-read','community-posts-query','community-post-read','community-sections-query','community-section-read','community-section-classify','community-section-visibility','community-reports-query','community-report-read','community-report-resolve','resources-query','resource-read','resource-visibility','files-query','file-read','file-retry','rule-save','notice-create','notice-save','notice-publish','notice-withdraw','notice-delivery','retention-request','retention-complete','retention-failed','feedback-query','feedback-read','feedback-update'));
