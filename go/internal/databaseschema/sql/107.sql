
CREATE TABLE operations_recommendation_policy_v1(
 endpoint text PRIMARY KEY,revision integer NOT NULL CHECK(revision>0),enabled boolean NOT NULL,
 directions jsonb NOT NULL CHECK(jsonb_typeof(directions)='array'),controls jsonb NOT NULL,
 updated_at timestamptz NOT NULL
);
CREATE TABLE operations_recommendation_themes_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 enabled boolean NOT NULL,revision integer NOT NULL CHECK(revision>0),mapping jsonb NOT NULL,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL
);
CREATE INDEX operations_recommendation_themes_endpoint_v1 ON operations_recommendation_themes_v1(endpoint,label,id);
CREATE TABLE operations_recommendation_events_v1(
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,operator_id text NOT NULL,
 operation_id uuid NOT NULL,request_hash text NOT NULL,kind text NOT NULL CHECK(kind IN ('policy-updated','theme-created','theme-updated')),
 revision integer NOT NULL,theme_key text,changes jsonb NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 result jsonb NOT NULL,created_at timestamptz NOT NULL,UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_recommendation_events_history_v1 ON operations_recommendation_events_v1(endpoint,sequence DESC);
CREATE TABLE discovery_recommendation_requests_v1(
 sequence bigserial NOT NULL,endpoint text NOT NULL,id uuid NOT NULL,profile_id text NOT NULL,policy_version integer,
 mode text NOT NULL CHECK(mode IN ('personalized','latest')),placement text NOT NULL CHECK(placement='home-public-recommendations'),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,id)
);
CREATE INDEX discovery_recommendation_profile_v1 ON discovery_recommendation_requests_v1(endpoint,profile_id,created_at DESC);


ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN
 ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change','chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment','job-cancel','job-retry','search-retry','operations-summary-read','community-posts-query','community-post-read','community-sections-query','community-section-read','community-section-classify','community-section-visibility','community-reports-query','community-report-read','community-report-resolve','resources-query','resource-read','resource-visibility','files-query','file-read','file-retry','rule-save','notice-create','notice-save','notice-publish','notice-withdraw','notice-delivery','retention-request','retention-complete','retention-failed','feedback-query','feedback-read','feedback-update','community-content-query','community-content-read','community-content-visibility','community-content-curation','community-content-batch-preview','community-content-batch-visibility','community-tags-query','community-tag-create','community-tag-update','permission-role-save','permission-assignment-save','permission-automation-save','smtp-query','smtp-config-save','smtp-connection-test','smtp-delivery-test','smtp-dns-check','recommendations.configure'));
