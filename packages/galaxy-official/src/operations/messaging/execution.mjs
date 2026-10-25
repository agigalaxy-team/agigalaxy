import {randomUUID} from "node:crypto";
import {z} from "zod";
import {transaction} from "../../database.mjs";
import {messagingJobSchema,messagingParse as parse} from "../../shared/operations-messaging-schema.mjs";
import {messagingRunViewWithin} from "./views.mjs";
import {fail,iso} from './policy.mjs';
import {MessagingPlans} from './plans.mjs';

// One pinned execution, its frozen account audience and native delivery queue continuation.
export class MessagingExecution extends MessagingPlans{
 async enqueueDelivery(db,runId,key,startAfter){
  if(typeof this.jobs?.enqueue!=='function')fail('operations_messaging_scheduler_unavailable',503);
  const id=await this.jobs.enqueue('messaging-delivery',{runId},{key:`messaging:${runId}:${key}`,startAfter,db});await db.query('UPDATE operations_messaging_runs_v1 SET job_id=$2 WHERE id=$1',[runId,id]);return id;
 }
 async stopUnsentWithin(db,planId,code){await db.query(`UPDATE operations_messaging_recipients_v1 x SET state='skipped',retryable=false,retry_at=NULL,error_code=$2,completed_at=$3,updated_at=$3 FROM operations_messaging_runs_v1 r WHERE r.id=x.run_id AND r.plan_id=$1 AND (x.state IN ('pending','blocked') OR x.state='failed' AND x.retryable)`,[planId,code,iso(this.now())]);}
 async execute(input,context={}){
  const x=parse(messagingJobSchema,input);
  return transaction(this.db,async db=>{
   let plan=await this.planWithin(db,x.planId);
   if(plan.version!==x.planVersion||plan.state!=='active')return {state:'not-executed',reason:plan.version!==x.planVersion?'version-changed':plan.state};
   if(new Date(plan.config.content.expiresAt).getTime()<=this.now()*1000){
    if(plan.config.schedule.kind==='recurring')await this.jobs.unschedule('messaging-run','messaging:'+plan.id,{db});
    return {state:'not-executed',reason:'expired'};
   }
   if(plan.config.schedule.kind==='once'&&new Date(plan.config.schedule.at).getTime()>this.now()*1000)return {state:'not-executed',reason:'not-due'};
   await this.approvalActorWithin(db,plan);
   plan=await this.planWithin(db,x.planId,{lock:true});
   if(plan.version!==x.planVersion||plan.state!=='active')return {state:'not-executed',reason:plan.version!==x.planVersion?'version-changed':plan.state};
   const actor=await this.approvalActorWithin(db,plan);
   const occurrence=plan.config.schedule.kind==='recurring'?parse(z.uuid(),context.jobId):'initial';
   const existing=(await db.query('SELECT * FROM operations_messaging_runs_v1 WHERE plan_id=$1 AND plan_version=$2 AND occurrence_key=$3',[plan.id,plan.version,occurrence])).rows[0];
   if(existing){if(['running','blocked','paused'].includes(existing.state))await this.enqueueDelivery(db,existing.id,'replay:'+existing.revision);return {run:await messagingRunViewWithin(db,existing,this.now()),replayed:true};}
   const id=randomUUID(),at=iso(this.now()),config=plan.config;
   await db.query(`INSERT INTO operations_messaging_runs_v1(id,endpoint,plan_id,plan_version,occurrence_key,state,approved_by,approved_role,frozen_at,audience_count,created_at,updated_at,approved_ai) VALUES($1,$2,$3,$4,$5,'running',$6,$7,$8,0,$8,$8,$9)`,[id,this.endpoint,plan.id,plan.version,occurrence,actor.operatorId,actor.role,at,plan.approved_ai?JSON.stringify(plan.approved_ai):null]);
   const channels=config.channels.filter(channel=>channel!=='announcement');
   if(channels.length){
    const audience=config.audience;
    await db.query(`INSERT INTO operations_messaging_recipients_v1(id,run_id,account_id,channel,state,updated_at)
     SELECT gen_random_uuid(),$1,a.id,c.channel,'pending',$2 FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id CROSS JOIN unnest($3::text[]) AS c(channel)
     WHERE a.endpoint=$4 AND ($5::text<>'accounts' OR a.id=ANY($6::uuid[])) AND ($5::text<>'attributes' OR p.subject_type=ANY($7::text[]))`,
    [id,at,channels,this.endpoint,audience.kind,audience.kind==='accounts'?audience.accountIds:[],audience.kind==='attributes'?audience.subjectTypes:[]]);
   }
   const count=Number((await db.query('SELECT count(DISTINCT account_id) AS count FROM operations_messaging_recipients_v1 WHERE run_id=$1',[id])).rows[0].count);
   await db.query('UPDATE operations_messaging_runs_v1 SET audience_count=$2 WHERE id=$1',[id,count]);
   if(config.channels.includes('announcement'))await db.query(`INSERT INTO operations_messaging_announcements_v1(id,endpoint,run_id,plan_id,plan_version,content,published_at,expires_at) VALUES($1,$2,$1,$3,$4,$5,$6,$7)`,[id,this.endpoint,plan.id,plan.version,JSON.stringify(config.content),at,config.content.expiresAt]);
   if(config.channels.includes('inapp')){
    // Only these run-owned rows join the existing account inbox. Legacy notice
    // data, read receipts and the old immediate-delivery worker are untouched.
    await db.query(`INSERT INTO operations_notices_v1(id,endpoint,version,content,state,created_by,updated_by,published_by,published_at,expires_at,audience_count,created_at,updated_at) VALUES($1,$2,1,$3,CASE WHEN $7::integer=0 THEN 'delivered' ELSE 'queued' END,$4,$4,$4,$5,$6,$7,$5,$5)`,
    [id,this.endpoint,JSON.stringify({...config.content,audience:config.audience,messagingRunId:id}),actor.operatorId,at,config.content.expiresAt,count]);
    await db.query(`INSERT INTO account_operations_notices_v1(notice_id,account_id) SELECT run_id,account_id FROM operations_messaging_recipients_v1 WHERE run_id=$1 AND channel='inapp'`,[id]);
   }
   await this.businessAdmin.recordWithin(db,actor,'notice-delivery',{selection:{kind:'run',planId:plan.id,runId:id,planVersion:plan.version},result:{audienceCount:count,state:count?'running':'completed'}});
   if(channels.length&&count)await this.enqueueDelivery(db,id,'start');else await db.query(`UPDATE operations_messaging_runs_v1 SET state='completed',completed_at=$2,updated_at=$2 WHERE id=$1`,[id,at]);
   const run=await this.runWithin(db,id);return {run:await messagingRunViewWithin(db,run,this.now()),replayed:false};
  });
 }
}
