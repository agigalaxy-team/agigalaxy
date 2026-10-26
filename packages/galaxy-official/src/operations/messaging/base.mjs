import {isDeepStrictEqual} from "node:util";
import {z} from "zod";
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {messagingParse as parse} from "../../shared/operations-messaging-schema.mjs";
import {permission,auditAction,same,fail,iso} from './policy.mjs';

// Current requester/publication authority, immutable command receipts and shared plan/run locking.
export class MessagingBase{
 constructor({db,endpoint,businessAdmin,accounts,jobs,mailProvider=null,lockPlan=null,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,businessAdmin,accounts,jobs,mailProvider,lockPlan,now});}
 async requestActor(operator,authorize,code,db){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const current=this.businessAdmin.require(await authorize({db}));
  const authority=this.businessAdmin.executorAuthority;
  const sameDuty=authority?.acceptsDuty?.(current)&&authority.acceptsDuty(operator)&&current.operatorId===operator.operatorId&&current.taskId===operator.taskId;
  if((!same(current,operator)&&!sameDuty)||current.endpoint!==this.endpoint)fail('business_admin_denied',403);
  return this.businessAdmin.authorizeAction(current,code,{db});
 }
 async command(operator,kind,input,authorize,operation){
  this.businessAdmin.require(operator);
  return transaction(this.db,async db=>{
   let actor=await this.requestActor(operator,authorize,permission[kind],db);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912411))',[this.endpoint+':messaging:'+input.operationId]);
   const prior=(await db.query('SELECT * FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,input.operationId])).rows[0];
   if(prior){if(prior.operator_id!==actor.operatorId||prior.kind!==kind||!isDeepStrictEqual(prior.input,input))fail('operations_messaging_operation_changed');return {...prior.result,replayed:true};}
   if(actor.kind==='operations-ai-service'){
    // Draft creation is reversible. Publication classification is still a
    // human boundary and can never be self-certified by a writing model.
    if(['create','save'].includes(kind))await this.assertDutyDraftWithin(db,actor,{planId:input.planId,kind,config:input.config});
    if(kind==='retry')fail('operations_agentos_human_review_required',409);
    actor=await this.businessAdmin.authorizeOperation(actor,auditAction[kind],{operationId:input.operationId,planId:input.planId},{db});
   }
   const result=await operation(db,actor);
   // An asynchronous queue/configuration call never substitutes for the current
   // request's live management identity and the database grant.
   actor=await this.requestActor(operator,authorize,permission[kind],db);
   const selection={kind,planId:result.plan?.id??result.run?.planId??null,runId:result.run?.id??null,planVersion:result.plan?.version??result.run?.planVersion??null};
   await this.businessAdmin.recordWithin(db,actor,auditAction[kind],{operationId:input.operationId,selection,result:{state:result.plan?.state??result.run?.state,version:result.plan?.version??result.run?.planVersion,revision:result.plan?.revision??result.run?.revision}});
   await db.query('INSERT INTO operations_messaging_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.endpoint,input.operationId,actor.operatorId,kind,JSON.stringify(input),JSON.stringify(result),iso(this.now())]);
   return {...result,replayed:false};
  });
 }
 async planWithin(db,id,{lock=false}={}){
  parse(z.uuid(),id);
  const row=(lock&&this.lockPlan?await this.lockPlan(db,id,this.endpoint):await db.query(`SELECT p.*,v.config FROM operations_messaging_plans_v1 p JOIN operations_messaging_versions_v1 v ON v.plan_id=p.id AND v.version=p.version WHERE p.id=$1 AND p.endpoint=$2${lock?' FOR UPDATE OF p':''}`,[id,this.endpoint])).rows[0];
  if(!row)fail('operations_messaging_plan_not_found',404);return row;
 }
 async runWithin(db,id,{lock=false}={}){
  parse(z.uuid(),id);
  // Lifecycle commands lock the plan before its runs. Delivery and receipt
  // recording keep that order too, rather than creating a pause/send deadlock.
  if(lock){const target=(await db.query('SELECT plan_id FROM operations_messaging_runs_v1 WHERE id=$1 AND endpoint=$2',[id,this.endpoint])).rows[0];if(!target)fail('operations_messaging_run_not_found',404);await this.planWithin(db,target.plan_id,{lock:true});}
  const row=(await db.query(`SELECT r.*,v.config FROM operations_messaging_runs_v1 r JOIN operations_messaging_versions_v1 v ON v.plan_id=r.plan_id AND v.version=r.plan_version WHERE r.id=$1 AND r.endpoint=$2${lock?' FOR UPDATE OF r':''}`,[id,this.endpoint])).rows[0];
  if(!row)fail('operations_messaging_run_not_found',404);return row;
 }
 cas(row,x){if(row.version!==x.expectedVersion||row.revision!==x.expectedRevision)fail('operations_messaging_version_changed');}
 async validateConfig(config,db,{activating=false}={}){
  if(new Date(config.content.expiresAt).getTime()<=this.now()*1000)fail('operations_messaging_expired');
  if(config.schedule.kind==='once'){
   const at=new Date(config.schedule.at).getTime();
   if(at>=new Date(config.content.expiresAt).getTime()||activating&&at<=this.now()*1000)fail('operations_messaging_schedule_invalid',400);
  }
  if(config.schedule.kind==='recurring'){
   if(typeof this.jobs?.previewSchedule!=='function')fail('operations_messaging_scheduler_unavailable',503);
   try{const preview=await this.jobs.previewSchedule(config.schedule.cron,{timezone:config.schedule.timezone,from:iso(this.now()),count:1});if(!Array.isArray(preview)||!preview.length||new Date(preview[0]).getTime()>=new Date(config.content.expiresAt).getTime())fail('operations_messaging_schedule_invalid',400);}
   catch(error){if(error instanceof ServiceError)throw error;fail('operations_messaging_schedule_invalid',400);}
  }
  if(config.audience.kind==='accounts'){
   const found=Number((await db.query('SELECT count(*) AS count FROM community_accounts WHERE endpoint=$1 AND id=ANY($2::uuid[])',[this.endpoint,config.audience.accountIds])).rows[0].count);
   if(found!==config.audience.accountIds.length)fail('operations_messaging_audience_unavailable');
  }
 }
 async senderStatus(){
  if(typeof this.mailProvider?.status!=='function')return {state:'not-configured',enabled:false,configVersion:null,receipts:'not-connected'};
  try{const status=await this.mailProvider.status();return {state:status.state==='configured'?'configured':'not-configured',enabled:status.enabled===true,configVersion:typeof status.configVersion==='string'?status.configVersion:null,receipts:'not-connected'};}
  catch{return {state:'not-configured',enabled:false,configVersion:null,receipts:'not-connected'};}
 }
 async assertDutyDraftWithin(db,actor,{planId,kind,config}){
  const authority=this.businessAdmin.executorAuthority;if(!authority?.acceptsDuty?.(actor))fail('business_admin_denied',403);
  parse(z.uuid(),planId);
  if(!['create','save'].includes(kind)||config?.automation?.kind!=='human-required'||config.automation.factsConfirmed!==false)fail('operations_agentos_human_review_required',409);
  await authority.requireDutyAction(actor,'notices.read',{db,purpose:'prepare'});
  if(kind==='create'){
   if((await db.query('SELECT 1 FROM operations_messaging_plans_v1 WHERE id=$1',[planId])).rows.length)fail('operations_messaging_state_changed');
  }else if((await this.planWithin(db,planId)).state!=='draft')fail('operations_agentos_human_review_required',409);
 }
 async assertDutyPlanWithin(db,actor,row,kind){
  if(!this.businessAdmin.executorAuthority?.acceptsDuty?.(actor))fail('business_admin_denied',403);
  if(['activate','resume'].includes(kind)&&(row.config.automation?.kind!=='ordinary'||row.config.automation?.factsConfirmed!==true))fail('operations_agentos_human_review_required',409);
  const prior=(await db.query('SELECT actor_kind,operator_id,kind FROM operations_messaging_events_v1 WHERE plan_id=$1 ORDER BY sequence DESC LIMIT 1',[row.id])).rows[0];
  // Creating an ordinary draft does not decide publication. A later human
  // publication/pause/withdrawal is never silently reversed by a duty run.
  if(prior&&!['create','save'].includes(prior.kind)&&(prior.actor_kind!=='operations-ai-service'||prior.operator_id!==actor.operatorId))fail('operations_agentos_human_review_required',409);
 }
 approvalMetadata(actor,row){
  if(actor.kind!=='operations-ai-service')return null;
  const value=this.businessAdmin.executorAuthority.dutyMetadata(actor);
  if(value.operation?.targetId!==row.id||value.operation.permission!=='notices.publish')fail('operations_ai_duty_operation_denied',403);
  return {...value,messagePlanId:row.id,messageVersion:row.version};
 }
 async approvalActorWithin(db,plan){
  if(!plan.approved_by)fail('operations_messaging_approval_unavailable',403);
  if(plan.approved_ai){
   const {messagePlanId,messageVersion,...metadata}=plan.approved_ai;
   if(messagePlanId!==plan.id||messageVersion!==plan.version||plan.approved_role!==null||plan.approved_by!=='ai:'+metadata.aiAccountId)fail('operations_messaging_approval_unavailable',403);
   const actor=await this.businessAdmin.executorAuthority?.continuationActorWithin(db,metadata);
   if(!actor)fail('operations_messaging_approval_unavailable',403);
   return this.businessAdmin.authorizeAction(actor,'notices.publish',{db});
  }
  if(!plan.approved_role)fail('operations_messaging_approval_unavailable',403);
  return this.businessAdmin.revalidate({kind:'business-operator',operatorId:plan.approved_by,role:plan.approved_role,endpoint:this.endpoint},{action:'notices.publish',db});
 }
 async validatePersistedApprovalWithin(db,context){
  const id=context.operation?.targetId;if(!id||context.operation.permission!=='notices.publish')return{allowed:false};
  const plan=await this.planWithin(db,id),stored=plan.approved_ai;
  if(!stored||plan.state!=='active'||stored.messageVersion!==plan.version||stored.messagePlanId!==id||plan.approved_by!=='ai:'+context.aiAccountId||plan.approved_role!==null||plan.config.automation?.kind!=='ordinary'||plan.config.automation?.factsConfirmed!==true)return{allowed:false};
  const {messagePlanId:_messagePlanId,messageVersion:_messageVersion,...metadata}=stored;
  // Only the exact committed approval can reconstruct an execution identity.
  const clean=Object.fromEntries(Object.entries(context).filter(([key])=>!['continuation','businessAction','selection'].includes(key)));
  if(!isDeepStrictEqual(metadata,clean))return{allowed:false};
  if(!this.autonomy?.validatePersistedOperationWithin)return{allowed:false};
  return this.autonomy.validatePersistedOperationWithin(db,context,{sourceMatched:true});
 }
 async eventWithin(db,row,actor,kind,operationId){const ai=actor.kind==='operations-ai-service'?this.businessAdmin.executorAuthority.dutyMetadata(actor):null;
  await db.query(`INSERT INTO operations_messaging_events_v1(id,plan_id,operator_id,operator_role,kind,version,revision,created_at,actor_kind,ai_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[operationId,row.id,actor.operatorId,actor.role,kind,row.version,row.revision,iso(this.now()),actor.kind,ai?JSON.stringify(ai):null]);}
 async runtimeWithin(db,run){
  let plan=await this.planWithin(db,run.plan_id);
  // Take the authority read lock before the plan lock, as commands do.
  await this.approvalActorWithin(db,plan);
  plan=await this.planWithin(db,run.plan_id,{lock:true});
  if(plan.version!==run.plan_version)fail('operations_messaging_version_changed');
  if(plan.state!=='active')fail(plan.state==='paused'?'operations_messaging_paused':'operations_messaging_stopped');
  if(new Date(run.config.content.expiresAt).getTime()<=this.now()*1000)fail('operations_messaging_expired');
  const actor=await this.approvalActorWithin(db,plan);
  return {plan,actor};
 }
}
