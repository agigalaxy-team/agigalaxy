// Frozen schema129 input. Runtime source mappings must not alter historical SQL.
/** Closed source references from server-frozen proposals, never model prose. */
export const proposalTargetTypeSql=proposal=>`CASE ${proposal}->'target'->>'kind'
 WHEN 'post' THEN 'content-post' WHEN 'reply' THEN 'content-reply' WHEN 'section' THEN 'content-section' WHEN 'account' THEN 'account'
 WHEN 'case' THEN 'community-report' WHEN 'public-case' THEN 'community-report' WHEN 'chat-report' THEN 'chat-report'
 WHEN 'chat-file' THEN 'file-chat' WHEN 'forum-file' THEN 'file-forum' WHEN 'message-plan' THEN 'messaging-plan'
 WHEN 'projects' THEN 'project' WHEN 'methods' THEN 'method' WHEN 'rule' THEN 'rule-key'
 WHEN 'file' THEN CASE ${proposal}->'request'->>'targetKind' WHEN 'chat' THEN 'file-chat' WHEN 'forum' THEN 'file-forum' END
 WHEN 'search-configuration' THEN 'search-quality' WHEN 'recommendation-theme' THEN 'recommendation-policy'
 WHEN 'public-content-batch' THEN NULL ELSE ${proposal}->'target'->>'kind' END`;

