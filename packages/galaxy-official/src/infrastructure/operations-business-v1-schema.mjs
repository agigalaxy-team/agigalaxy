export const operationsBusinessAuditActions=Object.freeze([
 'users-query','user-read','audit-read','restriction-set','restriction-release','type-change',
 'chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment',
 'job-cancel','job-retry','search-retry',
 'operations-summary-read','community-posts-query','community-post-read',
 'community-sections-query','community-section-read','community-section-classify','community-section-visibility',
 'community-reports-query','community-report-read','community-report-resolve',
 'resources-query','resource-read','resource-visibility','files-query','file-read','file-retry'
]);
export const operationsBusinessV1MigrationSql=`
CREATE TABLE operations_content_visibility_v1(
 endpoint text NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('forum-section','project','method')),
 target_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),hidden_until timestamptz,
 operation_id uuid NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(endpoint,target_kind,target_id)
);
ALTER TABLE forum_reports_v1 ADD COLUMN operations_disclosed boolean NOT NULL DEFAULT false;
CREATE TABLE forum_operations_events_v1(
 id uuid PRIMARY KEY,report_id uuid NOT NULL REFERENCES forum_reports_v1(id) ON DELETE CASCADE,
 operator_id text NOT NULL,http_request_id uuid,version integer NOT NULL CHECK(version>0),
 resolution text NOT NULL CHECK(resolution IN ('accepted','dismissed','needs-review')),summary text NOT NULL,
 effect_until timestamptz,created_at timestamptz NOT NULL,retained_until timestamptz NOT NULL,
 UNIQUE(report_id,version)
);
CREATE INDEX forum_operations_report_v1 ON forum_operations_events_v1(report_id,version);
ALTER TABLE forum_section_events_v2 DROP CONSTRAINT forum_section_events_v2_actor_kind_check;
ALTER TABLE forum_section_events_v2 ADD CONSTRAINT forum_section_events_v2_actor_kind_check CHECK(actor_kind IN ('identity','official-account','business-operator'));
ALTER TABLE forum_section_events_v2 ADD COLUMN operator_id text;
ALTER TABLE chat_attachments ADD COLUMN operations_retry_revision integer NOT NULL DEFAULT 0;
ALTER TABLE forum_attachments_v1 ADD COLUMN operations_retry_revision integer NOT NULL DEFAULT 0;
ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN (${operationsBusinessAuditActions.map(action=>"'"+action+"'").join(',')}));
`;
