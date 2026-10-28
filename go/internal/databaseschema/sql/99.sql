
ALTER TABLE forum_operations_events_v1 ADD COLUMN restriction_action text CHECK(restriction_action IN ('keep','release','hide'));
ALTER TABLE operations_content_visibility_v1 DROP CONSTRAINT operations_content_visibility_v1_target_kind_check;
ALTER TABLE operations_content_visibility_v1 ADD CONSTRAINT operations_content_visibility_v1_target_kind_check
 CHECK(target_kind IN ('forum-section','project','method','forum-post','forum-reply'));
CREATE TABLE operations_forum_curation_v1(
 endpoint text NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('post','reply')),target_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),source_version integer NOT NULL CHECK(source_version>0),
 topic text CHECK(topic IN ('technology','arts','learning','life','galaxy','unclassified')),
 pinned boolean NOT NULL DEFAULT false,featured boolean NOT NULL DEFAULT false,
 tag_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(tag_ids)='array' AND jsonb_array_length(tag_ids)<=8),
 operation_id uuid NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(endpoint,target_kind,target_id)
);
CREATE TABLE operations_forum_tags_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 40),normalized_name text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(endpoint,normalized_name)
);
CREATE TABLE operations_forum_content_events_v1(
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('post','reply','tag')),
 target_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('visibility','curation','tag-create','tag-update')),
 operator_id text NOT NULL,operation_id uuid NOT NULL,source_version integer NOT NULL,revision integer NOT NULL CHECK(revision>0),
 reason text NOT NULL CHECK(length(reason)<=1600),changes jsonb NOT NULL,http_request_id uuid,created_at timestamptz NOT NULL
);
CREATE INDEX operations_forum_content_events_v1_history ON operations_forum_content_events_v1(endpoint,target_kind,target_id,sequence DESC);


ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN
 ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change','chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment','job-cancel','job-retry','search-retry','operations-summary-read','community-posts-query','community-post-read','community-sections-query','community-section-read','community-section-classify','community-section-visibility','community-reports-query','community-report-read','community-report-resolve','resources-query','resource-read','resource-visibility','files-query','file-read','file-retry','rule-save','notice-create','notice-save','notice-publish','notice-withdraw','notice-delivery','retention-request','retention-complete','retention-failed','feedback-query','feedback-read','feedback-update','community-content-query','community-content-read','community-content-visibility','community-content-curation','community-content-batch-preview','community-content-batch-visibility','community-tags-query','community-tag-create','community-tag-update'));
