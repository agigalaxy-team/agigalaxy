import {randomUUID,createHmac} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {request as httpRequest} from 'node:http';
import {MaintenanceControlJournal} from '../maintenance-agent/journal.mjs';
import {maintenanceRequestSignature} from '../../src/operations-maintenance-native.mjs';
import {systemSettingsNativeCommandSchema,systemSettingsOperationSchema,parseSystemSettings,credentialMetadata,safeSystemSettingsError} from '../../src/operations/system-settings/schema.mjs';
import {systemSettingsNativeOverviewSchema} from '../../src/operations/system-settings/read-model.mjs';

const failure=code=>Object.assign(Error(code),{code});
const terminal=new Set(['completed','partial','failed']);
const phase=(target,state,code=null,adoptedVersionId=null)=>({target,state,code,adoptedVersionId});
const stateOf=phases=>phases.length&&phases.every(x=>x.state==='completed')?'completed':phases.some(x=>x.state==='unknown'||x.state==='running'||x.state==='pending')?'unknown':phases.some(x=>x.state==='completed')?'partial':'failed';
function loopbackRequest(url,options){
 return new Promise((resolve,reject)=>{
  const request=httpRequest(url,{method:'POST',headers:{...options.headers,'content-length':Buffer.byteLength(options.body)}},response=>{
   const chunks=[];let size=0;
   response.on('data',chunk=>{size+=chunk.length;if(size>1048576){request.destroy();reject(failure('system_settings_native_response_invalid'));}else chunks.push(chunk);});
   response.on('error',()=>reject(failure('system_settings_native_unavailable')));
   response.on('end',()=>resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,text:async()=>Buffer.concat(chunks).toString('utf8')}));
  });
  request.setTimeout(5000,()=>request.destroy());request.on('error',()=>reject(failure('system_settings_native_unavailable')));request.end(options.body);
 });
}

// The existing private service identity signs only fixed loopback callbacks.
// The credential provisioning callback contains its binding, never its secret.
export class SystemSettingsControlClient{
 constructor({origin,host,serviceKey,fetchImpl=null,now=()=>new Date(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),retryMs=30000}){
  if(!/^http:\/\/127[.]0[.]0[.]1:[0-9]{1,5}$/.test(origin??'')||!/^[a-z0-9.-]+$/.test(host??''))throw failure('system_settings_control_not_configured');
  Object.assign(this,{origin,host,serviceKey,fetchImpl,now,pause,retryMs});
 }
 async request(route,input){
  if(!['authorize','mail'].includes(route))throw failure('system_settings_permission_denied');
  const body=JSON.stringify(input);if(Buffer.byteLength(body)>65536)throw failure('system_settings_private_configuration_invalid');
  const deadline=Date.now()+this.retryMs;let response;
  for(;;){
   const id=randomUUID(),at=String(Math.floor(this.now().getTime()/1000));
   try{response=await(this.fetchImpl??loopbackRequest)(this.origin+'/v1/internal/system-settings/'+route,{method:'POST',redirect:'error',cache:'no-store',headers:{
    Host:this.host,'content-type':'application/json','x-forwarded-for':'127.0.0.1','x-galaxy-service-key':this.serviceKey,
    'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(this.serviceKey,{id,at,body})},body,signal:AbortSignal.timeout(5000)});}catch{response=null;}
   if(response&&![502,503,504].includes(response.status)||Date.now()>=deadline)break;
   await this.pause(500);
  }
  if(!response)throw failure('system_settings_native_unavailable');
  let value;try{const text=await response.text();if(Buffer.byteLength(text)>1048576)throw Error();value=JSON.parse(text);}catch{throw failure('system_settings_native_response_invalid');}
  if(!response.ok)throw failure(response.status===403||response.status===401?'system_settings_permission_denied':safeSystemSettingsError({code:value?.error}));
  return value;
 }
 async authorize(intent){const value=await this.request('authorize',credentialMetadata(intent));if(value.authorized!==true||value.operationId!==intent.operationId||value.operatorId!==intent.operatorId)throw failure('system_settings_permission_denied');return value;}
}

/** One durable journal shared by all setting adapters. It never contains a
 * credential value. Restart recovery reads original effects; it never queues
 * another apply, connection test, restart or provision from a GET. */
export class SystemSettingsRuntime{
 constructor({directory,credentialStore,adapters,control,serviceKey,journal=null,now=()=>new Date()}){
  Object.assign(this,{credentialStore,adapters,control,serviceKey,now});
  this.journal=journal??new MaintenanceControlJournal({directory,now});this.tasks=new Map();this.serial=Promise.resolve();
 }
 initialize(){return this.journal.initialize();}
 safeIntent(input){
  if(input.kind!=='settings-credential-provision')return input;
  const canonical=Object.fromEntries(Object.entries(input.credential).sort(([a],[b])=>a.localeCompare(b)));
  return{...credentialMetadata(input),credentialDigest:createHmac('sha256',this.serviceKey).update(JSON.stringify(canonical)).digest('hex')};
 }
 adapter(section){const value=this.adapters?.[section];if(!value)throw failure('system_settings_control_not_configured');return value;}
 async overview(section){
  const adapter=this.adapter(section),value=await adapter.describe(),credentials=await this.credentialStore.metadata(section);
  const current=(value.items??[]).map(item=>({target:item.target??item.kind,state:item.state==='available'?'configured':item.state==='not-configured'?'not-configured':item.state==='unavailable'?'unavailable':'unknown',
   adoptedVersionId:item.adoptedVersionId??item.appliedVersionId??null,connectionId:item.connectionId??item.id??null,
   source:item.source??'consumer-ack',configured:item.credentialConfigured??item.configured??null}));
  const observed=value.observedConfiguration??null;
  for(const item of observed?.connections??[])if(item.credentialRef&&!credentials.some(row=>row.reference===item.credentialRef))credentials.push({reference:item.credentialRef,connectionId:item.id,configured:true});
  return parseSystemSettings(systemSettingsNativeOverviewSchema,{availability:{state:value.state==='available'?'available':value.state==='not-configured'?'not-configured':'unavailable'},
   current,credentials,observedConfiguration:observed,capabilities:{canTest:adapter.capabilities?.canTest!==false,
    canApply:adapter.capabilities?.canApply!==false,canWriteCredential:true}});
 }
 view(row){
  const value=structuredClone(row.systemSettings);
  if(row.state==='unknown'&&!this.tasks.has(row.id)&&!terminal.has(value.state)){
   value.state='unknown';value.phases=value.phases.map(item=>['pending','running'].includes(item.state)?{...item,state:'unknown',code:'system_settings_apply_unknown'}:item);
  }
  return parseSystemSettings(systemSettingsOperationSchema,value);
 }
 async persist(row,operation){row.systemSettings=parseSystemSettings(systemSettingsOperationSchema,operation);await this.journal.save(row);return row;}
 async finish(row,phases,{credentialRef}={}){
  const state=stateOf(phases),operation={...row.systemSettings,state,phases,finishedAt:terminal.has(state)?this.now().toISOString():null,...(credentialRef?{credentialRef}:{})};
  row.state=state==='completed'?'succeeded':state==='failed'?'failed':state==='partial'?'partial':'unknown';
  row.finishedAt=operation.finishedAt;await this.persist(row,operation);this.journal.active.delete(row.id);return row;
 }
 async execute(row,input){
  const authorize=()=>this.control.authorize(input);
  let effectStarted=false;
  try{
   await authorize();
   if(input.kind==='settings-credential-provision'){
    const {kind:_kind,operatorId:_operatorId,...provision}=input;effectStarted=true;const result=await this.credentialStore.provision(provision);await authorize();
    return this.finish(row,[phase('credential','completed')],{credentialRef:result.reference});
   }
   const adapter=this.adapter(input.section),args={versionId:input.versionId,configuration:input.configuration,...(input.connectionId?{connectionId:input.connectionId}:{})};
   effectStarted=true;const result=input.kind==='settings-test'?await adapter.test(args,{authorize}):await adapter.apply(args,{authorize,intent:input});
   const phases=result.phases??(result.items??[]).map(item=>({...phase(item.target??item.kind??item.id,item.state==='available'?'completed':item.state==='unknown'?'unknown':'failed',
    item.state==='available'?null:'system_settings_test_failed'),...(item.checks?{checks:item.checks}:{})}));
   if(!phases.length)throw failure('system_settings_configuration_incomplete');
   return this.finish(row,phases.map(item=>({...item,code:item.code===null?null:safeSystemSettingsError({code:item.code},input.kind==='settings-test'?'system_settings_test_failed':'system_settings_apply_unknown')})));
  }catch(error){return this.finish(row,[phase(input.kind==='settings-credential-provision'?'credential':'control',
   error?.code==='system_settings_permission_denied'&&!effectStarted?'failed':'unknown',safeSystemSettingsError(error))]);}
 }
 async reconcile(row){
  if(this.tasks.has(row.id)||terminal.has(row.systemSettings.state))return row;
  // Only positive adoption can resolve an interrupted apply. A missing ack is
  // not a negative proof of acceptance, and tests are never reissued here.
  if(row.intent.kind==='settings-apply')try{
   const result=await this.adapter(row.intent.section).readback({versionId:row.intent.versionId,configuration:row.intent.configuration});
   if(result.state==='completed'&&result.phases?.length)return this.finish(row,result.phases);
  }catch{/* The original operation remains unknown. */}
  if(row.systemSettings.state==='accepted')await this.finish(row,[phase('control','unknown','system_settings_apply_unknown')]);
  return row;
 }
 async operation(input){
  const row=await this.journal.read(input.operationId);if(!row)return{state:'not-recorded',operationId:input.operationId};
  if(row.intent.operatorId!==input.operatorId||row.intent.section!==input.section)throw failure('system_settings_permission_denied');
  return{state:'recorded',operation:this.view(await this.reconcile(row))};
 }
 async call(raw){
  const input=parseSystemSettings(systemSettingsNativeCommandSchema,raw);
  if(input.kind==='settings-overview')return this.overview(input.section);
  if(input.kind==='settings-operation')return this.operation(input);
  await this.control.authorize(input);
  const intent=this.safeIntent(input),prior=await this.journal.read(input.operationId);
  if(prior){if(!isDeepStrictEqual(prior.intent,intent))throw failure('system_settings_operation_changed');return{operation:this.view(await this.reconcile(prior)),replayed:true};}
  const begun=await this.journal.begin(intent),row=begun.row;
  if(!begun.created)return{operation:this.view(await this.reconcile(row)),replayed:true};
  const kind=input.kind==='settings-test'?'test':input.kind==='settings-apply'?'apply':'credential';
  await this.persist(row,{operationId:input.operationId,section:input.section,kind,state:'accepted',versionId:input.versionId??null,
   revision:input.revision??input.expectedRevision,phases:[phase('control','pending')],startedAt:row.startedAt,finishedAt:null});
  const task=this.serial.catch(()=>{}).then(()=>this.execute(row,input));this.serial=task;this.tasks.set(row.id,task);
  task.finally(()=>{if(this.tasks.get(row.id)===task)this.tasks.delete(row.id);}).catch(()=>{});
  return{operation:this.view(row),replayed:false};
 }
}
