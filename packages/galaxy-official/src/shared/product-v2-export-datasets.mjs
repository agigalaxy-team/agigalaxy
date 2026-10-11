// Client-safe names for Product v2 export datasets. Server SQL projections live
// in infrastructure/lifecycle-export-v2.mjs and must never ship in the client.
export const productV2ExportDatasets = Object.freeze([
  'task-materials',
  'forum-post-heads','forum-version-locators','forum-reply-locators','forum-events','forum-permissions','forum-report-locators','forum-governance-events','forum-write-receipts','forum-daily-usage',
  'outcome-materials-v2',
  'watch-controls','watch-control-operations','identity-group-heads','identity-group-operations','identity-group-approvals',
  'information-watches','information-watch-operations','information-change-receipts','worker-pack-uses','worker-pack-use-events',
  'hub-heads-v2','hub-events-v2','hub-memberships-v2','hub-intake-receipts-v2','hub-peering-agreements-v2','hub-peering-events-v2',
  'hub-peering-grants-v2','hub-peering-changes-v2','hub-peering-receipts-v2','trust-package-permissions','qualification-request-receipts',
  'qualification-request-events','chat-attachment-receipts','configuration-objects','configuration-events','choice-snapshot-preferences',
  'choice-snapshot-heads','choice-snapshot-version-receipts','task-comments-v2','task-comment-events-v2','target-report-receipts-v2',
  'target-governance-events-v2','comment-report-receipts-v2','comment-governance-events-v2','ci-requests-v2','ci-observations-v2',
  'ci-proofs-v2','context-grants-v2','context-events-v2','contribution-publications','recruitment-opportunities','recruitment-events',
  'recruitment-task-links','room-shared-summary-receipts','notification-options-v2','notification-presentations','personal-summary-preferences',
  'personal-summary-heads','personal-summary-version-receipts','projects-v2','project-events-v2','project-roles-v2','project-field-sources-v2',
  'project-transfers-v2','project-preferences-v2','contacts-v2','contact-events-v2','experience-objects','experience-events',
  'qualification-calculation-grants','chat-created-room-receipts','chat-proposal-receipts','chat-memberships','chat-message-receipts',
  'chat-message-operations','chat-cursors','chat-message-preferences','chat-agent-grants','capsule-permissions','capsule-uses-v2',
  'identity-control-heads','identity-control-events','device-authorizations','recovery-authorizations','identity-operation-receipts',
  'case-task-links','community-account-links','community-accounts','community-daily-usage','community-interactions','community-write-receipts',
  'tasks','task-participations','task-events','verification-objects','verification-events','verification-dependencies','lifecycle-erasures'
]);
