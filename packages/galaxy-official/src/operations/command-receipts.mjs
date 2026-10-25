import {z} from 'zod';
import {ServiceError} from '../shared/service-error.mjs';
import {recommendationThemeKeySchema} from '../shared/operations-recommendation-schema.mjs';
import {safeProviderCodes} from './messaging/policy.mjs';

const uuid=z.uuid();
const isId=value=>uuid.safeParse(value).success;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const oneOf=(value,values)=>values.includes(value);
const same=(actor,operator,endpoint)=>actor?.kind==='business-operator'&&actor.endpoint===endpoint&&actor.operatorId===operator?.operatorId;
const fail=(code,status)=>{throw new ServiceError(code,status);};

// These reads answer only what the original, committed Node ledger proves.
// In particular, a maintenance intent is not a native completion receipt and
// an SMTP claim is not delivery. No current configuration/history is a fallback.
export async function readReceipt({endpoint,operator,operationId,authorize,load,project,qualify=null,sameActor=same,now}){
 if(!isId(operationId))fail('invalid_operations_command_receipt',400);
 const current=async actor=>{
  if(!sameActor(actor,operator,endpoint))fail('business_admin_denied',403);
  const fresh=await authorize(actor);
  if(!sameActor(fresh,operator,endpoint))fail('business_admin_denied',403);
  return fresh;
 };
 const actor=await current(operator);
 let rows,unavailable=false;
 try{rows=await load(operationId);}
 catch(error){
  if(error?.code==='42P01')unavailable=true;
  else fail('operations_command_receipt_unavailable',503);
 }
 let value=null;
 if(!unavailable){
  // Operation identifiers are not an authority to read another manager's
  // input/result, even if both managers can read the same module today.
  if(rows.some(row=>row.operator_id!==actor.operatorId)){
   await current(actor);fail('operations_command_receipt_not_found',404);
  }
  if(rows.length===1){
   value=project(rows[0]);
   if(value&&qualify){
    try{if(!await qualify(value))value=null;}
    catch(error){if(error?.code==='42P01')value=null;else fail('operations_command_receipt_unavailable',503);}
   }
  }
 }
 await current(actor);
 const checkedAt=now();
 return {state:unavailable?'unknown':rows.length===0?'not-recorded':value?'recorded':'unknown',operationId,
  kind:value?.kind??null,result:value?.result??null,checkedAt,readExpiresAt:checkedAt+30,metadataOnly:true};
}

export function smtpCommandResult({db,endpoint,operator,authorize,now},operationId){
 return readReceipt({endpoint,operator,authorize,operationId,now,
  // One snapshot also detects an identifier reused across the two existing
  // SMTP ledgers. Such an ambiguous result is never guessed from recency.
  load:async id=>(await db.query(`
   SELECT operator_id,'settings' AS kind,jsonb_build_object('version',result->'version') AS receipt
   FROM operations_smtp_commands_v1 WHERE endpoint=$1 AND operation_id=$2
   UNION ALL
   SELECT operator_id,'test.'||kind AS kind,jsonb_build_object('version',configuration_version,'testId',id,'state',state,'code',code,'startedAt',started_at) AS receipt
   FROM operations_smtp_tests_v1 WHERE endpoint=$1 AND id=$2`,[endpoint,id])).rows,
  project:row=>{
   const x=row.receipt;if(!object(x)||!positive(x.version))return null;
   if(row.kind==='settings')return {kind:'settings',result:{version:x.version}};
   if(!oneOf(row.kind,['test.connection','test.delivery'])||!isId(x.testId)||!oneOf(x.state,['testing','connected','submitted','not-configured','ineligible','failed','unknown']))return null;
   const stale=x.state==='testing'&&Number.isFinite(Date.parse(x.startedAt))&&now()*1000-Date.parse(x.startedAt)>900000;
   return {kind:row.kind,result:{version:x.version,testId:x.testId,state:stale?'unknown':x.state,code:stale?'smtp_submission_unknown':safeProviderCodes.has(x.code)?x.code:null}};
  }});
}

export function messagingCommandResult({db,endpoint,operator,authorize,sameActor,now},operationId){
 return readReceipt({endpoint,operator,authorize,sameActor,operationId,now,
  load:async id=>(await db.query(`SELECT operator_id,kind,jsonb_build_object(
   'planId',COALESCE(result->'plan'->'id',result->'run'->'planId'),
   'runId',result->'run'->'id','version',COALESCE(result->'plan'->'version',result->'run'->'planVersion'),
   'revision',COALESCE(result->'plan'->'revision',result->'run'->'revision'),
   'state',COALESCE(result->'plan'->'state',result->'run'->'state'),
   'effects',jsonb_build_object('futureExecutionStopped',result->'effects'->'futureExecutionStopped',
    'alreadySubmittedEmailRetracted',result->'effects'->'alreadySubmittedEmailRetracted',
    'existingPublicationsWithdrawn',result->'effects'->'existingPublicationsWithdrawn')) AS receipt
   FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2`,[endpoint,id])).rows,
  project:row=>{
   const x=row.receipt;
   if(!oneOf(row.kind,['create','save','activate','pause','resume','stop','withdraw','retry'])||!object(x)||!isId(x.planId)||!positive(x.version)||!positive(x.revision))return null;
   if(row.kind==='retry'?!isId(x.runId)||!oneOf(x.state,['running','paused','blocked','completed','cancelled','expired']):!oneOf(x.state,['draft','active','paused','stopped']))return null;
   const result={planId:x.planId,version:x.version,revision:x.revision,state:x.state};
   if(row.kind==='retry')result.runId=x.runId;
   if(object(x.effects)&&Object.values(x.effects).every(value=>typeof value==='boolean'))result.effects={
    futureExecutionStopped:x.effects.futureExecutionStopped,alreadySubmittedEmailRetracted:x.effects.alreadySubmittedEmailRetracted,existingPublicationsWithdrawn:x.effects.existingPublicationsWithdrawn};
   return {kind:row.kind,result};
  },
  qualify:async({result})=>{
   if(!(await db.query('SELECT 1 FROM operations_messaging_plans_v1 WHERE endpoint=$1 AND id=$2',[endpoint,result.planId])).rows.length)return false;
   return !result.runId||(await db.query('SELECT 1 FROM operations_messaging_runs_v1 WHERE endpoint=$1 AND id=$2 AND plan_id=$3',[endpoint,result.runId,result.planId])).rows.length===1;
  }});
}

export function recommendationCommandResult({db,endpoint,operator,authorize,now},operationId){
 return readReceipt({endpoint,operator,authorize,operationId,now,
  load:async id=>(await db.query(`SELECT operator_id,kind,revision,theme_key,jsonb_build_object(
   'version',COALESCE(result->'policy'->'version',result->'theme'->'version'),
   'themeId',result->'theme'->'id','themeKey',result->'theme'->'key') AS receipt
   FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND operation_id=$2`,[endpoint,id])).rows,
  project:row=>{
   const x=row.receipt;
   if(!object(x)||!positive(row.revision)||x.version!==row.revision||!recommendationThemeKeySchema.safeParse(row.theme_key).success)return null;
   if(row.kind==='policy-updated')return {kind:'policy',result:{version:x.version,themeKey:row.theme_key}};
   if(!oneOf(row.kind,['theme-created','theme-updated'])||!isId(x.themeId)||x.themeKey!==row.theme_key||row.theme_key!=='theme:'+x.themeId)return null;
   return {kind:'theme',result:{version:x.version,themeKey:row.theme_key,themeId:x.themeId}};
  }});
}

const maintenanceKinds=Object.freeze({'backup-create':'create','backup-verify':'verify','restore-plan':'plan','restore-approve':'approve','restore-execute':'execute','restore-cancel':'cancel'});
export function maintenanceCommandResult({db,endpoint,operator,authorize,now},operationId){
 return readReceipt({endpoint,operator,authorize,operationId,now,
  load:async id=>(await db.query(`SELECT operator_id,action,plan_id,revision,jsonb_build_object(
   'planId',result->'planId','revision',result->'revision','state',result->'state') AS receipt
   FROM operations_maintenance_events_v1 WHERE endpoint=$1 AND operation_id=$2`,[endpoint,id])).rows,
  project:row=>{
   if(!Object.hasOwn(maintenanceKinds,row.action)||!object(row.receipt))return null;
   const kind=maintenanceKinds[row.action],x=row.receipt;
   if(oneOf(kind,['create','verify']))return x.state==='accepted'?{kind,result:{state:'accepted'}}:null;
   if(!isId(x.planId)||x.planId!==row.plan_id||!positive(x.revision)||x.revision!==row.revision||!oneOf(x.state,['blocked','awaiting-approval','approved','preparing','cancelled']))return null;
   return {kind,result:{planId:x.planId,revision:x.revision,state:x.state}};
  },
  qualify:async({result})=>!result.planId||(await db.query('SELECT 1 FROM operations_maintenance_plans_v1 WHERE endpoint=$1 AND id=$2',[endpoint,result.planId])).rows.length===1});
}
