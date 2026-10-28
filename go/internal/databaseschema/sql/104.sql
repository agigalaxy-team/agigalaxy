
CREATE TABLE operations_messaging_plans_v1(
 sequence bigserial UNIQUE,id uuid PRIMARY KEY,endpoint text NOT NULL,
 version integer NOT NULL CHECK(version>0),revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('draft','active','paused','stopped')),
 created_by text NOT NULL,updated_by text NOT NULL,approved_by text,approved_role text CHECK(approved_role IN ('reader','administrator')),
 approved_at timestamptz,job_id uuid,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL
);
CREATE INDEX operations_messaging_plans_endpoint_v1 ON operations_messaging_plans_v1(endpoint,sequence DESC);
CREATE TABLE operations_messaging_versions_v1(
 plan_id uuid NOT NULL REFERENCES operations_messaging_plans_v1(id),version integer NOT NULL CHECK(version>0),
 config jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(plan_id,version)
);
CREATE TABLE operations_messaging_commands_v1(
 endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL,kind text NOT NULL,
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,operation_id)
);
CREATE TABLE operations_messaging_events_v1(
 sequence bigserial UNIQUE,id uuid PRIMARY KEY,plan_id uuid NOT NULL REFERENCES operations_messaging_plans_v1(id),
 operator_id text NOT NULL,operator_role text NOT NULL CHECK(operator_role IN ('reader','administrator')),
 kind text NOT NULL CHECK(kind IN ('create','save','activate','pause','resume','stop','withdraw')),
 version integer NOT NULL,revision integer NOT NULL,created_at timestamptz NOT NULL
);
CREATE INDEX operations_messaging_events_plan_v1 ON operations_messaging_events_v1(plan_id,sequence DESC);
CREATE TABLE operations_messaging_runs_v1(
 sequence bigserial UNIQUE,id uuid PRIMARY KEY,endpoint text NOT NULL,plan_id uuid NOT NULL,plan_version integer NOT NULL,
 occurrence_key text NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('running','paused','blocked','completed','cancelled','expired')),
 approved_by text NOT NULL,approved_role text NOT NULL CHECK(approved_role IN ('reader','administrator')),
 frozen_at timestamptz NOT NULL,audience_count integer NOT NULL CHECK(audience_count>=0),
 error_code text,job_id uuid,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,completed_at timestamptz,
 FOREIGN KEY(plan_id,plan_version) REFERENCES operations_messaging_versions_v1(plan_id,version),
 UNIQUE(plan_id,plan_version,occurrence_key)
);
CREATE INDEX operations_messaging_runs_endpoint_v1 ON operations_messaging_runs_v1(endpoint,sequence DESC);
CREATE INDEX operations_messaging_runs_plan_v1 ON operations_messaging_runs_v1(plan_id,sequence DESC);
CREATE TABLE operations_messaging_recipients_v1(
 sequence bigserial UNIQUE,id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES operations_messaging_runs_v1(id),
 account_id uuid NOT NULL,channel text NOT NULL CHECK(channel IN ('inapp','email')),
 state text NOT NULL CHECK(state IN ('pending','submitting','submitted','delivered','skipped','failed','unknown','blocked')),
 attempt_count integer NOT NULL DEFAULT 0,attempt_id uuid,lease_until timestamptz,retry_at timestamptz,
 message_id text,error_code text,retryable boolean NOT NULL DEFAULT false,
 submitted_at timestamptz,completed_at timestamptz,updated_at timestamptz NOT NULL,
 UNIQUE(run_id,account_id,channel)
);
CREATE INDEX operations_messaging_recipients_run_v1 ON operations_messaging_recipients_v1(run_id,sequence);
CREATE TABLE operations_messaging_attempts_v1(
 id uuid PRIMARY KEY,recipient_id uuid NOT NULL REFERENCES operations_messaging_recipients_v1(id),
 attempt_number integer NOT NULL CHECK(attempt_number>0),state text NOT NULL CHECK(state IN ('submitting','submitted','failed','unknown','not-configured','ineligible')),
 error_code text,started_at timestamptz NOT NULL,finished_at timestamptz,UNIQUE(recipient_id,attempt_number)
);
CREATE TABLE operations_messaging_announcements_v1(
 sequence bigserial UNIQUE,id uuid PRIMARY KEY,endpoint text NOT NULL,run_id uuid NOT NULL UNIQUE REFERENCES operations_messaging_runs_v1(id),
 plan_id uuid NOT NULL REFERENCES operations_messaging_plans_v1(id),plan_version integer NOT NULL,
 content jsonb NOT NULL,published_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,withdrawn_at timestamptz
);
CREATE INDEX operations_messaging_announcements_endpoint_v1 ON operations_messaging_announcements_v1(endpoint,sequence DESC);


CREATE TABLE operations_smtp_settings_v1(
 endpoint text PRIMARY KEY,version integer NOT NULL CHECK(version>0),configuration jsonb NOT NULL,
 updated_by text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),updated_at timestamptz NOT NULL
);
CREATE TABLE operations_smtp_commands_v1(
 endpoint text NOT NULL,operation_id uuid NOT NULL,operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 input jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,operation_id)
);
CREATE TABLE operations_smtp_events_v1(
 id uuid PRIMARY KEY,sequence bigserial UNIQUE,endpoint text NOT NULL,operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 version integer NOT NULL CHECK(version>0),changed_fields jsonb NOT NULL,created_at timestamptz NOT NULL
);
CREATE INDEX operations_smtp_events_endpoint_sequence ON operations_smtp_events_v1(endpoint,sequence DESC);
CREATE TABLE operations_smtp_tests_v1(
 id uuid PRIMARY KEY,sequence bigserial UNIQUE,endpoint text NOT NULL,operator_id text NOT NULL REFERENCES operations_operator_principals_v1(operator_id),
 kind text NOT NULL CHECK(kind IN('connection','delivery')),configuration_version integer NOT NULL CHECK(configuration_version>0),
 account_id uuid REFERENCES community_accounts(id),sender_key text CHECK(sender_key IN('account','notice','community','updates','team')),
 input jsonb NOT NULL,state text NOT NULL CHECK(state IN('testing','connected','submitted','not-configured','ineligible','failed','unknown')),
 code text,started_at timestamptz NOT NULL,finished_at timestamptz
);
CREATE INDEX operations_smtp_tests_endpoint_sequence ON operations_smtp_tests_v1(endpoint,sequence DESC);


SELECT galaxy_jobs.create_queue('messaging-run','{"policy":"exclusive","retryLimit":4,"retryDelay":30,"retryBackoff":true,"retryDelayMax":900,"expireInSeconds":300,"heartbeatSeconds":30,"retentionSeconds":604800,"deleteAfterSeconds":604800}'::jsonb);
SELECT galaxy_jobs.create_queue('messaging-delivery','{"policy":"exclusive","retryLimit":4,"retryDelay":30,"retryBackoff":true,"retryDelayMax":900,"expireInSeconds":300,"heartbeatSeconds":30,"retentionSeconds":604800,"deleteAfterSeconds":604800}'::jsonb);
CREATE FUNCTION public.galaxy_notice_original_operator_role(text,uuid,text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT a.operator_role FROM public.business_admin_audit_v1 a
 WHERE a.endpoint=$1 AND a.operator_id=$3 AND a.action='notice-publish'
 AND a.selection->>'noticeId'=$2::text AND a.operator_role IN('reader','administrator')
 ORDER BY a.sequence DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.galaxy_notice_original_operator_role(text,uuid,text) FROM PUBLIC;
ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN
 ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change','chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment','job-cancel','job-retry','search-retry','operations-summary-read','community-posts-query','community-post-read','community-sections-query','community-section-read','community-section-classify','community-section-visibility','community-reports-query','community-report-read','community-report-resolve','resources-query','resource-read','resource-visibility','files-query','file-read','file-retry','rule-save','notice-create','notice-save','notice-publish','notice-withdraw','notice-delivery','retention-request','retention-complete','retention-failed','feedback-query','feedback-read','feedback-update','community-content-query','community-content-read','community-content-visibility','community-content-curation','community-content-batch-preview','community-content-batch-visibility','community-tags-query','community-tag-create','community-tag-update','permission-role-save','permission-assignment-save','permission-automation-save','smtp-query','smtp-config-save','smtp-connection-test','smtp-delivery-test','smtp-dns-check'));
