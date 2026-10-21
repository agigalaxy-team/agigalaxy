export const operationsManagementAuditV1MigrationSql=`
ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check CHECK(action IN
 ('users-query','user-read','audit-read','restriction-set','restriction-release','type-change',
  'chat-reports-query','chat-report-read','chat-report-event','chat-report-attachment',
  'job-cancel','job-retry','search-retry'));
`;
