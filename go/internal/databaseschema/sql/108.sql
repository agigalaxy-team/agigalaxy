
CREATE TABLE operations_search_quality_state_v1(
 endpoint text PRIMARY KEY,revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 active_id uuid,draft_id uuid,pending_operation uuid,updated_at timestamptz NOT NULL
);
CREATE TABLE operations_search_quality_versions_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,version integer NOT NULL CHECK(version>=0),
 settings jsonb,native_settings jsonb NOT NULL,kind text NOT NULL CHECK(kind IN ('baseline','draft','restore')),
 restored_from uuid,operator_id text NOT NULL,created_at timestamptz NOT NULL,UNIQUE(endpoint,version)
);
CREATE TABLE operations_search_quality_operations_v1(
 sequence bigserial PRIMARY KEY,endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('draft','apply','restore')),request_hash text NOT NULL,input jsonb NOT NULL,
 version_id uuid NOT NULL,phase text NOT NULL CHECK(phase IN ('prepared','submitting','task-pending','applied','failed','result-unknown')),
 native_task_id bigint,native_watermark bigint,submitted_at timestamptz,error_code text,
 changes jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_search_quality_history_v1 ON operations_search_quality_operations_v1(endpoint,sequence DESC);
CREATE TABLE discovery_search_requests_v1(
 endpoint text NOT NULL,id uuid NOT NULL,profile_id text NOT NULL,query text NOT NULL,
 configuration_version integer,source_offset integer NOT NULL,result_state text NOT NULL CHECK(result_state IN ('has-results','no-results','scan-limited')),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,id)
);
CREATE INDEX discovery_search_profile_v1 ON discovery_search_requests_v1(endpoint,profile_id,created_at DESC);


ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN
 ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change','chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment','job-cancel','job-retry','search-retry','operations-summary-read','community-posts-query','community-post-read','community-sections-query','community-section-read','community-section-classify','community-section-visibility','community-reports-query','community-report-read','community-report-resolve','resources-query','resource-read','resource-visibility','files-query','file-read','file-retry','rule-save','notice-create','notice-save','notice-publish','notice-withdraw','notice-delivery','retention-request','retention-complete','retention-failed','feedback-query','feedback-read','feedback-update','community-content-query','community-content-read','community-content-visibility','community-content-curation','community-content-batch-preview','community-content-batch-visibility','community-tags-query','community-tag-create','community-tag-update','permission-role-save','permission-assignment-save','permission-automation-save','smtp-query','smtp-config-save','smtp-connection-test','smtp-delivery-test','smtp-dns-check','recommendations.configure','search-quality.configure','search-quality.publish','search-quality.restore'));
