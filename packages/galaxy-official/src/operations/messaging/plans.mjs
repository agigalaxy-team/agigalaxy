import {randomUUID} from "node:crypto";
import {messagingCreateSchema,messagingSaveSchema,messagingActionSchema,messagingRetrySchema,messagingParse as parse} from "../../shared/operations-messaging-schema.mjs";
import {messagingPlanView,messagingRunViewWithin} from "./views.mjs";
import {messagingRecoveryPolicy,fail,iso} from './policy.mjs';
import {MessagingReadModel} from './read-model.mjs';

// Explicit plan versions, native schedule lifecycle and bounded original-run retry commands.
export class MessagingPlans extends MessagingReadModel{
 async create(operator,input,{authorize,planId=null}={}){
  const x=parse(messagingCreateSchema,input);
  if(planId!==null&&planId!==x.operationId)fail('invalid_operations_messaging_request',400);
  return this.command(operator,'create',planId?{...x,planId}:x,authorize,async(db,actor)=>{
   if(actor.kind==='operations-ai-service'&&!planId)fail('operations_ai_duty_operation_denied',403);
   await this.validateConfig(x.config,db);const id=planId??randomUUID(),at=iso(this.now());
   await db.query(`INSERT INTO operations_messaging_plans_v1(id,endpoint,version,revision,state,created_by,updated_by,created_at,updated_at) VALUES($1,$2,1,1,'draft',$3,$3,$4,$4)`,[id,this.endpoint,actor.operatorId,at]);
   await db.query('INSERT INTO operations_messaging_versions_v1(plan_id,version,config,created_by,created_at) VALUES($1,1,$2,$3,$4)',[id,JSON.stringify(x.config),actor.operatorId,at]);
   const row=await this.planWithin(db,id);await this.eventWithin(db,row,actor,'create',x.operationId);return {plan:messagingPlanView(row,actor,this.now())};
  });
 }
 async save(operator,id,input,{authorize}={}){
  const x=parse(messagingSaveSchema,input);
  return this.command(operator,'save',{...x,planId:id},authorize,async(db,actor)=>{
   const row=await this.planWithin(db,id,{lock:true});this.cas(row,x);if(row.state==='active')fail('operations_messaging_pause_required');await this.validateConfig(x.config,db);
   if(actor.kind==='operations-ai-service'&&row.state!=='draft')fail('operations_agentos_human_review_required',409);
   await db.query(`INSERT INTO operations_messaging_versions_v1(plan_id,version,config,created_by,created_at) VALUES($1,$2,$3,$4,$5)`,[id,row.version+1,JSON.stringify(x.config),actor.operatorId,iso(this.now())]);
   await db.query(`UPDATE operations_messaging_plans_v1 SET version=version+1,revision=revision+1,state='draft',approved_by=NULL,approved_role=NULL,approved_ai=NULL,approved_at=NULL,job_id=NULL,updated_by=$2,updated_at=$3 WHERE id=$1`,[id,actor.operatorId,iso(this.now())]);
   await db.query(`UPDATE operations_messaging_runs_v1 SET state='cancelled',revision=revision+1,error_code='operations_messaging_version_changed',updated_at=$2 WHERE plan_id=$1 AND state IN ('running','paused','blocked')`,[id,iso(this.now())]);
   await this.stopUnsentWithin(db,id,'operations_messaging_version_changed');
   const next=await this.planWithin(db,id);await this.eventWithin(db,next,actor,'save',x.operationId);return {plan:messagingPlanView(next,actor,this.now())};
  });
 }
 async scheduleWithin(db,row){
  const config=row.config,data={planId:row.id,planVersion:row.version};
  if(config.schedule.kind==='recurring'){
   if(typeof this.jobs?.schedule!=='function')fail('operations_messaging_scheduler_unavailable',503);
   await this.jobs.schedule('messaging-run',config.schedule.cron,data,{key:'messaging:'+row.id,timezone:config.schedule.timezone,missed:'skip',db});return null;
  }
  if(typeof this.jobs?.enqueue!=='function')fail('operations_messaging_scheduler_unavailable',503);
  return this.jobs.enqueue('messaging-run',data,{key:`messaging:${row.id}:v${row.version}:r${row.revision}`,startAfter:config.schedule.kind==='once'?new Date(Math.max(this.now()*1000,new Date(config.schedule.at).getTime())).toISOString():undefined,db});
 }
 async action(operator,id,kind,input,{authorize}={}){
  if(!['activate','pause','resume','stop','withdraw'].includes(kind))fail('invalid_operations_messaging_request',400);
  const x=parse(messagingActionSchema,input);
  return this.command(operator,kind,{...x,planId:id},authorize,async(db,actor)=>{
   const row=await this.planWithin(db,id,{lock:true});this.cas(row,x);
   if(actor.kind==='operations-ai-service')await this.assertDutyPlanWithin(db,actor,row,kind);
   if(kind==='activate'&&row.state!=='draft'||kind==='pause'&&row.state!=='active'||kind==='resume'&&row.state!=='paused'||kind==='stop'&&!['active','paused'].includes(row.state))fail('operations_messaging_state_changed');
   let state=kind==='activate'||kind==='resume'?'active':kind==='pause'?'paused':'stopped';
   if(state==='active')await this.validateConfig(row.config,db,{activating:kind==='activate'});
   if(state!=='active'&&row.config.schedule.kind==='recurring'){
    if(typeof this.jobs?.unschedule!=='function')fail('operations_messaging_scheduler_unavailable',503);
    await this.jobs.unschedule('messaging-run','messaging:'+id,{db});
   }
   await db.query(`UPDATE operations_messaging_plans_v1 SET state=$2,revision=revision+1,updated_by=$3,updated_at=$4,
    approved_by=CASE WHEN $2='active' THEN $3 ELSE approved_by END,approved_role=CASE WHEN $2='active' THEN $5 ELSE approved_role END,approved_ai=CASE WHEN $2='active' THEN $6::jsonb ELSE approved_ai END,approved_at=CASE WHEN $2='active' THEN $4 ELSE approved_at END WHERE id=$1`,[id,state,actor.operatorId,iso(this.now()),actor.role,state==='active'&&actor.kind==='operations-ai-service'?JSON.stringify(this.approvalMetadata(actor,row)):null]);
   let next=await this.planWithin(db,id);
   if(state==='active'){
    const jobId=await this.scheduleWithin(db,next);await db.query('UPDATE operations_messaging_plans_v1 SET job_id=$2 WHERE id=$1',[id,jobId]);
    const pending=(await db.query(`UPDATE operations_messaging_runs_v1 SET state='running',revision=revision+1,updated_at=$3 WHERE plan_id=$1 AND plan_version=$2 AND state IN ('paused','blocked') RETURNING id`,[id,next.version,iso(this.now())])).rows;
    for(const run of pending)await this.enqueueDelivery(db,run.id,'resume:'+next.revision);
   }else{await db.query(`UPDATE operations_messaging_runs_v1 SET state=$2,revision=revision+1,updated_at=$3 WHERE plan_id=$1 AND state IN ('running','paused','blocked')`,[id,state==='paused'?'paused':'cancelled',iso(this.now())]);if(state==='stopped')await this.stopUnsentWithin(db,id,'operations_messaging_stopped');}
   if(kind==='withdraw'){
    await db.query('UPDATE operations_messaging_announcements_v1 SET withdrawn_at=COALESCE(withdrawn_at,$2) WHERE plan_id=$1',[id,iso(this.now())]);
    await db.query(`UPDATE operations_notices_v1 SET state='withdrawn',version=version+1,updated_by=$3,updated_at=$2 WHERE id IN(SELECT id FROM operations_messaging_runs_v1 WHERE plan_id=$1) AND state<>'withdrawn'`,[id,iso(this.now()),actor.operatorId]);
   }
   next=await this.planWithin(db,id);await this.eventWithin(db,next,actor,kind,x.operationId);return {plan:messagingPlanView(next,actor,this.now()),effects:{futureExecutionStopped:state!=='active',alreadySubmittedEmailRetracted:false,existingPublicationsWithdrawn:kind==='withdraw'}};
  });
 }
 async retry(operator,runId,input,{authorize}={}){
  const x=parse(messagingRetrySchema,input);
  return this.command(operator,'retry',{...x,runId},authorize,async(db,actor)=>{
   const row=await this.runWithin(db,runId,{lock:true});if(row.revision!==x.expectedRevision)fail('operations_messaging_version_changed');await this.runtimeWithin(db,row);await this.recoverSubmissionsWithin(db,runId);
   const result=await db.query(`UPDATE operations_messaging_recipients_v1 SET state='pending',retryable=false,retry_at=NULL,error_code=NULL,completed_at=NULL,updated_at=$2 WHERE run_id=$1 AND (state='blocked' OR state='failed' AND retryable) AND attempt_count<$3 RETURNING id`,[runId,iso(this.now()),messagingRecoveryPolicy.maxSubmitAttempts]);
   if(!result.rows.length)fail('operations_messaging_retry_not_allowed');
   await db.query(`UPDATE operations_messaging_runs_v1 SET state='running',revision=revision+1,error_code=NULL,completed_at=NULL,updated_at=$2 WHERE id=$1`,[runId,iso(this.now())]);await this.enqueueDelivery(db,runId,'retry:'+x.operationId);
   return {run:await messagingRunViewWithin(db,await this.runWithin(db,runId),this.now()),retriedRecipients:result.rows.length};
  });
 }
}
