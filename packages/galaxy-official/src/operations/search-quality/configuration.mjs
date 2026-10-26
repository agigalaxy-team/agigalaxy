import {randomUUID} from "node:crypto";
import canonicalize from "canonicalize";
import {transaction} from "../../infrastructure/database.mjs";
import {digest} from "../../shared/digest.mjs";
import {canonicalSearchSettings,nativeSearchSettings,editableSearchSettings,sameNativeSettings} from "../../shared/operations-search-quality-schema.mjs";
import {iso,fail,phases,changes,nativeFailure} from './helpers.mjs';
import {SearchQualityState} from './base.mjs';

// Immutable configuration versions and original-intent commands, including native task submission and uncertain ACK reconciliation.
export class SearchQualityConfiguration extends SearchQualityState{
 async prepare(operator,kind,input,{authorize}={}){
  const action=kind==='draft'?'search-quality.configure':kind==='apply'?'search-quality.publish':'search-quality.restore';
  await this.currentActor(operator,action,authorize);
  const existing=await this.operationWithin(this.db,input.operationId);
  const requestHash=digest(canonicalize({kind,input}));
  if(existing){if(existing.operator_id!==operator.operatorId||existing.request_hash!==requestHash)fail('search_quality_operation_conflict');return {row:existing,replayed:true};}
  const previous=await this.stateWithin(this.db),activeVersion=await this.versionWithin(this.db,previous.active_id),native=kind==='draft'&&activeVersion?activeVersion.native_settings:await this.observedSettings(),tasks=kind==='draft'?null:await this.meili.settingsTasks({limit:1});
  if(kind!=='draft'&&(await this.meili.settingsTasks({pendingOnly:true,limit:1})).items.length)fail('search_quality_native_busy');
  return transaction(this.db,async db=>{
   await this.lock(db);const actor=await this.currentActor(operator,action,authorize,db),prior=await this.operationWithin(db,input.operationId);
   if(actor.kind==='operations-ai-service')await this.businessAdmin.authorizeOperation(actor,action,{id:input.versionId,operationId:input.operationId,command:input},{db});
   if(prior){if(prior.operator_id!==actor.operatorId||prior.request_hash!==requestHash)fail('search_quality_operation_conflict');return {row:prior,replayed:true};}
   let state=await this.stateWithin(db);if(state.revision!==input.expectedRevision)fail('search_quality_revision_changed');if(state.pending_operation)fail('search_quality_operation_pending');
   const at=iso(this.now());await db.query('INSERT INTO operations_search_quality_state_v1(endpoint,updated_at) VALUES($1,$2) ON CONFLICT DO NOTHING',[this.endpoint,at]);
   let active=await this.versionWithin(db,state.active_id),target;
   if(!active){active={id:randomUUID(),version:0,settings:editableSearchSettings(native),native_settings:native,kind:'baseline',restored_from:null,operator_id:actor.operatorId,created_at:at};
    await this.insertVersion(db,active);state={...state,active_id:active.id};}
   if(kind==='draft'){
    const highest=(await db.query('SELECT max(version)::integer AS version FROM operations_search_quality_versions_v1 WHERE endpoint=$1',[this.endpoint])).rows[0].version;
    const settings=canonicalSearchSettings(input.settings);target={id:randomUUID(),version:highest+1,settings,native_settings:nativeSearchSettings(settings),kind:'draft',restored_from:null,operator_id:actor.operatorId,created_at:at};await this.insertVersion(db,target);
   }else{
    const selected=await this.versionWithin(db,input.versionId);if(!selected)fail('search_quality_version_unavailable',404);
    if(kind==='apply'&&state.draft_id!==selected.id)fail('search_quality_draft_changed');
    if(kind==='restore'&&selected.kind!=='baseline'&&!selected.was_applied)fail('search_quality_version_not_applied');
    if(!sameNativeSettings(native,active.native_settings))fail('search_quality_native_drift');
    if(kind==='restore'){const highest=(await db.query('SELECT max(version)::integer AS version FROM operations_search_quality_versions_v1 WHERE endpoint=$1',[this.endpoint])).rows[0].version;
     target={...selected,id:randomUUID(),version:highest+1,kind:'restore',restored_from:selected.id,operator_id:actor.operatorId,created_at:at};await this.insertVersion(db,target);
    }else target=selected;
   }
   const before=kind==='draft'?(await this.versionWithin(db,state.draft_id))??active:active,delta=changes(before.settings,target.settings),phase=kind==='draft'?'applied':'prepared';
   const row=(await db.query('INSERT INTO operations_search_quality_operations_v1(endpoint,operation_id,operator_id,kind,request_hash,input,version_id,phase,native_watermark,changes,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *',[this.endpoint,input.operationId,actor.operatorId,kind,requestHash,JSON.stringify(input),target.id,phase,tasks?.items.length?Math.max(...tasks.items.map(task=>task.id)):-1,JSON.stringify(delta),input.reason,at])).rows[0];
   await db.query('UPDATE operations_search_quality_state_v1 SET revision=revision+1,active_id=$2,draft_id=$3,pending_operation=$4,updated_at=$5 WHERE endpoint=$1',[this.endpoint,state.active_id,kind==='draft'?target.id:state.draft_id,kind==='draft'?null:input.operationId,at]);
   await this.currentActor(operator,action,authorize,db);
   if(this.businessAdmin)await this.businessAdmin.recordWithin(db,actor,action,{operationId:input.operationId,selection:{version:target.version},result:{version:target.version}});
   return {row,replayed:false};
  });
 }
 async insertVersion(db,row){await db.query('INSERT INTO operations_search_quality_versions_v1(id,endpoint,version,settings,native_settings,kind,restored_from,operator_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[row.id,this.endpoint,row.version,row.settings===null?null:JSON.stringify(row.settings),JSON.stringify(row.native_settings),row.kind,row.restored_from,row.operator_id,row.created_at]);}
 async advance(row,phase,{taskId=null,errorCode=null}={}){
  return transaction(this.db,async db=>{await this.lock(db);const current=await this.operationWithin(db,row.operation_id);if(!current||!phases.has(current.phase))return current;
   const updated=(await db.query('UPDATE operations_search_quality_operations_v1 SET phase=$3,native_task_id=coalesce($4,native_task_id),error_code=$5,updated_at=$6 WHERE endpoint=$1 AND operation_id=$2 RETURNING *',[this.endpoint,row.operation_id,phase,taskId,errorCode,iso(this.now())])).rows[0];
   if(phase==='applied')await db.query('UPDATE operations_search_quality_state_v1 SET active_id=$3,pending_operation=NULL,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND pending_operation=$2',[this.endpoint,row.operation_id,row.version_id,iso(this.now())]);
   if(phase==='failed')await db.query('UPDATE operations_search_quality_state_v1 SET pending_operation=NULL,revision=revision+1,updated_at=$3 WHERE endpoint=$1 AND pending_operation=$2',[this.endpoint,row.operation_id,iso(this.now())]);
   return updated;
  });
 }
 async submit(operator,row,authorize){
  const action=row.kind==='apply'?'search-quality.publish':'search-quality.restore';await this.currentActor(operator,action,authorize);
  const claimed=(await this.db.query("UPDATE operations_search_quality_operations_v1 SET phase='submitting',submitted_at=$3,updated_at=$3 WHERE endpoint=$1 AND operation_id=$2 AND phase='prepared' RETURNING *",[this.endpoint,row.operation_id,iso(this.now())])).rows[0];if(!claimed)return this.reconcile(row.operation_id);
  const target=await this.versionWithin(this.db,row.version_id);
  try{await this.currentActor(operator,action,authorize);}catch(error){await this.advance(claimed,'failed',{errorCode:nativeFailure(error)});throw error;}
  try{const taskId=await this.meili.submitSettings(target.native_settings);return await this.advance(claimed,'task-pending',{taskId});}
  catch(error){return this.advance(claimed,error?.code==='discovery_engine_authorization_failed'||[400,401,403,404,405,413,415,422,429].includes(error.nativeStatus)?'failed':'result-unknown',{errorCode:nativeFailure(error)});}
 }
 async reconcile(id){
  if(this.reconciling.has(id))return this.reconciling.get(id);
  const operation=this.reconcileOnce(id);this.reconciling.set(id,operation);try{return await operation;}finally{if(this.reconciling.get(id)===operation)this.reconciling.delete(id);}
 }
 async reconcileOnce(id){
  let row=await this.operationWithin(this.db,id);if(!row||!phases.has(row.phase)||row.phase==='prepared')return row;
  const target=await this.versionWithin(this.db,row.version_id);let task;
  try{
   if(row.native_task_id!==null)task=await this.meili.settingsTask(Number(row.native_task_id));
   else{const tasks=await this.meili.settingsTasks({afterId:Number(row.native_watermark)}),matches=tasks.items.filter(task=>task.settings&&sameNativeSettings(task.settings,target.native_settings));
    if(!tasks.complete||matches.length!==1)return this.advance(row,'result-unknown',{errorCode:'search_quality_native_result_unknown'});
    task=matches[0];row=await this.advance(row,'task-pending',{taskId:task.id});
   }
   if(!task)return this.advance(row,'result-unknown',{errorCode:'search_quality_native_task_missing'});
   if(['enqueued','processing'].includes(task.status))return this.advance(row,'task-pending',{taskId:task.id});
   if(['failed','canceled'].includes(task.status))return this.advance(row,'failed',{taskId:task.id,errorCode:'search_quality_native_task_failed'});
   const current=await this.observedSettings();if(!sameNativeSettings(current,target.native_settings))return this.advance(row,'result-unknown',{taskId:task.id,errorCode:'search_quality_native_readback_mismatch'});
   return this.advance(row,'applied',{taskId:task.id});
  }catch(error){return this.advance(row,'result-unknown',{errorCode:nativeFailure(error)});}
 }
}
