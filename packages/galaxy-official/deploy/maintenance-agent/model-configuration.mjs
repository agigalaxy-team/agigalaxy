import {mkdir,readFile,lstat,readdir,writeFile,chown,chmod,rename} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {atomicWrite,noSymlinkPath,runCommand} from '../operations-stack/host.mjs';
import {MaintenanceControlJournal} from './journal.mjs';
import {maintenanceRequestSignature} from "../support/maintenance-signature.mjs";
import {modelSettingsNativeCommandSchema} from '../../../galaxy-contracts/src/operations-model-settings-schema.mjs';
import {compileModelConfiguration,credentialVariable,recordIdFromAlias} from './model-configuration-codec.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const failure=code=>Object.assign(new Error(code),{code});
const unavailableUsage=days=>({availability:{state:'unavailable'},days,from:null,to:null,coverageFrom:null,coversWholeWindow:false,
 calls:{total:null,completed:null,failed:null,unknown:null},tokens:{input:null,output:null,total:null,cachedInput:null,reasoning:null},unknownUsageCalls:null,byScenario:[],byModel:[]});
function operationView(row){
 if(!row)return null;
 return{id:row.id,kind:row.kind,state:row.state==='succeeded'?'completed':row.state,code:row.code??null,
  ...(row.credentialRef?{credentialRef:row.credentialRef}:{}),startedAt:row.startedAt,finishedAt:row.finishedAt};
}
async function privateJson(file,{maxBytes=262144,groupReadable=false}={}){
 await noSymlinkPath(file);const s=await lstat(file);
 if(!s.isFile()||s.isSymbolicLink()||(s.mode&(groupReadable?0o027:0o077))||s.size>maxBytes)throw failure('model_settings_private_file_invalid');
 return JSON.parse(await readFile(file,'utf8'));
}
async function environment(file){
 await noSymlinkPath(file);const s=await lstat(file);
 if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>65536)throw failure('model_settings_private_file_invalid');
 const result={};for(const line of (await readFile(file,'utf8')).split(/\r?\n/)){
  if(!line||line.startsWith('#'))continue;const m=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if(!m||/[\p{Cc}]/u.test(m[2]))throw failure('model_settings_private_file_invalid');result[m[1]]=m[2];
 }return result;
}

export async function readModelConfigurationControl(file='/etc/galaxy/model-settings/control.json'){
 if(file!=='/etc/galaxy/model-settings/control.json')throw failure('model_settings_private_file_invalid');
 const s=await lstat(file);if(s.uid!==0)throw failure('model_settings_private_file_invalid');
 const x=await privateJson(file,{maxBytes:8192});
 if(x?.version!==1||Object.keys(x).some(key=>!['version','composeFile','composeProject'].includes(key))
  ||x.composeProject!=='galaxy-model-runtime'||!/^\/opt\/galaxy\/operations-engines\/releases\/(?:model-settings|workbench-live)-[a-z0-9-]+\/compose[.]yaml$/.test(x.composeFile??''))
  throw failure('model_settings_private_file_invalid');
 await noSymlinkPath(x.composeFile);const compose=await lstat(x.composeFile);
 if(!compose.isFile()||compose.isSymbolicLink()||compose.uid!==0||(compose.mode&0o022)||compose.size>65536)
  throw failure('model_settings_private_file_invalid');return x;
}

export class ModelConfigurationRuntime{
 constructor({configuration,control,root='/etc/galaxy/model-settings',journal=null,run=runCommand,fetchImpl=fetch,now=()=>new Date(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),authorize=null}){
  Object.assign(this,{configuration,control,root,run,fetchImpl,now,pause,authorization:authorize});
  this.journal=journal??new MaintenanceControlJournal({directory:configuration.controlDirectory+'/models',now});this.tasks=new Map();this.busy=null;
 }
 async initialize(){await noSymlinkPath(this.root);await mkdir(this.root,{recursive:true,mode:0o700});await mkdir(this.root+'/keys',{recursive:true,mode:0o700});await mkdir(this.root+'/versions',{recursive:true,mode:0o700});await this.journal.initialize();}
 async key(reference){
  const id=reference?.slice(10);if(!reference?.startsWith('model-key:')||!uuid.test(id??''))throw failure('model_settings_credential_unavailable');
  const key=await privateJson(this.root+'/keys/'+id+'.json',{maxBytes:32768});
  if(key.reference!==reference||!uuid.test(key.modelRecordId??'')||typeof key.apiKey!=='string'||!key.apiKey||/[\p{Cc}]/u.test(key.apiKey))throw failure('model_settings_credential_unavailable');
  return key;
 }
 async credentials(){
  const files=await readdir(this.root+'/keys');if(files.length>1000)throw failure('model_settings_credential_catalog_limit');const result=[];
  for(const file of files){if(!file.endsWith('.json')||!uuid.test(file.slice(0,-5)))continue;
   const key=await this.key('model-key:'+file.slice(0,-5));result.push({reference:key.reference,modelRecordId:key.modelRecordId,configured:true});}
  return result;
 }
 async active(){try{return await privateJson(this.root+'/applied.json');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async json(url,key){
  const response=await this.fetchImpl(url,{headers:{authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw failure('model_settings_engine_unavailable');const body=await response.text();if(Buffer.byteLength(body)>1048576)throw failure('model_settings_engine_response_invalid');return JSON.parse(body);
 }
 async engineState(){
  const missing=()=>({state:'unavailable',configurationVersion:null});let gateway={...missing(),modelCount:null},agentos={...missing(),configuredScenarios:[]};
  await Promise.allSettled([
   (async()=>{const env=await environment('/etc/galaxy/model-gateway/runtime.env'),x=await this.json('http://127.0.0.1:3351/galaxy/status',env.GALAXY_MODEL_GATEWAY_SERVICE_KEY);
    if(x.engine!=='litellm-proxy'||x.state!=='running'||!Number.isSafeInteger(x.modelCount))throw failure('model_settings_engine_response_invalid');
    gateway={state:'running',configurationVersion:x.configVersion,modelCount:x.modelCount};})(),
   (async()=>{const env=await environment('/etc/galaxy/agentos/runtime.env'),x=await this.json('http://127.0.0.1:3350/galaxy/model-settings',env.GALAXY_AGENTOS_SERVICE_KEY);
    if(!Array.isArray(x.scenarios)||x.scenarios.length!==5)throw failure('model_settings_engine_response_invalid');
    agentos={state:'running',configurationVersion:x.version,configuredScenarios:x.scenarios.filter(row=>row.state==='configured').map(row=>row.domain).sort()};})(),
  ]);return{gateway,agentos};
 }
 async overview(){
  const [active,engines,credentials]=await Promise.all([this.active(),this.engineState(),this.credentials()]);
  const same=engines.gateway.configurationVersion&&engines.gateway.configurationVersion===engines.agentos.configurationVersion;
  return{availability:{state:'available'},configurationVersion:same?engines.gateway.configurationVersion:null,
   appliedVersionId:active&&same&&active.configurationVersion===engines.gateway.configurationVersion?active.versionId:null,engines,credentials};
 }
 async usage(days){
  try{const env=await environment('/etc/galaxy/model-gateway/runtime.env'),value=await this.json('http://127.0.0.1:3351/galaxy/usage?days='+days,env.GALAXY_MODEL_GATEWAY_SERVICE_KEY);
   if(value.days!==days||!Array.isArray(value.byModel)||!Array.isArray(value.byScenario))throw failure('model_settings_engine_response_invalid');
   const byModel=value.byModel.map(row=>({...row,modelRecordId:recordIdFromAlias(row.modelAlias)}));
   if(byModel.some(row=>!row.modelRecordId))return unavailableUsage(days);
   return{...value,byModel:byModel.map(({modelAlias:_modelAlias,...row})=>row),byScenario:value.byScenario.map(({scenario,...row})=>({...row,domain:scenario}))};
  }catch{return unavailableUsage(days);}
 }
 async authorize(intent){
  const safe={...intent};delete safe.apiKey;
  if(this.authorization)return this.authorization(safe);
  const url=this.configuration.authorizationUrl.replace('/maintenance/authorize','/models/authorize');
  if(!/^http:\/\/127[.]0[.]0[.]1:[0-9]{1,5}\/v1\/internal\/models\/authorize$/.test(url))throw failure('model_settings_authorization_unavailable');
  const body=JSON.stringify(safe),id=randomUUID(),at=String(Math.floor(this.now().getTime()/1000));
  let response;
  try{response=await this.fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'127.0.0.1','x-galaxy-service-key':this.configuration.serviceKey,
   'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(this.configuration.serviceKey,{id,at,body})},body,signal:AbortSignal.timeout(5000)});}
  catch{throw failure('model_settings_authorization_unavailable');}
  if(!response.ok)throw failure([401,403].includes(response.status)?'model_settings_permission_denied':'model_settings_authorization_unavailable');
  let x;try{const text=await response.text();if(Buffer.byteLength(text)>8192)throw Error();x=JSON.parse(text);}catch{throw failure('model_settings_authorization_unavailable');}
  if(x.authorized===false)throw failure('model_settings_permission_denied');
  if(x.authorized!==true||x.operationId!==intent.operationId||x.operatorId!==intent.operatorId||x.kind!==intent.kind)throw failure('model_settings_authorization_unavailable');
 }
 async finish(row,error=null,{unknown=false}={}){
  row.state=error?(unknown?'unknown':'failed'):'succeeded';row.finishedAt=this.now().toISOString();row.code=error&&/^(?:model_settings|models)_[a-z_]{1,80}$/.test(error.code??'')?error.code:error?'model_settings_execution_failed':null;
  await this.journal.save(row);this.journal.active.delete(row.id);return row;
 }
 matches(engines,compiled){return engines.gateway.state==='running'&&engines.agentos.state==='running'
  &&engines.gateway.configurationVersion===compiled.configurationVersion&&engines.agentos.configurationVersion===compiled.configurationVersion
  &&engines.gateway.modelCount===compiled.modelCount&&isDeepStrictEqual([...engines.agentos.configuredScenarios].sort((a,b)=>a<b?-1:a>b?1:0),[...compiled.configuredScenarios].sort((a,b)=>a<b?-1:a>b?1:0));}
 async waitFor(compiled){
  // Native Proxy imports alone can take longer than the former eleven-second
  // window. Bound the complete readiness wait, including slow HTTP responses.
  const deadline=this.now().getTime()+90000;
  for(let attempt=0;attempt<90;attempt++){
   if(this.matches(await this.engineState(),compiled))return true;
   const remaining=deadline-this.now().getTime();if(remaining<=0)return false;
   if(attempt<89)await this.pause(Math.min(1000,remaining));
  }return false;
 }
 async activeFilesMatch(configurationVersion){
  if(!/^(?:models-[a-f0-9-]{36}|unconfigured-v1)$/.test(configurationVersion))return false;
  try{
   for(const name of ['models.yaml','bindings.json','provider.env','active.env']){
    const current=this.root+'/'+name,source=this.root+'/versions/'+configurationVersion+'/'+name;
    await noSymlinkPath(current);await noSymlinkPath(source);
    if(!(await readFile(current)).equals(await readFile(source)))return false;
   }return true;
  }catch{return false;}
 }
 async writeVersion(intent,compiled){
  const directory=this.root+'/versions/'+compiled.configurationVersion;await noSymlinkPath(directory);
  try{await lstat(directory);
   const prior=await privateJson(directory+'/metadata.json');if(prior.versionId!==intent.versionId||!isDeepStrictEqual(prior.configuration,intent.configuration))throw failure('model_settings_version_changed');return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const preparing=this.root+'/versions/.preparing-'+intent.operationId;await noSymlinkPath(preparing);await mkdir(preparing,{mode:0o700});
  const lines=[];for(const model of intent.configuration.models.filter(row=>row.enabled)){const key=await this.key(model.credentialRef);
   if(key.modelRecordId!==model.id)throw failure('model_settings_credential_unavailable');lines.push(credentialVariable(key.reference)+'='+key.apiKey);}
  await atomicWrite(preparing+'/models.yaml',JSON.stringify(compiled.gateway)+'\n');
  await atomicWrite(preparing+'/bindings.json',JSON.stringify(compiled.agentos)+'\n');
  await atomicWrite(preparing+'/provider.env',lines.join('\n')+(lines.length?'\n':''));
  await atomicWrite(preparing+'/active.env','GALAXY_MODEL_GATEWAY_CONFIG_VERSION='+compiled.configurationVersion+'\n');
  await atomicWrite(preparing+'/metadata.json',JSON.stringify({version:1,versionId:intent.versionId,configuration:intent.configuration,...compiled,gateway:undefined,agentos:undefined})+'\n');
  await rename(preparing,directory);
 }
 async activateFiles(configurationVersion){
  if(!/^(?:models-[a-f0-9-]{36}|unconfigured-v1)$/.test(configurationVersion))throw failure('model_settings_version_changed');
  for(const [name,gid] of [['models.yaml',10002],['bindings.json',10001],['provider.env',null],['active.env',null]]){
   const source=this.root+'/versions/'+configurationVersion+'/'+name;await noSymlinkPath(source);const s=await lstat(source);
   if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw failure('model_settings_private_file_invalid');
   const target=this.root+'/'+name;await atomicWrite(target,await readFile(source));if(gid!==null){await chown(target,0,gid);await chmod(target,0o640);}
  }
 }
 async restart(){
  if(!this.control?.composeFile||this.control.composeProject!=='galaxy-model-runtime')throw failure('model_settings_control_not_configured');
  await this.run(this.configuration.operations.tools.docker,['compose','-p',this.control.composeProject,'-f',this.control.composeFile,
   'up','-d','--no-build','--pull','never','--force-recreate','model-gateway','agentos'],{timeout:90000,maxOutput:65536});
 }
 async perform(intent,row){
  if(intent.kind==='models-credential-provision'){
   await this.authorize(intent);const reference='model-key:'+intent.operationId;
   row.phase='credential-writing';await this.journal.save(row);
   await writeFile(this.root+'/keys/'+intent.operationId+'.json',JSON.stringify({version:1,reference,modelRecordId:intent.modelRecordId,apiKey:intent.apiKey,createdAt:this.now().toISOString()})+'\n',{flag:'wx',mode:0o600});
   row.credentialRef=reference;return this.finish(row);
  }
  const compiled=compileModelConfiguration(intent.configuration,intent.versionId,await this.credentials()),previous=await this.active();
  await this.writeVersion(intent,compiled);await this.authorize(intent);row.previous=previous;row.phase='activating';await this.journal.save(row);
  try{await this.activateFiles(compiled.configurationVersion);await this.authorize(intent);}
  catch(error){if(previous){try{await this.activateFiles(previous.configurationVersion);return this.finish(row,error);}catch{}}return this.finish(row,error,{unknown:true});}
  row.phase='restart-requested';await this.journal.save(row);
  try{await this.restart();row.restartAcknowledged=true;}catch{row.restartAcknowledged=false;/* Read actual versions even if Docker's acknowledgement was lost. */}
  row.phase='waiting-for-engines';await this.journal.save(row);
  if(await this.waitFor(compiled)){
   await atomicWrite(this.root+'/applied.json',JSON.stringify({version:1,versionId:intent.versionId,configurationVersion:compiled.configurationVersion,modelCount:compiled.modelCount,configuredScenarios:compiled.configuredScenarios})+'\n');return this.finish(row);
  }
  if(previous){
   // One rollback to the previously observed configuration. A lost rollback
   // receipt remains unknown until both versions and the active files agree.
   row.phase='rollback-requested';await this.journal.save(row);
   try{await this.activateFiles(previous.configurationVersion);await this.restart();if(await this.waitFor(previous))return this.finish(row,failure('model_settings_application_failed_rolled_back'));}catch{}
  }
  return this.finish(row,failure('model_settings_application_result_unknown'),{unknown:true});
 }
 async operation(id){
  const row=await this.journal.read(id);if(!row||!['models-apply','models-credential-provision'].includes(row.kind))return null;
  if(row.state==='unknown'&&!this.tasks.has(id)){
   if(row.kind==='models-credential-provision'){
    try{const key=await this.key('model-key:'+id);if(key.modelRecordId===row.intent.modelRecordId){row.credentialRef=key.reference;await this.finish(row);}}catch{}
   }else{
    const compiled=compileModelConfiguration(row.intent.configuration,row.intent.versionId,await this.credentials());
    const engines=await this.engineState();
    if(this.matches(engines,compiled)){
     await atomicWrite(this.root+'/applied.json',JSON.stringify({version:1,versionId:row.intent.versionId,configurationVersion:compiled.configurationVersion,modelCount:compiled.modelCount,configuredScenarios:compiled.configuredScenarios})+'\n');await this.finish(row);
    }else if(!row.recoveryAttempt&&!this.busy&&['restart-requested','waiting-for-engines','rollback-requested'].includes(row.phase)){
     const previous=row.previous??await this.active();
     if(previous&&previous.configurationVersion!==compiled.configurationVersion&&this.matches(engines,previous)&&await this.activeFilesMatch(previous.configurationVersion)){
      // This is no longer an unknown effect: both engines and every active
      // file prove rollback. Continue the same approved intent once, after a
      // fresh authorization; never duplicate keys or contact a model here.
      if(this.busy)return operationView(row);this.busy=id;
      try{
       await this.authorize(row.intent);row.recoveryAttempt=1;row.state='running';row.code=null;row.finishedAt=null;row.phase='resuming-verified-rollback';
       await this.journal.save(row);this.journal.active.add(id);this.launch(row.intent,row);
      }catch(error){this.busy=null;if(error.code==='model_settings_permission_denied')await this.finish(row,error);else throw error;}
     }
    }
   }
  }return operationView(row);
 }
 async start(intent){
  await this.authorize(intent);const safe={...intent};delete safe.apiKey;
  const old=await this.journal.read(intent.operationId);if(old){if(!isDeepStrictEqual(old.intent,safe))throw failure('model_settings_operation_conflict');return this.result(await this.operation(intent.operationId));}
  if(this.busy)throw failure('model_settings_native_busy');
  const started=await this.journal.begin(safe);if(!started.created)return this.result(operationView(started.row));
  this.launch(intent,started.row);return this.result(operationView(started.row));
 }
 launch(intent,row){
  this.busy=intent.operationId;
  const task=this.perform(intent,row).catch(error=>this.finish(row,error,{unknown:['credential-writing','activating','restart-requested','waiting-for-engines','rollback-requested'].includes(row.phase)})).finally(()=>{this.tasks.delete(intent.operationId);this.busy=null;this.journal.active.delete(intent.operationId);});
  this.tasks.set(intent.operationId,task);
 }
 result(operation){return{operation,...(operation?.credentialRef?{credential:{reference:operation.credentialRef,modelRecordId:null,configured:true}}:{})};}
 async call(input){
  const parsed=modelSettingsNativeCommandSchema.safeParse(input);if(!parsed.success)throw failure('model_settings_native_request_invalid');const x=parsed.data;
  if(x.kind==='models-overview')return this.overview();if(x.kind==='models-usage')return this.usage(x.days);if(x.kind==='models-operation')return{operation:await this.operation(x.operationId)};
  const result=await this.start(x);
  if(result.credential)result.credential.modelRecordId=x.modelRecordId;
  return result;
 }
}
