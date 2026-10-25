import {z} from "zod";
import {hasOperationsPermission} from "../../operations-permission-catalog.mjs";
import {messagingPlansQuerySchema,messagingRunsQuerySchema,messagingRecipientsQuerySchema,messagingPageSchema,messagingParse as parse} from "../../shared/operations-messaging-schema.mjs";
import {messagingStamp as stamp,messagingPlanView,messagingRunViewWithin,messagingRecipientViewWithin,messagingDeliveryCounts,messagingAudienceAvailability,messagingAudienceAccountsWithin} from "./views.mjs";
import {messagingRecoveryPolicy,fail,iso} from './policy.mjs';
import {MessagingBase} from './base.mjs';
import {messagingCommandResult} from '../command-receipts.mjs';

// Controlled plan/run/history/recipient reads and currently published public announcements.
export class MessagingReadModel extends MessagingBase{
 commandResult(operator,operationId){
  const authority=this.businessAdmin.executorAuthority;
  return messagingCommandResult({db:this.db,endpoint:this.endpoint,operator,authorize:actor=>this.businessAdmin.authorizeAction(actor,'notices.read'),
   sameActor:(a,b,endpoint)=>a?.endpoint===endpoint&&a.operatorId===b?.operatorId&&(a.kind==='business-operator'&&b.kind==='business-operator'||authority?.acceptsDuty?.(a)&&authority.acceptsDuty(b)&&a.taskId===b.taskId),now:this.now},operationId);
 }
 async list(operator,input={}){
  const actor=await this.businessAdmin.authorizeAction(operator,'notices.read'),q=parse(messagingPlansQuerySchema,input);
  const rows=(await this.db.query(`SELECT p.*,v.config FROM operations_messaging_plans_v1 p JOIN operations_messaging_versions_v1 v ON v.plan_id=p.id AND v.version=p.version WHERE p.endpoint=$1 AND ($2::bigint IS NULL OR p.sequence<$2) AND ($3::text IS NULL OR p.state=$3) ORDER BY p.sequence DESC LIMIT $4`,[this.endpoint,q.after??null,q.state??null,q.limit+1])).rows;
  const legacy=Number((await this.db.query('SELECT count(*) AS count FROM operations_notices_v1 n WHERE endpoint=$1 AND NOT EXISTS(SELECT 1 FROM operations_messaging_runs_v1 r WHERE r.id=n.id)',[this.endpoint])).rows[0].count);
  const sender=await this.senderStatus(),summary=await this.overviewWithin(this.db,q.state??null);await this.businessAdmin.authorizeAction(actor,'notices.read');
  return {items:rows.slice(0,q.limit).map(row=>messagingPlanView(row,actor,this.now())),nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null,
   capabilities:{canCreate:hasOperationsPermission(actor,'notices.create')},audienceAvailability:messagingAudienceAvailability,summary,sender,legacy:{source:'operations-notices',count:legacy,historyPreserved:true},metadataOnly:false,checkedAt:this.now(),readExpiresAt:this.now()+30};
 }
 async overviewWithin(db,state=null){
  const planRows=(await db.query(`SELECT state,count(*)::integer AS count FROM operations_messaging_plans_v1 WHERE endpoint=$1 AND ($2::text IS NULL OR state=$2) GROUP BY state`,[this.endpoint,state])).rows;
  const runRows=(await db.query(`SELECT r.state,count(*)::integer AS count FROM operations_messaging_runs_v1 r JOIN operations_messaging_plans_v1 p ON p.id=r.plan_id WHERE r.endpoint=$1 AND ($2::text IS NULL OR p.state=$2) GROUP BY r.state`,[this.endpoint,state])).rows;
  const recipientRows=(await db.query(`SELECT x.channel,x.state,count(*)::integer AS count FROM operations_messaging_recipients_v1 x JOIN operations_messaging_runs_v1 r ON r.id=x.run_id JOIN operations_messaging_plans_v1 p ON p.id=r.plan_id WHERE r.endpoint=$1 AND ($2::text IS NULL OR p.state=$2) GROUP BY x.channel,x.state`,[this.endpoint,state])).rows;
  const groups=(rows,keys)=>{const value={total:0,...Object.fromEntries(keys.map(key=>[key,0]))};for(const row of rows){if(!keys.includes(row.state))continue;value[row.state]=row.count;value.total+=row.count;}return value;};
  return {scope:'matching-plans-all-runs',plans:groups(planRows,['draft','active','paused','stopped']),runs:groups(runRows,['running','paused','blocked','completed','cancelled','expired']),delivery:messagingDeliveryCounts(recipientRows)};
 }
 async get(operator,id){
  const actor=await this.businessAdmin.authorizeAction(operator,'notices.read'),row=await this.planWithin(this.db,id);
  const history=await this.historyWithin(this.db,id,{limit:30});
  const runs=(await this.db.query(`SELECT r.* FROM operations_messaging_runs_v1 r WHERE r.plan_id=$1 ORDER BY sequence DESC LIMIT 10`,[id])).rows;
   const result={plan:messagingPlanView(row,actor,this.now()),history,audienceAccounts:await messagingAudienceAccountsWithin(this.db,row.config,this.endpoint),
   recentRuns:await Promise.all(runs.map(run=>messagingRunViewWithin(this.db,run,this.now()))),sender:await this.senderStatus(),checkedAt:this.now(),readExpiresAt:this.now()+30};
  await this.businessAdmin.authorizeAction(actor,'notices.read');return result;
 }
 async historyWithin(db,id,input={}){
  const q=parse(messagingPageSchema,input),rows=(await db.query(`SELECT e.id,e.sequence,e.operator_id,e.operator_role,e.actor_kind,e.ai_context,e.kind,e.version,e.revision,e.created_at,COALESCE(NULLIF(BTRIM(o.display_name),''),a.name) AS operator_display_name
   FROM operations_messaging_events_v1 e JOIN operations_messaging_plans_v1 p ON p.id=e.plan_id AND p.endpoint=$4
   LEFT JOIN operations_operator_principals_v1 o ON o.operator_id=e.operator_id AND o.endpoint=p.endpoint
   LEFT JOIN operations_ai_work_accounts_v1 a ON a.id::text=e.ai_context->>'aiAccountId' AND a.endpoint=p.endpoint
   WHERE e.plan_id=$1 AND ($2::bigint IS NULL OR e.sequence<$2) ORDER BY e.sequence DESC LIMIT $3`,[id,q.after??null,q.limit+1,this.endpoint])).rows;
  return {items:rows.slice(0,q.limit).map(event=>({id:event.id,sequence:String(event.sequence),operatorId:event.operator_id,operatorDisplayName:event.operator_display_name??null,operatorRole:event.operator_role,actorKind:event.actor_kind,aiAccountId:event.ai_context?.aiAccountId??null,taskId:event.ai_context?.taskId??null,kind:event.kind,version:event.version,revision:event.revision,createdAt:stamp(event.created_at)})),nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null};
 }
 async history(operator,id,input={}){const actor=await this.businessAdmin.authorizeAction(operator,'notices.read');await this.planWithin(this.db,id);const result=await this.historyWithin(this.db,id,input);await this.businessAdmin.authorizeAction(actor,'notices.read');return {...result,checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};}
 async runs(operator,input={}){
  const actor=await this.businessAdmin.authorizeAction(operator,'notices.read'),q=parse(messagingRunsQuerySchema,input);
  const rows=(await this.db.query(`SELECT * FROM operations_messaging_runs_v1 WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) AND ($3::uuid IS NULL OR plan_id=$3) ORDER BY sequence DESC LIMIT $4`,[this.endpoint,q.after??null,q.planId??null,q.limit+1])).rows;
  const items=await Promise.all(rows.slice(0,q.limit).map(run=>messagingRunViewWithin(this.db,run,this.now())));await this.businessAdmin.authorizeAction(actor,'notices.read');
  return {items,nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null,metadataOnly:true,checkedAt:this.now(),readExpiresAt:this.now()+30};
 }
 async run(operator,id){
  const actor=await this.businessAdmin.authorizeAction(operator,'notices.read'),row=await this.runWithin(this.db,id),head=await this.planWithin(this.db,row.plan_id);
  const eligible=Number((await this.db.query(`SELECT count(*) AS count FROM operations_messaging_recipients_v1 WHERE run_id=$1 AND (state='blocked' OR state='failed' AND retryable) AND attempt_count<$2`,[id,messagingRecoveryPolicy.maxSubmitAttempts])).rows[0].count);
  const result={run:await messagingRunViewWithin(this.db,row,this.now()),config:row.config,audienceAvailability:messagingAudienceAvailability,capabilities:{canRetry:hasOperationsPermission(actor,'notices.publish')&&head.state==='active'&&head.version===row.plan_version&&new Date(row.config.content.expiresAt).getTime()>this.now()*1000&&eligible>0},
   retryPolicy:{...messagingRecoveryPolicy,unknownResultsRetryable:false},checkedAt:this.now(),readExpiresAt:this.now()+30};await this.businessAdmin.authorizeAction(actor,'notices.read');return result;
 }
 async recipients(operator,runId,input={}){
  const actor=await this.businessAdmin.authorizeAction(operator,'notices.read'),q=parse(messagingRecipientsQuerySchema,input);await this.runWithin(this.db,runId);
  const rows=(await this.db.query(`SELECT r.*,$6::text AS endpoint FROM operations_messaging_recipients_v1 r WHERE r.run_id=$1 AND ($2::bigint IS NULL OR r.sequence>$2) AND ($3::text IS NULL OR r.channel=$3) AND ($4::text IS NULL OR r.state=$4) ORDER BY r.sequence LIMIT $5`,[runId,q.after??null,q.channel??null,q.state??null,q.limit+1,this.endpoint])).rows;
  const items=await Promise.all(rows.slice(0,q.limit).map(row=>messagingRecipientViewWithin(this.db,row)));await this.businessAdmin.authorizeAction(actor,'notices.read');
  return {items,nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null,metadataOnly:true,checkedAt:this.now(),readExpiresAt:this.now()+30};
 }
 async announcements(input={}){
  const q=parse(messagingPageSchema,input),at=iso(this.now());
  const rows=(await this.db.query(`SELECT * FROM operations_messaging_announcements_v1 WHERE endpoint=$1 AND withdrawn_at IS NULL AND expires_at>$2 AND ($3::bigint IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4`,[this.endpoint,at,q.after??null,q.limit+1])).rows;
  return {items:rows.slice(0,q.limit).map(row=>({id:row.id,sequence:String(row.sequence),...row.content,publishedAt:stamp(row.published_at),expiresAt:stamp(row.expires_at),source:'official-announcement'})),nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null,
   checkedAt:this.now(),readExpiresAt:Math.min(this.now()+30,...rows.slice(0,q.limit).map(row=>Math.floor(new Date(row.expires_at).getTime()/1000)))};
 }
 async announcement(id){parse(z.uuid(),id);const row=(await this.db.query(`SELECT * FROM operations_messaging_announcements_v1 WHERE id=$1 AND endpoint=$2 AND withdrawn_at IS NULL AND expires_at>$3`,[id,this.endpoint,iso(this.now())])).rows[0];
  if(!row)fail('operations_announcement_not_found',404);return {announcement:{id:row.id,...row.content,publishedAt:stamp(row.published_at),expiresAt:stamp(row.expires_at),source:'official-announcement'},checkedAt:this.now(),readExpiresAt:Math.min(this.now()+30,Math.floor(new Date(row.expires_at).getTime()/1000))};
 }
}
