import {timingSafeEqual} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createLocalReq} from 'payload';
import {sql} from '@payloadcms/db-postgres';
import {authenticatedCMS} from "../cms";
import {readOperatorSession,operationsRead} from "../operations.mjs";
import {adminEnvironment,operatorCookies,operatorForwardedAddress} from "../environment.mjs";
import {systemGeneralSaveSchema,systemGeneralApplySchema,parseSystemGeneral} from "../../../../../packages/galaxy-contracts/src/operations-system-general-schema.mjs";
import {systemGeneralIntent,generalConfigurationView} from './system-settings-general-metadata.mjs';

const failure=(code,status=503)=>Object.assign(Error(code),{code,status});
const stamp=()=>({checkedAt:Math.floor(Date.now()/1000),readExpiresAt:Math.floor(Date.now()/1000)+30,metadataOnly:true});
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const permissions=session=>session.operator.businessAuthorization?.permissions??[];
const epochIso=value=>new Date(value).toISOString();

async function authorize(headers,action,{post=false,operatorId=null}={}){
 const environment=adminEnvironment(),session=await readOperatorSession(headers);
 if(session.state!=='signed-in')throw failure('operator_login_required',401);
 if(operatorId&&session.operator.id!==operatorId)throw failure('business_admin_denied',403);
 if(!permissions(session).includes(action))throw failure('operations_permission_denied',403);
 if(post&&(headers.get('origin')!==environment.publicOrigin||!same(headers.get('x-galaxy-operator-csrf'),session.csrfToken)))throw failure('operator_csrf_invalid',403);
 return session;
}
async function context(headers,action,post=false){
 const session=await authorize(headers,action,{post}),cms=await authenticatedCMS(headers);
 if(!cms||cms.user.externalId!==session.operator.id)throw failure('operator_login_required',401);
 return{...cms,user:{...cms.user,businessAuthorization:session.operator.businessAuthorization},session};
}
async function execute(payload,query,transactionId=null){
 const db=transactionId?payload.db.sessions[transactionId]?.db:payload.db.drizzle;
 if(!db)throw failure('system_settings_source_unavailable');
 const result=await db.execute(query);return result.rows??result;
}
async function latest(payload,transactionId=null){
 const rows=await execute(payload,sql`SELECT id,version_system_general_revision AS revision,version_system_general_operation AS operation,created_at
  FROM _site_settings_v WHERE latest=true ORDER BY created_at DESC LIMIT 1`,transactionId);
 return rows[0]??null;
}
async function original(payload,id,transactionId=null){
 const rows=await execute(payload,sql`SELECT id,version_system_general_revision AS revision,version_system_general_operation AS operation,created_at
  FROM _site_settings_v WHERE version_system_general_operation->>'operationId'=${id} ORDER BY created_at ASC LIMIT 1`,transactionId);
 return rows[0]??null;
}
function metadataOperation(row){
 const item=row.operation,save=item.kind==='save';
 return{operationId:item.operationId,section:'general',kind:item.kind,state:save?'completed':'accepted',
  versionId:save?row.id:item.selection.versionId,revision:Number(item.revision),phases:[],startedAt:item.startedAt,
  finishedAt:save?epochIso(row.created_at):null};
}
async function publicationSource(headers){
 try{return await operationsRead(headers,'/v1/operations/system-settings/general/publication');}
 catch{return{publication:{id:null,state:'unavailable'}};}
}
export async function readGeneralSettings(headers){
 const cms=await context(headers,'system.settings.read'),value=await cms.payload.findGlobal({slug:'site-settings',draft:true,depth:0,overrideAccess:true,user:cms.user}),
  [current,publication]=await Promise.all([latest(cms.payload),publicationSource(headers)]),revision=Number(current?.revision??0),configuration=generalConfigurationView(value);
 await authorize(headers,'system.settings.read',{operatorId:cms.session.operator.id});
 const allowed=permissions(cms.session);
 return{section:'general',revision,configuration,version:current?{id:current.id,revision,configuration,createdAt:epochIso(current.created_at)}:null,
  publication:publication.publication,logo:{href:'/brand-logo.png',source:'fixed-brand-asset',canReplace:false},
  favicon:{href:'https://agigalaxy.org/favicon.svg',source:'fixed-brand-asset',canReplace:false},
  capabilities:{canRead:true,canSave:allowed.includes('system.settings.configure'),canApply:allowed.includes('system.settings.apply')&&publication.publication.state==='available',canReplaceLogo:false},...stamp()};
}
async function mutateGeneral(headers,input,kind){
 const data=parseSystemGeneral(kind==='save'?systemGeneralSaveSchema:systemGeneralApplySchema,input),action=kind==='save'?'system.settings.configure':'system.settings.apply',cms=await context(headers,action,true);
 const transactionId=await cms.payload.db.beginTransaction();if(!transactionId)throw failure('system_settings_source_unavailable');
 let diagnosticStage='general-transaction';
 try{
  await execute(cms.payload,sql`SELECT pg_advisory_xact_lock(734912465)`,transactionId);
  diagnosticStage='general-original';
  const old=await original(cms.payload,data.operationId,transactionId);
  if(old){
   if(old.operation.operatorId!==cms.session.operator.id||old.operation.kind!==kind||!isDeepStrictEqual(old.operation.selection.input,data))throw failure('system_settings_operation_changed',409);
   await cms.payload.db.commitTransaction(transactionId);return{cms,data,row:old,replayed:true};
  }
  diagnosticStage='general-head';
  const current=await latest(cms.payload,transactionId),revision=Number(current?.revision??0);
  if(revision!==data.expectedRevision||kind==='apply'&&current?.id!==data.versionId)throw failure('system_settings_version_changed',409);
  diagnosticStage='general-request';
  const request=await createLocalReq({user:cms.user,req:{headers,transactionID:transactionId}},cms.payload);
  request.query={...request.query,draft:kind==='save'};
  let configuration=kind==='save'?data.configuration:generalConfigurationView(await cms.payload.findGlobal({slug:'site-settings',draft:true,depth:0,overrideAccess:true,user:cms.user,req:request}));
  let publication=null;
  if(kind==='apply'){
   publication=await publicationSource(headers);if(publication.publication.state!=='available')throw failure('system_settings_source_changed',409);
  }
  request.context[systemGeneralIntent]={operationId:data.operationId,operatorId:cms.session.operator.id,kind,expectedRevision:revision,
   startedAt:new Date().toISOString(),selection:{input:data,...(kind==='apply'?{versionId:data.versionId,publicationInput:{operationId:data.operationId,
    expectedPublicationId:publication.publication.id,settingsRevision:revision,versionId:data.versionId,settings:configuration}}:{})}};
  await authorize(headers,action,{post:true,operatorId:cms.session.operator.id});
  diagnosticStage='general-update';
  // Payload treats a Symbol-only req.context as empty unless context is passed explicitly.
  await cms.payload.updateGlobal({slug:'site-settings',draft:kind==='save',depth:0,overrideAccess:true,user:cms.user,req:request,context:request.context,
   data:{...configuration,_status:kind==='save'?'draft':'published'}});
  diagnosticStage='general-receipt';
  const row=await latest(cms.payload,transactionId);if(row?.operation?.operationId!==data.operationId)throw failure('system_settings_source_unavailable');
  await authorize(headers,action,{post:true,operatorId:cms.session.operator.id});
  await cms.payload.db.commitTransaction(transactionId);return{cms,data,row,replayed:false,configuration};
 }catch(error){if(error&&typeof error==='object')error.systemSettingsStage=diagnosticStage;await cms.payload.db.rollbackTransaction(transactionId);throw error;}
}
export async function saveGeneralSettings(headers,input){
 const value=await mutateGeneral(headers,input,'save');return{operation:metadataOperation(value.row),
  version:{id:value.row.id,revision:Number(value.row.revision),configuration:value.configuration??value.row.operation.selection.input.configuration,createdAt:epochIso(value.row.created_at)},
  replayed:value.replayed,...stamp()};
}
async function publishGeneral(headers,input){
 const environment=adminEnvironment(),session=await authorize(headers,'system.settings.apply',{post:true});
 const response=await fetch(environment.bffOrigin+'/v1/operations/system-settings/general/publish',{method:'POST',headers:{
  Accept:'application/json','Content-Type':'application/json',Cookie:operatorCookies(headers,environment.fixtureCookies),Origin:environment.publicOrigin,
  'X-Galaxy-Operator-CSRF':session.csrfToken,'X-Forwarded-For':operatorForwardedAddress(headers,environment.fixtureCookies)},
  body:JSON.stringify(input),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
 const text=await response.text();if(Buffer.byteLength(text)>1048576)throw failure('system_settings_source_unavailable');
 let value;try{value=JSON.parse(text);}catch{throw failure('system_settings_source_unavailable');}
 if(!response.ok)throw failure(['system_settings_source_changed','system_settings_operation_changed','operations_permission_denied'].includes(value?.error)?value.error:'system_settings_source_unavailable',response.status<500?response.status:503);
 return value;
}
export async function applyGeneralSettings(headers,input){
 const value=await mutateGeneral(headers,input,'apply');
 // The native CMS claim precedes publication. A repeated accepted request only
 // queries its original ID; this endpoint never turns a lost ACK into a new ID.
 if(value.replayed)return readGeneralSettingsOperation(headers,value.data.operationId);
 try{const result=await publishGeneral(headers,value.row.operation.selection.publicationInput);return{...result,replayed:false};}
 catch{return{operation:{...metadataOperation(value.row),state:'unknown'},replayed:false,...stamp()};}
}
export async function readGeneralSettingsOperation(headers,id){
 if(typeof id!=='string'||!uuid.test(id))throw failure('invalid_system_settings_request',400);
 const cms=await context(headers,'system.settings.read'),row=await original(cms.payload,id);
 if(!row){await authorize(headers,'system.settings.read',{operatorId:cms.session.operator.id});
  return{state:'unknown',operationId:id,operation:null,basis:'native-version-history-may-have-expired',...stamp()};}
 if(row.operation.operatorId!==cms.session.operator.id)throw failure('operations_permission_denied',403);
 let operation=metadataOperation(row);
 if(operation.kind==='apply'){
  try{
   const result=await operationsRead(headers,'/v1/operations/system-settings/general/operations/'+id);
   if(result.state==='recorded'&&result.operation?.operationId===id)operation=result.operation;
   else operation={...operation,state:'unknown'};
  }catch{operation={...operation,state:'unknown'};}
 }
 await authorize(headers,'system.settings.read',{operatorId:cms.session.operator.id});return{state:'recorded',operationId:id,operation,...stamp()};
}
