import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import canonicalize from 'canonicalize';
import {transaction} from './database.mjs';
import {digest} from './shared/digest.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {modelSettingsNativeStatus,modelSettingsNativeOperation,modelSettingsNativeCredential,modelSettingsNativeUsage} from './operations-model-settings-native.mjs';
import {modelSettingsDomains,modelSettingsFormats,modelSettingsConfigurationSchema,emptyModelSettingsConfiguration,modelSettingsDraftSchema,modelSettingsApplySchema,modelSettingsCredentialSchema,modelSettingsHistorySchema,modelSettingsUsageSchema,modelSettingsOperationSchema,modelSettingsNativeAuthorizationSchema,parseModelSettings,assertModelSettingsApplicable} from './shared/operations-model-settings-schema.mjs';

const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const iso=seconds=>new Date(seconds*1000).toISOString(),stamp=value=>new Date(value).toISOString();
const pendingPhases=new Set(['prepared','submitting','pending','result-unknown']);
const versionView=row=>row?{id:row.id,version:row.version,configuration:row.configuration,operatorId:row.operator_id,createdAt:stamp(row.created_at)}:null;
const operationView=(row,replayed=false)=>({operationId:row.operation_id,kind:row.kind,phase:row.phase,versionId:row.version_id,
 modelRecordId:row.input?.modelRecordId??null,credentialRef:row.credential_ref,errorCode:row.error_code,replayed,recordedAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)});
const modelFields=['displayName','modelId','apiFormat','baseUrl','credentialRef','contextWindow','maxOutputTokens','reasoning','timeoutSeconds','toolCalling','structuredOutput','enabled'];
function configurationChanges(before,after){
 const ids=[...new Set([...before.models,...after.models].map(model=>model.id))].sort();
 return {models:ids.map(id=>{const a=before.models.find(model=>model.id===id)??null,b=after.models.find(model=>model.id===id)??null;
  return{id,kind:a===null?'added':b===null?'removed':'changed',fields:modelFields.filter(field=>!isDeepStrictEqual(a?.[field]??null,b?.[field]??null)).map(field=>({field,before:a?.[field]??null,after:b?.[field]??null}))};
 }).filter(row=>row.fields.length),scenarios:modelSettingsDomains.filter(domain=>!isDeepStrictEqual(before.scenarios[domain],after.scenarios[domain])).map(domain=>({domain,before:before.scenarios[domain],after:after.scenarios[domain]}))};
}
const nativeCode=error=>/^(?:models|model_settings|model_configuration)_[a-z0-9_]{1,80}$/.test(error?.code??'')?error.code:'model_settings_native_unavailable';
export class OperationsModelSettingsService{
 constructor({businessAdmin,native=null,now=businessAdmin.now}){Object.assign(this,{businessAdmin,native,db:businessAdmin.db,endpoint:businessAdmin.endpoint,now});this.reconciling=new Map();}
 envelope(){return{checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};}
 human(operator){if(operator?.kind!=='business-operator')fail('model_settings_human_required',403);return this.businessAdmin.require(operator);}
 require(operator,permission,db=this.db){return this.businessAdmin.authorizeAction(this.human(operator),permission,{db});}
 async fresh(operator,permission,authorize,db=this.db){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);const actor=this.human(await authorize());
  if(actor.operatorId!==operator.operatorId||actor.endpoint!==operator.endpoint)fail('business_admin_denied',403);
  return this.require(actor,permission,db);
 }
 stateWithin(db){return db.query('SELECT * FROM operations_model_settings_state_v1 WHERE endpoint=$1',[this.endpoint]).then(result=>result.rows[0]??{revision:0,active_id:null,draft_id:null,pending_operation:null});}
 versionWithin(db,id){return id?db.query('SELECT * FROM operations_model_settings_versions_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,id]).then(result=>result.rows[0]??null):null;}
 operationWithin(db,id){return db.query('SELECT * FROM operations_model_settings_operations_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id]).then(result=>result.rows[0]??null);}
 lock(db){return db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,61243091))',[this.endpoint]);}
 async nativeStatus(){if(!this.native)fail('model_settings_native_not_configured',503);return modelSettingsNativeStatus(await this.native.call({kind:'models-overview'}));}
 async record(db,actor,kind,row,version){
  await this.businessAdmin.recordWithin(db,actor,kind==='apply'?'models.apply':'models.configure',{operationId:row.operation_id,
   selection:{version:version?.version??null,kind,modelRecordId:row.input?.modelRecordId??null},
   result:{version:version?.version??null,count:version?.configuration.models.length??null}});
 }
 async prepare(operator,kind,input,{authorize}={}){
  const action=kind==='apply'?'models.apply':'models.configure';await this.fresh(operator,action,authorize);
  // Credential secrets deliberately never enter the durable request or hash.
  const safeInput=kind==='credential-provision'?{operationId:input.operationId,modelRecordId:input.modelRecordId}:input;
  const requestHash=digest(canonicalize({kind,input:safeInput})),existing=await this.operationWithin(this.db,input.operationId);
  if(existing){if(existing.operator_id!==operator.operatorId||existing.kind!==kind||existing.request_hash!==requestHash)fail('model_settings_operation_conflict');return{row:existing,replayed:true};}
  let observed=null;
  if(kind==='apply'){
   observed=await this.nativeStatus();if(observed.availability.state!=='available')fail('model_settings_native_unavailable',503);
   const selected=await this.versionWithin(this.db,input.versionId);if(!selected)fail('model_settings_version_unavailable',404);
   assertModelSettingsApplicable(selected.configuration);
   for(const model of selected.configuration.models.filter(model=>model.enabled))
    if(!observed.credentials.some(item=>item.reference===model.credentialRef&&item.modelRecordId===model.id&&item.configured))fail('model_settings_credential_unavailable');
  }else if(kind==='credential-provision'&&!this.native)fail('model_settings_native_not_configured',503);
  return transaction(this.db,async db=>{
   await this.lock(db);const actor=await this.fresh(operator,action,authorize,db),prior=await this.operationWithin(db,input.operationId);
   if(prior){if(prior.operator_id!==actor.operatorId||prior.kind!==kind||prior.request_hash!==requestHash)fail('model_settings_operation_conflict');return{row:prior,replayed:true};}
   const state=await this.stateWithin(db),at=iso(this.now());let version=null,delta={models:[],scenarios:[]};
   if(kind!=='credential-provision'){
    if(state.revision!==input.expectedRevision)fail('model_settings_revision_changed');if(state.pending_operation)fail('model_settings_operation_pending');
    await db.query('INSERT INTO operations_model_settings_state_v1(endpoint,updated_at) VALUES($1,$2) ON CONFLICT DO NOTHING',[this.endpoint,at]);
    if(kind==='draft'){
     const highest=(await db.query('SELECT coalesce(max(version),0)::integer AS version FROM operations_model_settings_versions_v1 WHERE endpoint=$1',[this.endpoint])).rows[0].version;
     const configuration=parseModelSettings(modelSettingsConfigurationSchema,input.configuration);version={id:randomUUID(),version:highest+1,configuration,operator_id:actor.operatorId,created_at:at};
     const previous=await this.versionWithin(db,state.draft_id??state.active_id);delta=configurationChanges(previous?.configuration??emptyModelSettingsConfiguration(),configuration);
     await db.query('INSERT INTO operations_model_settings_versions_v1(id,endpoint,version,configuration,operator_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[version.id,this.endpoint,version.version,JSON.stringify(configuration),actor.operatorId,at]);
    }else{
     version=await this.versionWithin(db,input.versionId);if(!version||version.id!==state.draft_id)fail('model_settings_draft_changed');
     if(observed.appliedVersionId!==(state.active_id??null))fail('model_settings_native_drift');
     const active=await this.versionWithin(db,state.active_id);delta=configurationChanges(active?.configuration??emptyModelSettingsConfiguration(),version.configuration);
    }
   }
   const row=(await db.query('INSERT INTO operations_model_settings_operations_v1(endpoint,operation_id,operator_id,operator_role,kind,request_hash,input,version_id,phase,changes,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *',
    [this.endpoint,input.operationId,actor.operatorId,actor.role,kind,requestHash,JSON.stringify(safeInput),version?.id??null,kind==='draft'?'applied':'prepared',JSON.stringify(delta),input.reason??null,at])).rows[0];
   if(kind!=='credential-provision')await db.query('UPDATE operations_model_settings_state_v1 SET revision=revision+1,draft_id=$2,pending_operation=$3,updated_at=$4 WHERE endpoint=$1',[this.endpoint,kind==='draft'?version.id:state.draft_id,kind==='apply'?input.operationId:null,at]);
   await this.fresh(operator,action,authorize,db);await this.record(db,actor,kind,row,version);return{row,replayed:false};
  });
 }
 async advance(row,phase,{errorCode=null,credentialRef=null}={}){
  return transaction(this.db,async db=>{
   await this.lock(db);const current=await this.operationWithin(db,row.operation_id);if(!current||!pendingPhases.has(current.phase))return current;
   const next=(await db.query('UPDATE operations_model_settings_operations_v1 SET phase=$3,error_code=$4,credential_ref=coalesce($5,credential_ref),updated_at=$6 WHERE endpoint=$1 AND operation_id=$2 RETURNING *',[this.endpoint,row.operation_id,phase,errorCode,credentialRef,iso(this.now())])).rows[0];
   if(row.kind==='apply'&&['applied','failed'].includes(phase))await db.query('UPDATE operations_model_settings_state_v1 SET active_id=CASE WHEN $3 THEN $4 ELSE active_id END,pending_operation=NULL,revision=revision+1,updated_at=$5 WHERE endpoint=$1 AND pending_operation=$2',[this.endpoint,row.operation_id,phase==='applied',row.version_id,iso(this.now())]);
   return next;
  });
 }
 async acceptNative(row,value){
  const operation=modelSettingsNativeOperation(value?.operation??value),expectedKind=row.kind==='apply'?'models-apply':'models-credential-provision';
  if(operation.id!==row.operation_id||operation.kind!==expectedKind)fail('model_settings_native_response_invalid',503);
  if(operation.state==='failed')return this.advance(row,'failed',{errorCode:operation.code??'model_settings_native_failed'});
  if(operation.state==='unknown')return this.advance(row,'result-unknown',{errorCode:operation.code??'model_settings_native_result_unknown'});
  if(operation.state!=='completed')return this.advance(row,'pending');
  const status=await this.nativeStatus();
  if(status.availability.state!=='available')return this.advance(row,'result-unknown',{errorCode:'model_settings_native_unavailable'});
  if(row.kind==='credential-provision'){
   const reference='model-key:'+row.operation_id,item=status.credentials.find(item=>item.reference===reference&&item.modelRecordId===row.input.modelRecordId&&item.configured);
   if(operation.credentialRef!==reference||!item)return this.advance(row,'result-unknown',{errorCode:'model_settings_native_readback_mismatch'});
   return this.advance(row,'applied',{credentialRef:reference});
  }
  const selected=await this.versionWithin(this.db,row.version_id),expectedScenarios=modelSettingsDomains.filter(domain=>selected.configuration.scenarios[domain]!==null).sort();
  if(status.appliedVersionId!==row.version_id||!status.configurationVersion||status.engines.gateway.configurationVersion!==status.configurationVersion||status.engines.agentos.configurationVersion!==status.configurationVersion||
   ['unknown','unavailable'].includes(status.engines.gateway.state)||['unknown','unavailable'].includes(status.engines.agentos.state)||
   status.engines.gateway.modelCount!==selected.configuration.models.filter(model=>model.enabled).length||!isDeepStrictEqual([...status.engines.agentos.configuredScenarios].sort(),expectedScenarios))
   return this.advance(row,'result-unknown',{errorCode:'model_settings_native_readback_mismatch'});
  return this.advance(row,'applied');
 }
 async submit(operator,row,input,authorize){
  const action=row.kind==='apply'?'models.apply':'models.configure';await this.fresh(operator,action,authorize);
  const claimed=(await this.db.query("UPDATE operations_model_settings_operations_v1 SET phase='submitting',updated_at=$3 WHERE endpoint=$1 AND operation_id=$2 AND phase='prepared' RETURNING *",[this.endpoint,row.operation_id,iso(this.now())])).rows[0];
  if(!claimed)return this.reconcile(row.operation_id);
  try{await this.fresh(operator,action,authorize);}catch(error){await this.advance(claimed,'failed',{errorCode:'model_settings_permission_denied'});throw error;}
  const version=row.kind==='apply'?await this.versionWithin(this.db,row.version_id):null;
  const command=row.kind==='apply'?{kind:'models-apply',operationId:row.operation_id,operatorId:row.operator_id,versionId:version.id,revision:row.input.expectedRevision,configuration:version.configuration}
   :{kind:'models-credential-provision',operationId:row.operation_id,operatorId:row.operator_id,modelRecordId:row.input.modelRecordId,apiKey:input.apiKey};
  try{return await this.acceptNative(claimed,await this.native.call(command));}
  catch(error){
   const known=['model_settings_native_busy','model_settings_version_changed','model_settings_configuration_invalid','model_settings_credential_unavailable','model_settings_permission_denied','model_settings_authorization_unavailable'].includes(error?.code)||[400,401,403,404,405,409,413,415,422,429].includes(error?.nativeStatus);
   return this.advance(claimed,known?'failed':'result-unknown',{errorCode:nativeCode(error)});
  }
 }
 async reconcile(id){
  if(this.reconciling.has(id))return this.reconciling.get(id);
  const promise=(async()=>{const row=await this.operationWithin(this.db,id);if(!row||!pendingPhases.has(row.phase)||row.phase==='prepared')return row;
   try{return await this.acceptNative(row,await this.native.call({kind:'models-operation',operationId:id}));}
   catch(error){return this.advance(row,'result-unknown',{errorCode:nativeCode(error)});}
  })();this.reconciling.set(id,promise);try{return await promise;}finally{if(this.reconciling.get(id)===promise)this.reconciling.delete(id);}
 }
 async command(operator,kind,input,options={}){
  const schema=kind==='draft'?modelSettingsDraftSchema:kind==='apply'?modelSettingsApplySchema:modelSettingsCredentialSchema,x=parseModelSettings(schema,input);
  const prepared=await this.prepare(operator,kind,x,options);let row=prepared.row;
  if(kind!=='draft'&&row.phase==='prepared')row=await this.submit(operator,row,x,options.authorize);
  if(kind!=='draft'&&pendingPhases.has(row.phase)&&row.phase!=='prepared')row=await this.reconcile(row.operation_id);
  await this.fresh(operator,kind==='apply'?'models.apply':'models.configure',options.authorize);
  const state=await this.stateWithin(this.db);return{...operationView(row,prepared.replayed),revision:state.revision,...this.envelope()};
 }
 saveDraft(operator,input,options){return this.command(operator,'draft',input,options);}
 apply(operator,input,options){return this.command(operator,'apply',input,options);}
 provisionCredential(operator,input,options){return this.command(operator,'credential-provision',input,options);}
 async overview(operator){
  const actor=await this.require(operator,'models.read'),before=await this.stateWithin(this.db);if(before.pending_operation)await this.reconcile(before.pending_operation);
  let native=null;try{native=await this.nativeStatus();}catch{/* Configuration presence never means a model was contacted. */}
  const state=await this.stateWithin(this.db),active=await this.versionWithin(this.db,state.active_id),draft=await this.versionWithin(this.db,state.draft_id),pending=state.pending_operation?await this.operationWithin(this.db,state.pending_operation):null;
  const current=await this.require(actor,'models.read'),permissions=current.businessAuthorization.permissions;
  const nativeMatches=!!native&&native.availability.state==='available'&&native.appliedVersionId===(state.active_id??null);
  return{revision:state.revision,active:versionView(active),draft:versionView(draft),pending:pending?operationView(pending):null,native,
   capabilities:{canConfigure:permissions.includes('models.configure')&&!pending,canProvisionCredentials:permissions.includes('models.configure')&&!!this.native,canApply:permissions.includes('models.apply')&&!pending&&!!draft&&nativeMatches},
   formats:[...modelSettingsFormats],domains:[...modelSettingsDomains],basis:{management:'human-only',providerSecrets:'protected-native-only',modelContact:'not-checked',capabilitySource:'manual-declaration',temperature:'not-configurable',billing:'not-provided'},...this.envelope()};
 }
 async operation(operator,id){
  const value=parseModelSettings(modelSettingsOperationSchema,id);await this.require(operator,'models.read');let row=await this.operationWithin(this.db,value);if(!row)fail('model_settings_operation_unavailable',404);
  if(pendingPhases.has(row.phase))row=await this.reconcile(value);await this.require(operator,'models.read');return{...operationView(row),...this.envelope()};
 }
 async history(operator,input={}){
  const query=parseModelSettings(modelSettingsHistorySchema,input);await this.require(operator,'models.read');
  const rows=(await this.db.query('SELECT o.*,v.version,p.display_name AS operator_display_name FROM operations_model_settings_operations_v1 o LEFT JOIN operations_model_settings_versions_v1 v ON v.id=o.version_id AND v.endpoint=o.endpoint LEFT JOIN operations_operator_principals_v1 p ON p.operator_id=o.operator_id AND p.endpoint=o.endpoint WHERE o.endpoint=$1 AND ($2::bigint IS NULL OR o.sequence<$2::bigint) ORDER BY o.sequence DESC LIMIT $3',[this.endpoint,query.after??null,query.limit+1])).rows;
  await this.require(operator,'models.read');return{items:rows.slice(0,query.limit).map(row=>({...operationView(row),sequence:String(row.sequence),operatorId:row.operator_id,operatorDisplayName:row.operator_display_name??null,version:row.version??null,changes:row.changes,reason:row.reason})),nextAfter:rows.length>query.limit?String(rows[query.limit-1].sequence):null,...this.envelope()};
 }
 async usage(operator,input={}){
  const query=parseModelSettings(modelSettingsUsageSchema,input);await this.require(operator,'models.read');let native=null;
  if(this.native)try{native=modelSettingsNativeUsage(await this.native.call({kind:'models-usage',days:query.days}));if(native.days!==query.days)fail('model_settings_native_response_invalid',503);}catch{native=null;/* Missing native usage is unknown, not zero. */}
  await this.require(operator,'models.read');return{availability:native?.availability??{state:'unavailable'},days:query.days,from:native?.from??null,to:native?.to??null,coverageFrom:native?.coverageFrom??null,coversWholeWindow:native?.coversWholeWindow??null,
   calls:native?.calls??{total:null,completed:null,failed:null,unknown:null},tokens:native?.tokens??{input:null,output:null,total:null,cachedInput:null,reasoning:null},unknownUsageCalls:native?.unknownUsageCalls??null,byScenario:native?.byScenario??[],byModel:native?.byModel??[],basis:{source:this.native?'native-model-gateway-ledger':'not-connected',billing:'not-provided'},...this.envelope()};
 }
 async authorizeNative(input){
  const x=parseModelSettings(modelSettingsNativeAuthorizationSchema,input);
  return transaction(this.db,async db=>{
   const row=await this.operationWithin(db,x.operationId),kind=x.kind==='models-apply'?'apply':'credential-provision';
   if(!row||row.kind!==kind||row.operator_id!==x.operatorId||!['submitting','pending','result-unknown'].includes(row.phase))fail('model_settings_execution_not_authorized',403);
   const actor=await this.require({kind:'business-operator',operatorId:row.operator_id,endpoint:this.endpoint,role:row.operator_role},kind==='apply'?'models.apply':'models.configure',db);
   if(kind==='apply'){
    const state=await this.stateWithin(db),version=await this.versionWithin(db,row.version_id);
    if(state.pending_operation!==row.operation_id||x.versionId!==row.version_id||x.revision!==row.input.expectedRevision||!version||!isDeepStrictEqual(x.configuration,version.configuration))fail('model_settings_execution_not_authorized',403);
   }else if(x.modelRecordId!==row.input.modelRecordId)fail('model_settings_execution_not_authorized',403);
   return{authorized:true,operationId:x.operationId,operatorId:actor.operatorId,kind:x.kind,endpoint:this.endpoint};
  });
 }
}

