import {randomUUID} from "node:crypto";
import {transaction} from "../../infrastructure/database.mjs";
import {messagingDeliveryJobSchema,messagingParse as parse} from "../../shared/operations-messaging-schema.mjs";
import {messagingRunViewWithin} from "./views.mjs";
import {messagingRecoveryPolicy,safeProviderCodes,fail,iso,messageId} from './policy.mjs';
import {MessagingExecution} from './execution.mjs';

// Current recipient eligibility, submission claims, DATA gates and truthful immutable attempt outcomes.
export class OperationsMessagingService extends MessagingExecution{
 async recipientEligibilityWithin(db,run,recipient,{directory=true}={}){
  const row=(await db.query(`SELECT a.id,a.endpoint,a.issuer,a.external_subject,a.uid,p.subject_type FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`,[recipient.account_id,this.endpoint])).rows[0];
  if(!row)return {state:'skipped',code:'operations_messaging_recipient_unavailable'};
  const audience=run.config.audience;
  if(audience.kind==='accounts'&&!audience.accountIds.includes(row.id)||audience.kind==='attributes'&&!audience.subjectTypes.includes(row.subject_type))return {state:'skipped',code:'operations_messaging_recipient_ineligible'};
  if(directory){
   const identity=await this.businessAdmin.identityFor(row);
   if(identity.state!=='available')return {state:'blocked',code:identity.state==='not-found'?'operations_messaging_recipient_unavailable':'operations_messaging_directory_unavailable'};
   if(identity.enabled!==true)return {state:'skipped',code:'operations_messaging_recipient_disabled'};
  }
  return {state:'eligible',code:null};
 }
 async assertSubmission(runId,recipientId,attemptId){
  return transaction(this.db,async db=>{
   let run=await this.runWithin(db,runId);await this.runtimeWithin(db,run);run=await this.runWithin(db,runId,{lock:true});
   const recipient=(await db.query(`SELECT * FROM operations_messaging_recipients_v1 WHERE id=$1 AND run_id=$2 FOR UPDATE`,[recipientId,runId])).rows[0];
   if(!recipient||recipient.state!=='submitting'||recipient.attempt_id!==attemptId||new Date(recipient.lease_until).getTime()<=this.now()*1000)fail('operations_messaging_attempt_changed');
   const eligible=await this.recipientEligibilityWithin(db,run,recipient);
   if(eligible.state!=='eligible')fail(eligible.code,eligible.state==='blocked'?503:403);
   await this.runtimeWithin(db,run);return {authorized:true};
  });
 }
 async recoverSubmissionsWithin(db,runId){
  const rows=(await db.query(`UPDATE operations_messaging_recipients_v1 SET state='unknown',retryable=false,retry_at=NULL,error_code='operations_messaging_submission_unconfirmed',completed_at=$2,updated_at=$2 WHERE run_id=$1 AND state='submitting' AND lease_until<=$2 RETURNING attempt_id`,[runId,iso(this.now())])).rows;
  for(const row of rows)if(row.attempt_id)await db.query(`UPDATE operations_messaging_attempts_v1 SET state='unknown',error_code='operations_messaging_submission_unconfirmed',finished_at=$2 WHERE id=$1 AND state='submitting'`,[row.attempt_id,iso(this.now())]);
  return rows.length;
 }
 async claim(runId){
  const providerStatus=await this.senderStatus();
  return transaction(this.db,async db=>{
   let run=await this.runWithin(db,runId);const {actor}=await this.runtimeWithin(db,run);run=await this.runWithin(db,runId,{lock:true});
   await this.recoverSubmissionsWithin(db,runId);
   const row=(await db.query(`SELECT * FROM operations_messaging_recipients_v1 WHERE run_id=$1 AND (state='pending' AND (retry_at IS NULL OR retry_at<=$2) OR state='failed' AND retryable=true AND retry_at<=$2 AND attempt_count<$3) ORDER BY sequence LIMIT 1 FOR UPDATE`,[runId,iso(this.now()),messagingRecoveryPolicy.maxSubmitAttempts])).rows[0];
   if(!row)return null;
   const eligibility=await this.recipientEligibilityWithin(db,run,row);
   await this.runtimeWithin(db,run);
   if(eligibility.state!=='eligible'){
    await db.query(`UPDATE operations_messaging_recipients_v1 SET state=$2,error_code=$3,retryable=false,completed_at=$4,updated_at=$4 WHERE id=$1`,[row.id,eligibility.state,eligibility.code,iso(this.now())]);
    await db.query('UPDATE operations_messaging_runs_v1 SET revision=revision+1,updated_at=$2 WHERE id=$1',[runId,iso(this.now())]);return {processed:true};
   }
   if(row.channel==='inapp'){
    const at=iso(this.now());
    // The existing notice endpoint may independently withdraw this run-owned
    // in-app publication. A current plan never revives that channel's source.
    const notice=(await db.query('SELECT state,expires_at FROM operations_notices_v1 WHERE id=$1 AND endpoint=$2 FOR UPDATE',[runId,this.endpoint])).rows[0];
    if(!notice||!['queued','delivering','delivered'].includes(notice.state)||new Date(notice.expires_at).getTime()<=this.now()*1000){
     await db.query(`UPDATE operations_messaging_recipients_v1 SET state='skipped',retryable=false,error_code='operations_messaging_inapp_source_unavailable',completed_at=$2,updated_at=$2 WHERE id=$1`,[row.id,at]);
     await db.query('UPDATE operations_messaging_runs_v1 SET revision=revision+1,updated_at=$2 WHERE id=$1',[runId,at]);return {processed:true};
    }
    await db.query('UPDATE account_operations_notices_v1 SET delivered_at=COALESCE(delivered_at,$3) WHERE notice_id=$1 AND account_id=$2',[runId,row.account_id,at]);
    await db.query(`UPDATE operations_messaging_recipients_v1 SET state='delivered',retryable=false,completed_at=$2,updated_at=$2 WHERE id=$1`,[row.id,at]);
    await db.query(`UPDATE operations_notices_v1 SET state='delivering',last_attempt_at=$2,updated_at=$2 WHERE id=$1 AND state IN ('queued','delivering')`,[runId,at]);
    await db.query('UPDATE operations_messaging_runs_v1 SET revision=revision+1,updated_at=$2 WHERE id=$1',[runId,at]);
    await this.businessAdmin.recordWithin(db,actor,'notice-delivery',{accountId:row.account_id,selection:{kind:'inapp-delivery',planId:run.plan_id,runId,recipientId:row.id,planVersion:run.plan_version,channel:'inapp'},result:{state:'delivered'}});
    return {processed:true};
   }
   if(providerStatus.state!=='configured'||!providerStatus.enabled||typeof this.mailProvider?.submit!=='function'){
    await db.query(`UPDATE operations_messaging_recipients_v1 SET state='blocked',error_code='smtp_not_configured',retryable=false,updated_at=$2 WHERE id=$1`,[row.id,iso(this.now())]);
    await db.query('UPDATE operations_messaging_runs_v1 SET revision=revision+1,updated_at=$2 WHERE id=$1',[runId,iso(this.now())]);return {processed:true};
   }
   // Local capacity deferrals remain in history but do not spend the bounded
   // network-attempt budget. Their immutable record number is independent.
   const attemptId=randomUUID(),number=Number((await db.query('SELECT COALESCE(max(attempt_number),0)+1 AS number FROM operations_messaging_attempts_v1 WHERE recipient_id=$1',[row.id])).rows[0].number),networkNumber=row.attempt_count+1,at=iso(this.now()),id=row.message_id??messageId(this.endpoint,runId,row.account_id);
   await db.query(`INSERT INTO operations_messaging_attempts_v1(id,recipient_id,attempt_number,state,started_at) VALUES($1,$2,$3,'submitting',$4)`,[attemptId,row.id,number,at]);
   await db.query(`UPDATE operations_messaging_recipients_v1 SET state='submitting',attempt_id=$2,attempt_count=$3,message_id=$4,lease_until=$5,retry_at=NULL,retryable=false,error_code=NULL,completed_at=NULL,updated_at=$6 WHERE id=$1`,[row.id,attemptId,networkNumber,id,iso(this.now()+messagingRecoveryPolicy.submissionLeaseSeconds),at]);
   await db.query('UPDATE operations_messaging_runs_v1 SET revision=revision+1,updated_at=$2 WHERE id=$1',[runId,at]);
   return {runId,recipientId:row.id,accountId:row.account_id,attemptId,messageId:id,config:run.config,actor,planId:run.plan_id,planVersion:run.plan_version};
  });
 }
 providerResult(result){
  if(!result||!['submitted','not-configured','ineligible','failed','unknown'].includes(result.submission))return {submission:'unknown',code:'operations_messaging_submission_unconfirmed',retryable:false};
  const retryTime=typeof result.retryAt==='string'?Date.parse(result.retryAt):NaN;
  const localDeferred=result.submission==='failed'&&result.retryable===true&&result.notSubmitted===true&&['smtp_rate_limited','smtp_concurrency_limited'].includes(result.code)
   &&Number.isFinite(retryTime)&&retryTime<=this.now()*1000+86400000;
  return {submission:result.submission,code:safeProviderCodes.has(result.code)?result.code:result.submission==='submitted'?null:'operations_messaging_provider_'+result.submission.replace('-','_'),retryable:result.submission==='failed'&&result.retryable===true,
   localDeferred,retryAt:localDeferred?new Date(Math.max(retryTime,(this.now()+1)*1000)).toISOString():null};
 }
 async settle(claim,result){
  const safe=this.providerResult(result);
  return transaction(this.db,async db=>{
   const run=await this.runWithin(db,claim.runId,{lock:true});
   const row=(await db.query('SELECT * FROM operations_messaging_recipients_v1 WHERE id=$1 AND run_id=$2 FOR UPDATE',[claim.recipientId,claim.runId])).rows[0];
   if(!row||row.attempt_id!==claim.attemptId||!['submitting','unknown'].includes(row.state))return {state:'not-recorded'};
   const at=iso(this.now()),state=safe.localDeferred?'pending':safe.submission==='submitted'?'submitted':safe.submission==='ineligible'?'skipped':safe.submission==='not-configured'?'blocked':safe.submission;
   const retryable=safe.localDeferred||safe.retryable&&row.attempt_count<messagingRecoveryPolicy.maxSubmitAttempts;
   const retryAt=safe.localDeferred?safe.retryAt:retryable?iso(this.now()+Math.min(messagingRecoveryPolicy.retryDelayMaxSeconds,messagingRecoveryPolicy.retryDelaySeconds*2**(row.attempt_count-1))):null;
   await db.query(`UPDATE operations_messaging_attempts_v1 SET state=$2,error_code=$3,finished_at=$4 WHERE id=$1`,[claim.attemptId,safe.submission,safe.code,at]);
   await db.query(`UPDATE operations_messaging_recipients_v1 SET state=$2,error_code=$3,retryable=$4,retry_at=$5,lease_until=NULL,attempt_count=CASE WHEN $7 THEN GREATEST(0,attempt_count-1) ELSE attempt_count END,submitted_at=CASE WHEN $2='submitted' THEN $6 ELSE submitted_at END,completed_at=CASE WHEN $4 THEN NULL ELSE $6 END,updated_at=$6 WHERE id=$1`,[row.id,state,safe.code,retryable,retryAt,at,safe.localDeferred]);
   await db.query('UPDATE operations_messaging_runs_v1 SET revision=revision+1,updated_at=$2 WHERE id=$1',[run.id,at]);
   // Persist the actual outcome even if pause/revocation happened after DATA.
   // Attribution is the real approval used at this attempt, never a fake AI.
   await this.businessAdmin.recordWithin(db,claim.actor,'notice-delivery',{accountId:row.account_id,selection:{kind:'email-submission',planId:claim.planId,runId:run.id,recipientId:row.id,planVersion:claim.planVersion,channel:'email'},result:{submission:safe.submission,retryable,errorCode:safe.code}});
   return {state};
  });
 }
 async finalize(runId){
  return transaction(this.db,async db=>{
   const run=await this.runWithin(db,runId,{lock:true}),plan=await this.planWithin(db,run.plan_id,{lock:true});await this.recoverSubmissionsWithin(db,runId);
   const stats=(await db.query(`SELECT count(*) FILTER(WHERE state='pending' OR state='failed' AND retryable OR state='submitting')::integer AS pending,count(*) FILTER(WHERE state='blocked')::integer AS blocked,count(*) FILTER(WHERE state IN ('failed','unknown'))::integer AS issues,
    min(CASE WHEN state='submitting' THEN lease_until WHEN state='failed' AND retryable THEN retry_at WHEN state='pending' THEN COALESCE(retry_at,$2::timestamptz) END) AS next_at FROM operations_messaging_recipients_v1 WHERE run_id=$1`,[runId,iso(this.now())])).rows[0];
   const expired=new Date(run.config.content.expiresAt).getTime()<=this.now()*1000;
   const state=plan.version!==run.plan_version||plan.state==='stopped'?'cancelled':expired?'expired':plan.state==='paused'?'paused':stats.pending?'running':stats.blocked?'blocked':'completed';
   const error=expired?'operations_messaging_expired':stats.issues?'operations_messaging_results_incomplete':stats.blocked?'operations_messaging_recipients_blocked':null;
   await db.query(`UPDATE operations_messaging_runs_v1 SET state=$2,error_code=$3,revision=revision+1,updated_at=$4,completed_at=CASE WHEN $2 IN ('completed','cancelled','expired') THEN COALESCE(completed_at,$4) ELSE NULL END WHERE id=$1`,[runId,state,error,iso(this.now())]);
   if(expired)await db.query(`UPDATE operations_messaging_recipients_v1 SET state='skipped',retryable=false,retry_at=NULL,error_code='operations_messaging_expired',completed_at=$2,updated_at=$2 WHERE run_id=$1 AND (state IN ('pending','blocked') OR state='failed' AND retryable)`,[runId,iso(this.now())]);
   if(state==='running'&&stats.next_at)await this.enqueueDelivery(db,runId,'continue:'+(run.revision+1),new Date(Math.min(new Date(stats.next_at).getTime(),new Date(run.config.content.expiresAt).getTime())).toISOString());
   if(!stats.pending)await db.query(`UPDATE operations_notices_v1 SET state='delivered',updated_at=$2 WHERE id=$1 AND state IN ('queued','delivering')`,[runId,iso(this.now())]);
   return {run:await messagingRunViewWithin(db,await this.runWithin(db,runId),this.now())};
  });
 }
 async deliver(input,context={}){
  const x=parse(messagingDeliveryJobSchema,input);let processed=0;
  try{
   for(;processed<messagingRecoveryPolicy.pageSize;processed++){
    if(context.signal?.aborted)break;
    const claim=await this.claim(x.runId);if(!claim)break;if(claim.processed)continue;
    let result;
    try{result=await this.mailProvider.submit({accountId:claim.accountId,messageId:claim.messageId,senderKey:claim.config.senderKey,subject:claim.config.content.title,title:claim.config.content.title,paragraphs:claim.config.content.body.split(/\n\s*\n/),language:'zh-CN',authorize:()=>{if(context.signal?.aborted)fail('operations_messaging_execution_interrupted');return this.assertSubmission(claim.runId,claim.recipientId,claim.attemptId);}});}
    catch{result={submission:'unknown',code:'operations_messaging_submission_unconfirmed',retryable:false};}
    await this.settle(claim,result);
   }
  }catch(error){
   const codes=new Set(['operations_messaging_paused','operations_messaging_stopped','operations_messaging_expired','operations_messaging_version_changed','operations_messaging_approval_unavailable','operations_permission_denied','business_admin_denied','operations_authorization_unavailable']);
   if(!codes.has(error.code))throw error;
   await transaction(this.db,async db=>{await this.runWithin(db,x.runId,{lock:true});await db.query(`UPDATE operations_messaging_runs_v1 SET state=$2,error_code=$3,revision=revision+1,updated_at=$4 WHERE id=$1`,[x.runId,error.code==='operations_messaging_paused'?'paused':error.code==='operations_messaging_expired'?'expired':['operations_messaging_stopped','operations_messaging_version_changed'].includes(error.code)?'cancelled':'blocked',error.code,iso(this.now())]);if(error.code==='operations_messaging_expired')await db.query(`UPDATE operations_messaging_recipients_v1 SET state='skipped',retryable=false,retry_at=NULL,error_code=$2,completed_at=$3,updated_at=$3 WHERE run_id=$1 AND (state IN ('pending','blocked') OR state='failed' AND retryable)`,[x.runId,error.code,iso(this.now())]);});
   return {processed,run:await messagingRunViewWithin(this.db,await this.runWithin(this.db,x.runId),this.now())};
  }
  return {processed,...await this.finalize(x.runId)};
 }
}
