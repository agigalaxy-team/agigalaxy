/** Closed source references from server-frozen proposals, never model prose. */
export const proposalTargetTypeSql=proposal=>`CASE ${proposal}->'target'->>'kind'
 WHEN 'post' THEN 'content-post' WHEN 'reply' THEN 'content-reply' WHEN 'section' THEN 'content-section' WHEN 'account' THEN 'account'
 WHEN 'case' THEN 'community-report' WHEN 'public-case' THEN 'community-report' WHEN 'chat-report' THEN 'chat-report'
 WHEN 'chat-file' THEN 'file-chat' WHEN 'forum-file' THEN 'file-forum' WHEN 'message-plan' THEN 'messaging-plan'
 WHEN 'projects' THEN 'project' WHEN 'methods' THEN 'method' WHEN 'rule' THEN 'rule-key'
 WHEN 'file' THEN CASE ${proposal}->'request'->>'targetKind' WHEN 'chat' THEN 'file-chat' WHEN 'forum' THEN 'file-forum' END
 WHEN 'search-configuration' THEN 'search-quality' WHEN 'recommendation-theme' THEN 'recommendation-policy'
 WHEN 'ai-work-prompt' THEN 'ai-work-account'
 WHEN 'public-content-batch' THEN NULL ELSE ${proposal}->'target'->>'kind' END`;

export const taskSourceRefsSql=(endpoint,task)=>{
 const card=`c.endpoint=${endpoint} AND (c.turn_id=${task} OR EXISTS(SELECT 1 FROM operations_autonomy_workbench_runs_v1 w WHERE w.endpoint=c.endpoint AND w.task_id=${task} AND w.turn_operation_id=c.turn_id))`;
 return`SELECT DISTINCT target_type,target_id FROM operations_autonomy_receipts_v1 WHERE endpoint=${endpoint} AND task_id=${task} AND target_type IS NOT NULL
  UNION SELECT 'content-'||(item->>'kind'),item->>'id' FROM operations_autonomy_receipts_v1 r CROSS JOIN LATERAL jsonb_array_elements(r.details->'items') item WHERE r.endpoint=${endpoint} AND r.task_id=${task}
  UNION SELECT ${proposalTargetTypeSql('o.proposal')},o.proposal->'target'->>'id' FROM operations_ai_duty_operations_v1 o WHERE o.endpoint=${endpoint} AND o.task_id=${task} AND o.kind<>'public-content-batch'
  UNION SELECT 'content-'||(item->>'kind'),item->>'id' FROM operations_ai_duty_operations_v1 o CROSS JOIN LATERAL jsonb_array_elements(o.request->'items') item WHERE o.endpoint=${endpoint} AND o.task_id=${task} AND o.kind='public-content-batch'
  UNION SELECT ${proposalTargetTypeSql('c.proposal')},c.proposal->'target'->>'id' FROM operations_agentos_conversation_cards_v1 c WHERE ${card} AND c.proposal->>'kind'<>'public-content-batch'
  UNION SELECT 'content-'||(item->>'kind'),item->>'id' FROM operations_agentos_conversation_cards_v1 c CROSS JOIN LATERAL jsonb_array_elements(c.proposal->'request'->'items') item WHERE ${card} AND c.proposal->>'kind'='public-content-batch'`;
};
export async function taskSourceRefsWithin(db,endpoint,taskId){return(await db.query(taskSourceRefsSql('$1','$2'),[endpoint,taskId])).rows.filter(r=>r.target_type&&r.target_id);}
