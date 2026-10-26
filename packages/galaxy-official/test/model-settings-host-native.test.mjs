import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {compileModelConfiguration,modelAlias,recordIdFromAlias} from '../deploy/maintenance-agent/model-configuration-codec.mjs';
import {ModelConfigurationRuntime} from '../deploy/maintenance-agent/model-configuration.mjs';
import {createMaintenanceNativeHttpServer} from '../deploy/maintenance-agent/server.mjs';
import {modelSettingsNativeCredential,modelSettingsNativeOperation,modelSettingsNativeStatus} from '../src/operations-model-settings-native.mjs';
import {maintenanceRequestSignature} from '../src/operations-maintenance-native.mjs';

const domains=['overview','governance','messaging','discovery','maintenance'];
const empty=()=>({models:[],scenarios:Object.fromEntries(domains.map(domain=>[domain,null]))});
const fixtureModel=(id,ref,apiFormat='openai-chat')=>({id,displayName:'本地合成模型',modelId:'synthetic-model',apiFormat,
 baseUrl:'http://127.0.0.1:9/v1',credentialRef:ref,contextWindow:8192,maxOutputTokens:512,timeoutSeconds:30,
 reasoning:{mode:'effort',effort:'medium',supportedEfforts:['low','medium','high'],supportSource:'manual'},
 toolCalling:true,structuredOutput:true,enabled:true});
const state=(version='unconfigured-v1',count=0,configured=[])=>({gateway:{state:'running',configurationVersion:version,modelCount:count},
 agentos:{state:'running',configurationVersion:version,configuredScenarios:configured}});
const control={composeFile:'/opt/galaxy/operations-engines/releases/model-settings-fixture/compose.yaml',composeProject:'galaxy-model-runtime'};

test('model compiler maps four native formats, exact limits and approved domains without credentials in outputs',()=>{
 for(const apiFormat of ['openai-chat','openai-responses','anthropic','gemini']){
  const id=randomUUID(),reference='model-key:'+randomUUID(),versionId=randomUUID(),configuration=empty();
  configuration.models.push(fixtureModel(id,reference,apiFormat));configuration.scenarios.governance={modelId:id,dataPolicyApproved:true};
  const compiled=compileModelConfiguration(configuration,versionId,[{reference,modelRecordId:id,configured:true}]);
  assert.equal(compiled.configurationVersion,'models-'+versionId);assert.equal(compiled.modelCount,1);
  assert.equal(compiled.gateway.model_list[0].model_name,modelAlias(id));assert.equal(recordIdFromAlias(modelAlias(id)),id);
  assert.equal(compiled.gateway.model_list[0].model_info.max_input_tokens,7680);
  assert.equal(compiled.agentos.scenarios.governance.runtimeProfile.maxOutputTokens,512);
  assert.equal(compiled.agentos.scenarios.governance.runtimeProfile.reasoningEffort,'medium');
  assert.deepEqual(compiled.configuredScenarios,['governance']);assert.equal(compiled.agentos.scenarios.overview,null);
  assert.match(compiled.gateway.model_list[0].litellm_params.api_key,/^os.environ\/GALAXY_MODEL_PROVIDER_C[A-F0-9]{32}_KEY$/);
  assert.doesNotMatch(JSON.stringify(compiled),/temperature|top_p|budget/);
  configuration.models[0].toolCalling=false;
  assert.throws(()=>compileModelConfiguration(configuration,versionId,[{reference,modelRecordId:id,configured:true}]),{code:'model_settings_configuration_invalid'});
 }
 assert.equal(recordIdFromAlias('unrelated-default'),null);
});

test('root configuration keeps immutable key versions and unknown operations, applies only with two real version receipts',{skip:process.platform==='win32'?'Private Unix file-mode journal requires the Linux host runtime.':false},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-p20-control-'));
 let observed=state(),restartCount=0,authorizations=0,allow=true;
 const configuration={controlDirectory:directory+'/journal',operations:{tools:{docker:'/usr/bin/docker'}}};
 const runtime=new ModelConfigurationRuntime({configuration,control,root:directory+'/models',pause:async()=>{},
  authorize:async intent=>{assert.equal('apiKey'in intent,false);authorizations++;if(!allow)throw Object.assign(Error('closed'),{code:'model_settings_permission_denied'});},
  run:async(binary,args)=>{restartCount++;assert.equal(binary,'/usr/bin/docker');assert.deepEqual(args.slice(-2),['model-gateway','agentos']);
   const bindings=JSON.parse(await readFile(directory+'/models/bindings.json','utf8'));
   observed=state(bindings.version,1,['governance']);throw Error('Synthetic lost command acknowledgement');}});
 runtime.engineState=async()=>structuredClone(observed);
 try{
  await runtime.initialize();const id=randomUUID(),credentialId=randomUUID(),operatorId=randomUUID(),apiKey='SYNTHETIC_PRIVATE_KEY_NOT_A_PROVIDER';
  const provision={kind:'models-credential-provision',operationId:credentialId,operatorId,modelRecordId:id,apiKey};
  await runtime.call(provision);await Promise.all(runtime.tasks.values());
  const credential=modelSettingsNativeCredential((await runtime.call(provision)).credential);
  assert.equal(credential.reference,'model-key:'+credentialId);assert.equal(credential.modelRecordId,id);
  assert.equal((await lstat(directory+'/models/keys/'+credentialId+'.json')).mode&0o777,0o600);
  const journalFile=directory+'/journal/models/'+credentialId+'.json';
  assert.doesNotMatch(await readFile(journalFile,'utf8'),new RegExp(apiKey));
  const config=empty();config.models.push(fixtureModel(id,credential.reference));config.scenarios.governance={modelId:id,dataPolicyApproved:true};
  const intent={kind:'models-apply',operationId:randomUUID(),operatorId,versionId:randomUUID(),revision:1,configuration:config};
  await runtime.call(intent);await Promise.all(runtime.tasks.values());
  const applied=modelSettingsNativeOperation((await runtime.call({kind:'models-operation',operationId:intent.operationId})).operation);
  assert.equal(applied.state,'completed');assert.equal(restartCount,1);
  const overview=modelSettingsNativeStatus(await runtime.call({kind:'models-overview'}));
  assert.equal(overview.appliedVersionId,intent.versionId);assert.equal(overview.credentials.length,1);assert.doesNotMatch(JSON.stringify(overview),new RegExp(apiKey));
  await runtime.call(intent);assert.equal(restartCount,1);
  const version=JSON.parse(await readFile(directory+'/models/versions/models-'+intent.versionId+'/metadata.json','utf8'));
  assert.doesNotMatch(JSON.stringify(version),new RegExp(apiKey));
  const secondCredential={...provision,operationId:randomUUID(),apiKey:apiKey+'_ROTATED'};
  await runtime.call(secondCredential);await Promise.all(runtime.tasks.values());
  assert.equal((await runtime.credentials()).length,2);assert.equal((await runtime.key(credential.reference)).apiKey,apiKey);
  // Simulate interruption after an actual effect and before its terminal ack.
  const lostId=randomUUID(),lost={...intent,operationId:lostId};
  const started=await runtime.journal.begin(lost);runtime.journal.active.delete(lostId);
  assert.equal(started.created,true);
  assert.equal((await runtime.call({kind:'models-operation',operationId:lostId})).operation.state,'completed');assert.equal(restartCount,1);
  const pending={...intent,operationId:randomUUID(),versionId:randomUUID()};
  await runtime.journal.begin(pending);runtime.journal.active.delete(pending.operationId);
  assert.equal((await runtime.call({kind:'models-operation',operationId:pending.operationId})).operation.state,'unknown');assert.equal(restartCount,1);
  allow=false;
  await assert.rejects(runtime.call({...intent,operationId:randomUUID()}),{code:'model_settings_permission_denied'});
  assert.equal(restartCount,1);assert.ok(authorizations>=5);
  for(const file of await readdir(directory+'/journal/models'))assert.doesNotMatch(await readFile(directory+'/journal/models/'+file,'utf8'),new RegExp(apiKey));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('model control uses the authenticated signed private socket route and never dispatches unauthorized request bodies',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-p20-socket-')),socketPath=process.platform==='win32'?'\\\\.\\pipe\\galaxy-model-control-'+randomUUID():directory+'/control.sock';
 const serviceKey='SYNTHETIC_ROOT_CONTROL_KEY_NOT_A_PROVIDER_00000';let dispatched=0;
 const server=createMaintenanceNativeHttpServer({runtime:{call:()=>{throw Error('Wrong domain');}},modelRuntime:{call:async input=>{dispatched++;return{received:input.kind};}},serviceKey});
 const call=(key,signatureOverride)=>new Promise((resolve,reject)=>{
  const body=JSON.stringify({kind:'models-overview'}),id=randomUUID(),at=String(Math.floor(Date.now()/1000));
  const req=request({socketPath,path:'/v1/model-settings',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),
   'x-galaxy-service-key':key,'x-galaxy-request-id':id,'x-galaxy-request-at':at,
   'x-galaxy-service-signature':signatureOverride??maintenanceRequestSignature(serviceKey,{id,at,body})}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));});
  req.on('error',reject);req.end(body);
 });
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  assert.equal((await call('wrong')).status,401);assert.equal((await call(serviceKey,'wrong')).status,401);assert.equal(dispatched,0);
  assert.deepEqual(await call(serviceKey),{status:200,body:{received:'models-overview'}});assert.equal(dispatched,1);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('model application waits for native startup and continues a proved rollback once under the original authorization',{skip:process.platform==='win32'?'Private Unix file-mode journal requires the Linux host runtime.':false},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-p20-startup-'));let tick=0,restarts=0,reads=0,allowed=true;
 const now=()=>new Date(2000000000000+tick),configuration={controlDirectory:directory+'/journal',operations:{tools:{docker:'/usr/bin/docker'}}};
 const runtime=new ModelConfigurationRuntime({configuration,control,root:directory+'/models',now,pause:async ms=>{tick+=ms;},
  authorize:async()=>{if(!allowed)throw Object.assign(Error('closed'),{code:'model_settings_permission_denied'});},
  run:async()=>{restarts++;}});
 const unavailable=()=>({gateway:{state:'unavailable',configurationVersion:null,modelCount:null},agentos:{state:'unavailable',configurationVersion:null,configuredScenarios:[]}});
 const baseline={version:1,versionId:null,configurationVersion:'unconfigured-v1',modelCount:0,configuredScenarios:[]};
 let observed=state();runtime.engineState=async()=>reads++<15&&restarts?unavailable():structuredClone(observed);
 try{
  await runtime.initialize();const base=directory+'/models/versions/unconfigured-v1';await import('node:fs/promises').then(fs=>fs.mkdir(base,{mode:0o700}));
  for(const[name,value]of [['models.yaml',JSON.stringify({model_list:[],galaxy_profiles:{}})],['bindings.json',JSON.stringify({version:'unconfigured-v1',scenarios:empty().scenarios})],['provider.env',''],['active.env','GALAXY_MODEL_GATEWAY_CONFIG_VERSION=unconfigured-v1\n']])await writeFile(base+'/'+name,value,{mode:0o600});
  await runtime.activateFiles('unconfigured-v1');await writeFile(directory+'/models/applied.json',JSON.stringify(baseline),{mode:0o600});
  const modelId=randomUUID(),credentialId=randomUUID(),reference='model-key:'+credentialId;
  await writeFile(directory+'/models/keys/'+credentialId+'.json',JSON.stringify({reference,modelRecordId:modelId,apiKey:'SYNTHETIC_STARTUP_KEY_NOT_A_PROVIDER'}),{mode:0o600});
  const selected=empty();selected.models.push(fixtureModel(modelId,reference));
  const intent={kind:'models-apply',operationId:randomUUID(),operatorId:'synthetic-human',versionId:randomUUID(),revision:1,configuration:selected};
  const row=(await runtime.journal.begin(intent)).row;row.state='unknown';row.phase='restart-requested';row.code='model_settings_application_result_unknown';await runtime.journal.save(row);runtime.journal.active.delete(row.id);
  const compiled=compileModelConfiguration(selected,intent.versionId,await runtime.credentials());
  runtime.run=async()=>{restarts++;observed=state(compiled.configurationVersion,1,[]);reads=0;};
  assert.equal((await runtime.call({kind:'models-operation',operationId:row.id})).operation.state,'running');
  await Promise.all(runtime.tasks.values());assert.equal(restarts,1);assert.ok(tick>=15000);
  assert.equal((await runtime.call({kind:'models-operation',operationId:row.id})).operation.state,'completed');
  assert.equal((await runtime.journal.read(row.id)).recoveryAttempt,1);assert.equal((await runtime.credentials()).length,1);
  assert.equal((await runtime.active()).versionId,intent.versionId);assert.equal(restarts,1);
  const next={...intent,operationId:randomUUID(),versionId:randomUUID(),revision:2},other=(await runtime.journal.begin(next)).row;
  other.state='unknown';other.phase='restart-requested';await runtime.journal.save(other);runtime.journal.active.delete(other.id);
  await writeFile(directory+'/models/active.env','GALAXY_MODEL_GATEWAY_CONFIG_VERSION=unconfirmed\n',{mode:0o600});
  assert.equal((await runtime.call({kind:'models-operation',operationId:other.id})).operation.state,'unknown');assert.equal(restarts,1);
  await runtime.activateFiles(compiled.configurationVersion);allowed=false;
  const denied=(await runtime.call({kind:'models-operation',operationId:other.id})).operation;
  assert.equal(denied.state,'failed');assert.equal(denied.code,'model_settings_permission_denied');assert.equal(restarts,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
