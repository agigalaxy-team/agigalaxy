// Migration77 adds a source projection kind; it creates no delivery queue and
// stores no report, invitation scope or private review content in the inbox.
export const moderationNotificationsV2MigrationSql = `
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN
 ('assistance','context','context-accept','capsule','incident','room-message','room-invite','task-v2','task-comment','comment-governance','qualification-request','information-change','target-governance','moderation-report','moderation-event'));
`;
