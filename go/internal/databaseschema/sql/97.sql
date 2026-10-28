
CREATE TABLE operations_product_commands_v1(
 endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL,action text NOT NULL,
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,operation_id)
);
CREATE TABLE operations_product_rules_v1(
 endpoint text NOT NULL,policy_key text NOT NULL CHECK(policy_key IN ('resource-budget','community-quota','forum-quota')),
 version integer NOT NULL CHECK(version>0),policy jsonb NOT NULL,created_by text,source text NOT NULL CHECK(source IN ('configured-baseline','business-operator')),
 created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,policy_key,version)
);
CREATE TABLE operations_policy_processes_v1(
 endpoint text NOT NULL,component text NOT NULL,instance_id uuid NOT NULL,policy_key text NOT NULL,
 adopted_version integer,attempted_version integer NOT NULL,error_code text,checked_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,component,instance_id,policy_key),
 FOREIGN KEY(endpoint,policy_key,attempted_version) REFERENCES operations_product_rules_v1(endpoint,policy_key,version)
);
CREATE TABLE operations_notices_v1(
 sequence bigserial UNIQUE,id uuid PRIMARY KEY,endpoint text NOT NULL,version integer NOT NULL CHECK(version>0),
 content jsonb NOT NULL,state text NOT NULL CHECK(state IN ('draft','queued','delivering','delivered','withdrawn','expired')),
 created_by text NOT NULL,updated_by text NOT NULL,published_by text,published_at timestamptz,expires_at timestamptz NOT NULL,
 audience_count integer NOT NULL DEFAULT 0,job_id uuid,delivery_error_code text,last_attempt_at timestamptz,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL
);
CREATE INDEX operations_notices_endpoint_v1 ON operations_notices_v1(endpoint,sequence DESC);
CREATE TABLE account_operations_notices_v1(
 sequence bigserial UNIQUE,notice_id uuid NOT NULL REFERENCES operations_notices_v1(id),
 account_id uuid NOT NULL REFERENCES community_accounts(id) ON DELETE CASCADE,delivered_at timestamptz,read_at timestamptz,
 PRIMARY KEY(notice_id,account_id)
);
CREATE INDEX account_operations_notices_owner_v1 ON account_operations_notices_v1(account_id,sequence DESC);
CREATE TABLE operations_retention_runs_v1(
 sequence bigserial UNIQUE,id uuid PRIMARY KEY,endpoint text NOT NULL,target text NOT NULL
 CHECK(target IN ('private-conversation-archives','data-exports','information-watches')),
 state text NOT NULL CHECK(state IN ('queued','completed','failed','cancelled')),requested_by text NOT NULL,request_actor jsonb NOT NULL,
 job_id uuid,attempts integer NOT NULL DEFAULT 0,result jsonb,error_code text,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,finished_at timestamptz
);
CREATE INDEX operations_retention_runs_endpoint_v1 ON operations_retention_runs_v1(endpoint,sequence DESC);
CREATE TABLE operations_retention_observations_v1(
 endpoint text NOT NULL,target text NOT NULL,component text NOT NULL,result jsonb,error_code text,checked_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,target,component)
);


SELECT galaxy_jobs.create_queue('account-notice','{"policy":"exclusive","retryLimit":3,"retryDelay":30,"retryBackoff":true,"retryDelayMax":900,"expireInSeconds":900,"heartbeatSeconds":30,"retentionSeconds":604800,"deleteAfterSeconds":604800}'::jsonb);
SELECT galaxy_jobs.create_queue('retention-cleanup','{"policy":"exclusive","retryLimit":3,"retryDelay":30,"retryBackoff":true,"retryDelayMax":900,"expireInSeconds":900,"heartbeatSeconds":30,"retentionSeconds":604800,"deleteAfterSeconds":604800}'::jsonb);


ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN
 ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change','chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment','job-cancel','job-retry','search-retry','operations-summary-read','community-posts-query','community-post-read','community-sections-query','community-section-read','community-section-classify','community-section-visibility','community-reports-query','community-report-read','community-report-resolve','resources-query','resource-read','resource-visibility','files-query','file-read','file-retry','rule-save','notice-create','notice-save','notice-publish','notice-withdraw','notice-delivery','retention-request','retention-complete','retention-failed'));
