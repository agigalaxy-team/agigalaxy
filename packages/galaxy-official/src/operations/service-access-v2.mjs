// Explicit operations, not a prefix or a permission bypass. The normal route
// still authenticates the current device and rechecks each object's permission.
// A POST called `events`/`submit` can publish as well as revoke and is deliberately
// absent. New routes must be classified from their real service behavior.
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const controlState=new RegExp('^/v2/identity/GUID[0-9A-Z]{28}/control$');
const bindingRead=new RegExp(`^/v1/bindings/${uuid}$`);
const controlPosts=new Set([
  '/v2/receipt-status/challenges',
  '/v1/binding-challenges','/v2/binding-challenges','/v1/bindings',
  '/v2/identity/control/status','/v2/identity/control/cancel',
  '/v2/consents/receipt','/v1/deletion-requests/read','/v1/deletion-requests/query',
]);
// These endpoints only reduce an existing scope, stop work, remove a selected
// copy, or leave a room. They cannot grant, publish, accept an invitation or send.
const stopPosts=new Set([
  '/v2/watch-controls/stop',
  '/v2/ci/requests/revoke','/v2/ci/proofs/revoke',
  '/v2/chat/attachments/revoke','/v2/chat/shared-summaries/retract',
  '/v2/community/attachments/revoke',
  '/v2/personal-summaries/delete','/v2/choice-snapshots/delete',
  '/v2/information/watches/stop',
]);
const roomStop=new RegExp(`^/v2/chat/rooms/${uuid}/(?:leave|agent-revoke)$`);
const messageStop=new RegExp(`^/v2/chat/rooms/${uuid}/messages/${uuid}/(?:retract|hide)$`);

// Takeout returns ordinary current projections. A new session or export ticket
// does not revive a revoked/expired source, and reading does not extend TTL.
const readPosts=new Set([
  '/v1/data-exports/binary',
  '/v2/receipt-status/query',
  '/v2/watch-controls/query','/v2/watch-controls/read','/v2/watch-controls/receipt',
  '/v2/tasks/query','/v2/tasks/receipt','/v2/cases/events/receipt',
  '/v2/history/query','/v2/search/query','/v2/search/reference',
  '/v2/discovery/query','/v2/discovery/detail',
  '/v2/configurations/read','/v2/configurations/query','/v2/configurations/versions','/v2/configurations/receipt',
  '/v2/verification-records/read','/v2/verification-records/status','/v2/verification-records/receipt',
  '/v2/ci/requests/read','/v2/ci/receipts','/v2/ci/proofs/read',
  '/v2/context/query','/v2/context/receipt',
  '/v2/experience/read','/v2/qualification/evaluate','/v2/qualification/candidates',
  '/v2/qualification/calculation-owned','/v2/qualification/calculation-receipt',
  '/v2/qualification/permission-requests/read','/v2/qualification/permission-requests/query','/v2/qualification/permission-requests/receipt',
  '/v2/capsules/read','/v2/capsules/query','/v2/capsules/uses/query','/v2/capsules/versions',
  '/v2/capsules/receipt','/v2/capsules/permissions/read','/v2/capsules/permissions/query',
  '/v2/contributions/status','/v2/contributions/read',
  '/v2/honor/query','/v2/honor/ranking','/v2/requester-history/query','/v2/requester-history/facts',
  '/v2/recruitment/query','/v2/contacts/query','/v2/projects/query',
  '/v2/comments/query','/v2/comments/receipt','/v2/comment-governance/query','/v2/comment-governance/receipt',
  '/v2/personal-summaries/preferences/read','/v2/personal-summaries/get','/v2/personal-summaries/receipt','/v2/personal-summaries/list','/v2/personal-summaries/sources',
  '/v2/choice-snapshots/preferences/read','/v2/choice-snapshots/get','/v2/choice-snapshots/list','/v2/choice-snapshots/receipt',
  '/v2/notifications/query','/v2/notifications/options/read',
  '/v2/chat/rooms/query','/v2/chat/invitations/query','/v2/chat/export/owned',
  '/v2/chat/rooms/directory','/v2/chat/accounts/query',
  '/v1/account/bookmarks/status','/v1/account/bookmarks/query','/v1/account/bookmarks/receipt',
  '/v2/account-bookmarks/status','/v2/account-bookmarks/query','/v2/account-bookmarks/receipt',
  '/v2/community/attachments/config','/v2/community/attachments/read','/v2/community/attachments/query',
  '/v2/chat/shared-summaries/get','/v2/chat/shared-summaries/list','/v2/chat/shared-summaries/receipt',
  '/v2/chat/attachments/config','/v2/chat/attachments/read','/v2/chat/attachments/query',
  '/v1/builders/manage/read','/v1/builders/owned/query','/v1/builders/events/receipt','/v1/builders/notices/query',
  '/v1/builders/node-control/export','/v2/builders/support/read','/v2/builders/pack/export',
  '/v2/builders/pack/manifest','/v2/builders/pack-uses/candidates','/v2/builders/pack-uses/query','/v2/builders/pack-uses/read','/v2/builders/pack-uses/receipt',
  '/v2/trust-package/permissions/receipt','/v2/trust-package/permissions/status','/v2/trust-package/permissions/query',
  '/v2/hubs/status','/v2/hubs/read','/v2/hubs/manage','/v2/hubs/query','/v2/hubs/memberships','/v2/hubs/intake','/v2/hubs/receipt',
  '/v2/hubs/peering/read','/v2/hubs/peering/list','/v2/hubs/peering/receipt','/v2/hubs/peering/connections','/v2/hubs/peering/party',
]);
const readGets=new RegExp(`^/v2/(?:tasks|projects|contacts|recruitment|comments)/${uuid}$|^/v2/tasks$|^/v2/context/${uuid}(?:/metadata)?$|^/v2/comment-governance/(?:${uuid}|config)$`);
const honorGet=/^\/v2\/honor\/GUID[0-9A-Z]{28}\/[a-z0-9][a-z0-9._-]{0,79}\/[0-9]+(?:\.[0-9]+){0,2}$/;
const caseRead=new RegExp(`^/v2/cases/${uuid}/read$`);
const taskCaseLinkReceipt=new RegExp(`^/v2/tasks/${uuid}/case-link/receipt$`);
const taskOwnerRead=new RegExp(`^/v2/tasks/${uuid}/owner-read(?:/prepare)?$`);
const taskOwnerControlPrepare=new RegExp(`^/v2/tasks/${uuid}/owner-control/prepare$`);
const moderationReceipt=new RegExp(`^/v1/moderation/reports/${uuid}/receipt$`);
const roomRead=new RegExp(`^/v2/chat/rooms/${uuid}/(?:read|history|decisions|receipt|agent-grants|agent-participants|join-preview)$`);
const projectPreferences=new RegExp(`^/v2/projects/${uuid}/preferences/read$`);
const attachmentExport=new RegExp(`^/v2/chat/attachments/${uuid}/export-content$`);
const sourceAttachmentRead=new RegExp(`^/v2/(?:chat|community)/attachments/${uuid}/content$`);
const recruitmentReceipt=new RegExp(`^/v2/recruitment/${uuid}/receipt$`);

export function serviceAccessV2(method,path){
  if(method==='GET'&&(controlState.test(path)||bindingRead.test(path)||path==='/v1/consents'))return 'control';
  if(method==='POST'&&controlPosts.has(path))return 'control';
  if(method==='POST'&&(stopPosts.has(path)||roomStop.test(path)||messageStop.test(path)))return 'stop';
  if(method==='POST'&&(readPosts.has(path)||caseRead.test(path)||taskCaseLinkReceipt.test(path)||taskOwnerRead.test(path)||taskOwnerControlPrepare.test(path)||moderationReceipt.test(path)||roomRead.test(path)||projectPreferences.test(path)||attachmentExport.test(path)||sourceAttachmentRead.test(path)))return 'read';
  if(method==='GET'&&(readGets.test(path)||honorGet.test(path)||recruitmentReceipt.test(path)))return 'read';
  return null;
}
