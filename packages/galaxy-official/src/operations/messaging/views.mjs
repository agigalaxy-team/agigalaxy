import {hasOperationsPermission} from '../../operations-permission-catalog.mjs';

export const messagingStamp=value=>value?new Date(value).toISOString():null;
const approval=row=>({kind:row.approved_ai?'operations-ai-service':'business-operator',operatorId:row.approved_by,role:row.approved_role,
 ...(row.approved_ai?{aiAccountId:row.approved_ai.aiAccountId,domain:row.approved_ai.domain,taskId:row.approved_ai.taskId,operationId:row.approved_ai.operation?.operationId??null}:{})});
export const messagingAudienceAvailability=Object.freeze({source:'configured-business-database',availableAttributes:Object.freeze(['subject-type']),unavailableAttributes:Object.freeze(['level','honor']),organizationScope:'account-only',upstreamDirectoryAudience:'not-connected'});
export const messagingStates=Object.freeze(['pending','submitting','submitted','delivered','skipped','failed','unknown','blocked']);
// Same current, endpoint-bound public account metadata as the existing
// notices.read recipient view. This does not select recipients or resolve
// upstream identities; the immutable saved audience remains unchanged.
export async function messagingAudienceAccountsWithin(db,config,endpoint){
 if(config.audience.kind!=='accounts')return {state:'not-applicable',items:[]};
 const rows=(await db.query(`SELECT a.id,a.uid,p.display_name FROM community_accounts a
  LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id
  WHERE a.endpoint=$1 AND a.id=ANY($2::uuid[])`,[endpoint,config.audience.accountIds])).rows;
 const found=new Map(rows.map(row=>[row.id,row]));
 return {state:'available',items:config.audience.accountIds.map(accountId=>{
  const row=found.get(accountId);return {accountId,uid:row?.uid??null,displayName:row?.display_name??null,state:row?'available':'unavailable'};
 })};
}
export function messagingDeliveryCounts(rows){
 const channels=Object.fromEntries(['inapp','email'].map(channel=>[channel,{total:0,...Object.fromEntries(messagingStates.map(state=>[state,0]))}]));
 for(const row of rows){if(!channels[row.channel]||!messagingStates.includes(row.state))continue;const count=Number(row.count);channels[row.channel][row.state]+=count;channels[row.channel].total+=count;}
 // SMTP acceptance and the current in-app receipt are different facts.
 return {...channels,email:{...channels.email,delivered:null,bounced:null,opened:null,clicked:null,receipts:'not-connected'}};
}
export async function messagingRunViewWithin(db,row,now){
 const counts=messagingDeliveryCounts((await db.query(`SELECT channel,state,count(*)::integer AS count FROM operations_messaging_recipients_v1 WHERE run_id=$1 GROUP BY channel,state`,[row.id])).rows);
 const announcement=(await db.query('SELECT id,published_at,expires_at,withdrawn_at FROM operations_messaging_announcements_v1 WHERE run_id=$1',[row.id])).rows[0];
 return {id:row.id,sequence:String(row.sequence),planId:row.plan_id,planVersion:row.plan_version,revision:row.revision,state:row.state,
  occurrenceId:row.occurrence_key,scheduledAt:null,createdAt:messagingStamp(row.created_at),updatedAt:messagingStamp(row.updated_at),completedAt:messagingStamp(row.completed_at),
  audience:{accountCount:row.audience_count,frozenAt:messagingStamp(row.frozen_at),additionalTargetsAllowed:false},
  approval:approval(row),delivery:counts,errorCode:row.error_code??null,jobId:row.job_id??null,
  announcement:announcement?{id:announcement.id,state:announcement.withdrawn_at?'withdrawn':new Date(announcement.expires_at).getTime()<=now*1000?'expired':'published',
   audience:'public',publishedAt:messagingStamp(announcement.published_at),expiresAt:messagingStamp(announcement.expires_at),withdrawnAt:messagingStamp(announcement.withdrawn_at)}:{id:null,state:'not-published',audience:'public',publishedAt:null,expiresAt:null,withdrawnAt:null}};
}
export function messagingPlanView(row,actor,now=Math.floor(Date.now()/1000)){
 const can=code=>hasOperationsPermission(actor,code),state=row.state,expired=state!=='stopped'&&new Date(row.config.content.expiresAt).getTime()<=now*1000;
 return {id:row.id,sequence:String(row.sequence),version:row.version,revision:row.revision,state,effectiveState:expired?'expired':state,config:row.config,audienceAvailability:messagingAudienceAvailability,
  createdBy:row.created_by,updatedBy:row.updated_by,createdAt:messagingStamp(row.created_at),updatedAt:messagingStamp(row.updated_at),
  approval:row.approved_by?{...approval(row),at:messagingStamp(row.approved_at)}:null,
  scheduling:{engine:'pg-boss',missed:'skip',scheduledAt:row.config.schedule.kind==='once'?row.config.schedule.at:null,occurrenceTimeRecorded:false},
  capabilities:{canSave:can('notices.update')&&state!=='active',canActivate:can('notices.publish')&&state==='draft'&&!expired,canPause:can('notices.withdraw')&&state==='active'&&!expired,
   canResume:can('notices.publish')&&state==='paused'&&!expired,canStop:can('notices.withdraw')&&['active','paused'].includes(state),canWithdraw:can('notices.withdraw')},
  jobId:row.job_id??null};
}
export async function messagingRecipientViewWithin(db,row){
 const account=(await db.query(`SELECT a.id,a.uid,p.subject_type,p.display_name FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`,[row.account_id,row.endpoint])).rows[0];
 const attempts=(await db.query('SELECT id,attempt_number,state,error_code,started_at,finished_at FROM operations_messaging_attempts_v1 WHERE recipient_id=$1 ORDER BY attempt_number',[row.id])).rows;
 return {id:row.id,sequence:String(row.sequence),account:{accountId:row.account_id,uid:account?.uid??null,subjectType:account?.subject_type??null,displayName:account?.display_name??null,state:account?'available':'unavailable'},
  channel:row.channel,state:row.state,attemptCount:row.attempt_count,deferred:row.state==='pending'&&!!row.retry_at&&['smtp_rate_limited','smtp_concurrency_limited'].includes(row.error_code),errorCode:row.error_code??null,retryable:row.retryable===true,
  messageId:row.message_id??null,leaseUntil:messagingStamp(row.lease_until),retryAt:messagingStamp(row.retry_at),submittedAt:messagingStamp(row.submitted_at),completedAt:messagingStamp(row.completed_at),
  attempts:attempts.map(attempt=>({id:attempt.id,number:attempt.attempt_number,state:attempt.state,networkAttempt:!['smtp_rate_limited','smtp_concurrency_limited'].includes(attempt.error_code),errorCode:attempt.error_code??null,startedAt:messagingStamp(attempt.started_at),finishedAt:messagingStamp(attempt.finished_at)}))};
}
