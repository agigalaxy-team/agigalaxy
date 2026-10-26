import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from '../src/database.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';
import {OperationsModelSettingsService} from '../src/operations-model-settings.mjs';
import {ModelSettingsNativeClient} from '../src/operations-model-settings-native.mjs';
import {maintenanceRequestSignature} from '../src/operations-maintenance-native.mjs';
import {emptyModelSettingsConfiguration,modelSettingsConfigurationSchema,modelSettingsCredentialSchema,assertModelSettingsApplicable} from '../src/shared/operations-model-settings-schema.mjs';
import {dispatchOperationsModelSettings} from '../src/adapters/http/operations-model-settings-http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {operationsReadPath,operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';
import {normalizeAuditFilters,auditReadPath,auditActionLabel,auditAvailableActions} from '../../../apps/galaxy-admin/src/lib/audit-view-model.ts';

const options=actor=>({authorize:async()=>actor}),codes=['models.read','models.configure','models.apply'];
const model=(id,credentialRef=null)=>({id,displayName:'合成人工选择',modelId:'synthetic-runtime-model',apiFormat:'openai-chat',baseUrl:'https://model.invalid/v1',credentialRef,contextWindow:8192,maxOutputTokens:512,reasoning:{mode:'default',effort:null,supportedEfforts:[],supportSource:'manual'},timeoutSeconds:60,toolCalling:true,structuredOutput:false,enabled:true});
const configuration=row=>({...emptyModelSettingsConfiguration(),models:[row],scenarios:{...emptyModelSettingsConfiguration().scenarios,overview:{modelId:row.id,dataPolicyApproved:true}}});
function nativeFixture(now){
 const n={commands:[],operations:new Map(),secrets:new Map(),loseAck:false,queryUnavailable:false,denied:false,mismatch:false,status:{availability:{state:'available'},configurationVersion:'unconfigured-v1',appliedVersionId:null,engines:{gateway:{state:'available',configurationVersion:'unconfigured-v1',modelCount:0},agentos:{state:'not-configured',configurationVersion:'unconfigured-v1',configuredScenarios:[]}},credentials:[]}};
 n.finish=id=>{const entry=n.operations.get(id);assert.ok(entry);entry.operation.state='completed';entry.operation.finishedAt=new Date(now()*1000).toISOString();if(entry.input.kind==='models-apply'){
  const version='v-'+entry.input.versionId;n.status.appliedVersionId=entry.input.versionId;n.status.configurationVersion=version;
  n.status.engines={gateway:{state:'available',configurationVersion:version,modelCount:entry.input.configuration.models.filter(row=>row.enabled).length},agentos:{state:'configured',configurationVersion:n.mismatch?'unexpected-version':version,configuredScenarios:Object.keys(entry.input.configuration.scenarios).filter(domain=>entry.input.configuration.scenarios[domain]!==null)}};
 }};
 n.transport=async input=>{
  n.commands.push(structuredClone(input));
  if(input.kind==='models-overview')return structuredClone(n.status);
  if(input.kind==='models-operation'){if(n.queryUnavailable)throw Error('Explicit synthetic query outage');return{operation:structuredClone(n.operations.get(input.operationId)?.operation)};}
  if(input.kind==='models-usage')return n.usage?.(input.days)??{availability:{state:'unavailable'},days:input.days,from:null,to:null,coverageFrom:null,coversWholeWindow:false,calls:{total:null,completed:null,failed:null,unknown:null},tokens:{input:null,output:null,total:null,cachedInput:null,reasoning:null},unknownUsageCalls:null,byScenario:[],byModel:[]};
  if(n.denied)throw Object.assign(new ServiceError('model_settings_configuration_invalid',400),{nativeStatus:400});
  const safe={...input};delete safe.apiKey;await n.authorize(safe);
  const operation={id:input.operationId,kind:input.kind,state:'accepted',code:null,startedAt:new Date(now()*1000).toISOString(),finishedAt:null};
  n.operations.set(input.operationId,{operation,input});
  if(input.kind==='models-credential-provision'){
   const reference='model-key:'+input.operationId;operation.credentialRef=reference;n.secrets.set(reference,input.apiKey);
   n.status.credentials.push({reference,modelRecordId:input.modelRecordId,configured:true});operation.state='completed';operation.finishedAt=new Date(now()*1000).toISOString();
  }
  if(n.loseAck){n.loseAck=false;throw Error('Explicit synthetic lost ACK; not a provider call');}
  return{operation:structuredClone(operation)};
 };
 n.client=new ModelSettingsNativeClient({transport:n.transport,now});
 n.writes=kind=>n.commands.filter(row=>row.kind===kind);return n;
}
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'synthetic-model-admin',endpoint:f.endpoint,role:'administrator'},reader={...admin,operatorId:'synthetic-model-reader',role:'reader'},roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 for(const actor of[admin,reader])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operations.invalid',$1,'合成人工配置',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>roles.get(actor.operatorId),now:f.now}),businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now}),native=nativeFixture(f.now);
 const service=new OperationsModelSettingsService({businessAdmin,native:native.client,now:f.now});native.authorize=value=>service.authorizeNative(value);
 async function grant(actions){const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'合成模型动作 '+randomUUID(),description:'仅本叶实际动作',enabled:true,permissions:actions},options(admin))).role;return(await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},options(admin))).assignment;}
 const draft=(revision,value)=>({operationId:randomUUID(),expectedRevision:revision,configuration:value,reason:'人工所选配置'});
 const apply=(revision,versionId)=>({operationId:randomUUID(),expectedRevision:revision,versionId,reason:'应用已保存版本'});
 return{...f,admin,reader,roles,permissions,businessAdmin,native,service,grant,draft,apply};
}

test('human-only model SQL stores no key, versions credentials, applies only matching native readback, and preserves immutable intent/CAS',async t=>{
 const f=await fixture(t);await assert.rejects(f.service.overview({...f.reader,role:'administrator',businessAuthorization:{version:'forged-snapshot',permissions:codes}}),{code:'operations_permission_denied'});
 await assert.rejects(f.service.overview({kind:'operations-executor'}),{code:'model_settings_human_required'});
 const assignment=await f.grant(codes);await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const initial=await f.service.overview(f.reader);assert.equal(initial.active,null);assert.equal(initial.draft,null);assert.deepEqual(initial.native.credentials,[]);assert.equal(f.native.writes('models-apply').length,0);
 const recordId=randomUUID(),key='synthetic-write-only-secret-'+randomUUID(),provision={operationId:randomUUID(),modelRecordId:recordId,apiKey:key};
 const credential=await f.service.provisionCredential(f.reader,provision,options(f.reader));assert.equal(credential.phase,'applied');assert.equal(credential.credentialRef,'model-key:'+provision.operationId);assert.equal(credential.revision,0);
 assert.equal((await f.service.provisionCredential(f.reader,{...provision,apiKey:'different-retry-body'},options(f.reader))).replayed,true);assert.equal(f.native.writes('models-credential-provision').length,1);assert.equal(f.native.secrets.get(credential.credentialRef),key);
 const intent=f.draft(0,configuration(model(recordId,credential.credentialRef))),saved=await f.service.saveDraft(f.reader,intent,options(f.reader));assert.equal(saved.phase,'applied');assert.equal(saved.revision,1);assert.equal(f.native.writes('models-apply').length,0);
 const publish=f.apply(saved.revision,saved.versionId),accepted=await f.service.apply(f.reader,publish,options(f.reader));assert.equal(accepted.phase,'pending');assert.equal((await f.service.overview(f.reader)).active,null);assert.equal((await f.service.apply(f.reader,publish,options(f.reader))).replayed,true);assert.equal(f.native.writes('models-apply').length,1);
 f.native.finish(publish.operationId);assert.equal((await f.service.operation(f.reader,publish.operationId)).phase,'applied');const current=await f.service.overview(f.reader);assert.equal(current.active.id,saved.versionId);assert.equal(current.revision,3);
 const rotated=await f.service.provisionCredential(f.reader,{operationId:randomUUID(),modelRecordId:recordId,apiKey:'synthetic-new-secret-'+randomUUID()},options(f.reader));assert.notEqual(rotated.credentialRef,credential.credentialRef);assert.equal((await f.service.overview(f.reader)).active.configuration.models[0].credentialRef,credential.credentialRef);
 await assert.rejects(f.service.saveDraft(f.reader,f.draft(1,intent.configuration),options(f.reader)),{code:'model_settings_revision_changed'});
 await assert.rejects(f.service.saveDraft(f.reader,{...intent,reason:'altered intent'},options(f.reader)),{code:'model_settings_operation_conflict'});
 const stored=(await f.db.query('SELECT input,request_hash,changes,error_code,credential_ref FROM operations_model_settings_operations_v1')).rows;
 const audit=(await f.db.query("SELECT * FROM business_admin_audit_v1 WHERE action LIKE 'models.%' ORDER BY sequence")).rows;
 const history=await f.service.history(f.reader,{limit:2});assert.ok(history.nextAfter);assert.ok(history.items.every(row=>!Object.hasOwn(row,'input')));
 for(const value of[stored,audit,history,current]){assert.equal(JSON.stringify(value).includes(key),false);assert.equal(JSON.stringify(value).includes('"apiKey"'),false);}
 assert.equal(audit.every(row=>row.operator_role==='reader'),true);assert.equal(businessAuditMetadata(audit[1]).selection.kind,'draft');
 await assert.rejects(f.businessAdmin.audit(f.reader,{kind:'business',action:'models.configure'}),{code:'operations_permission_denied'});const auditModels=await f.businessAdmin.audit(f.admin,{kind:'business',action:'models.configure'});assert.equal(auditModels.items.length,3);assert.ok(auditModels.actions.includes('models.apply'));assert.equal(JSON.stringify(auditModels.items).includes(key),false);assert.equal(JSON.stringify(auditModels.items).includes(intent.reason),false);
 const scopedAudit=await f.businessAdmin.audit(f.admin,{kind:'business',action:'models.configure',resourceId:recordId});assert.equal(scopedAudit.items.length,2);await assert.rejects(f.businessAdmin.audit(f.admin,{action:'models.arbitrary'}),{code:'invalid_business_admin_request'});
 const dotted=['recommendations.configure','search-quality.configure','search-quality.publish','search-quality.restore','models.configure','models.apply'];for(const action of dotted){const filters=normalizeAuditFilters({action});assert.equal(filters.action,action);assert.equal(new URL(auditReadPath(filters),'https://admin.invalid').searchParams.get('action'),action);assert.notEqual(auditActionLabel(action),'其他业务记录');}assert.equal(auditAvailableActions([...dotted,'models.arbitrary']).length,6);assert.equal(normalizeAuditFilters({action:'models.arbitrary'}).action,'');
 for(const sql of["UPDATE operations_model_settings_versions_v1 SET configuration='{}'::jsonb","UPDATE operations_model_settings_operations_v1 SET input='{}'::jsonb","UPDATE operations_model_settings_operations_v1 SET operator_id='changed'","DELETE FROM operations_model_settings_operations_v1"])await assert.rejects(f.db.query(sql),{code:'42501'});
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:assignment.roleId,enabled:false},options(f.admin));
 await assert.rejects(f.service.apply(f.reader,publish,options(f.reader)),{code:'operations_permission_denied'});await f.db.exec('RESET ROLE');
});

test('unknown model operations recover original native results without resubmission and fresh callback prevents another principal or revoked grant',async t=>{
 const f=await fixture(t),recordId=randomUUID(),provision={operationId:randomUUID(),modelRecordId:recordId,apiKey:'synthetic-retained-in-process-'+randomUUID()};
 f.native.loseAck=true;f.native.queryUnavailable=true;const unknown=await f.service.provisionCredential(f.admin,provision,options(f.admin));assert.equal(unknown.phase,'result-unknown');assert.equal(f.native.writes('models-credential-provision').length,1);
 f.native.queryUnavailable=false;const recovered=await f.service.operation(f.admin,provision.operationId);assert.equal(recovered.phase,'applied');assert.equal(f.native.writes('models-credential-provision').length,1);
 const saved=await f.service.saveDraft(f.admin,f.draft(0,configuration(model(recordId,recovered.credentialRef))),options(f.admin)),apply=f.apply(1,saved.versionId);
 f.native.loseAck=true;f.native.queryUnavailable=true;assert.equal((await f.service.apply(f.admin,apply,options(f.admin))).phase,'result-unknown');assert.equal(f.native.writes('models-apply').length,1);
 await assert.rejects(f.service.saveDraft(f.admin,f.draft(2,emptyModelSettingsConfiguration()),options(f.admin)),{code:'model_settings_operation_pending'});
 const callback={kind:'models-apply',operationId:apply.operationId,operatorId:f.admin.operatorId,versionId:saved.versionId,revision:1,configuration:configuration(model(recordId,recovered.credentialRef))};
 await assert.rejects(f.service.authorizeNative({...callback,operatorId:f.reader.operatorId}),{code:'model_settings_execution_not_authorized'});
 await assert.rejects(f.service.authorizeNative({...callback,configuration:emptyModelSettingsConfiguration()}),{code:'model_settings_execution_not_authorized'});
 f.roles.delete(f.admin.operatorId);await assert.rejects(f.service.authorizeNative(callback));f.roles.set(f.admin.operatorId,'administrator');
 f.native.queryUnavailable=false;f.native.mismatch=true;f.native.finish(apply.operationId);assert.equal((await f.service.operation(f.admin,apply.operationId)).phase,'result-unknown');assert.equal((await f.service.overview(f.admin)).active,null);
 f.native.status.engines.agentos.configurationVersion=f.native.status.configurationVersion;assert.equal((await f.service.operation(f.admin,apply.operationId)).phase,'applied');assert.equal(f.native.writes('models-apply').length,1);
 const revision=(await f.service.overview(f.admin)).revision,second=await f.service.saveDraft(f.admin,f.draft(revision,emptyModelSettingsConfiguration()),options(f.admin));f.native.denied=true;
 assert.equal((await f.service.apply(f.admin,f.apply(second.revision,second.versionId),options(f.admin))).phase,'failed');assert.equal((await f.service.overview(f.admin)).pending,null);f.native.denied=false;
 let freshChecks=0;const before=f.native.writes('models-apply').length,current=(await f.service.overview(f.admin)).revision;
 await assert.rejects(f.service.apply(f.admin,f.apply(current,second.versionId),{authorize:async()=>++freshChecks<5?f.admin:{...f.reader,operatorId:f.reader.operatorId}}),{code:'business_admin_denied'});assert.equal(f.native.writes('models-apply').length,before);
 const row=model(recordId,recovered.credentialRef);assert.equal(modelSettingsConfigurationSchema.safeParse(configuration({...row,temperature:0.3})).success,false);
 assert.equal(modelSettingsConfigurationSchema.safeParse(configuration({...row,maxOutputTokens:8192})).success,false);
 assert.equal(modelSettingsConfigurationSchema.safeParse(configuration({...row,apiFormat:'openai-responses',maxOutputTokens:8})).success,false);
 assert.equal(modelSettingsConfigurationSchema.safeParse(configuration({...row,apiFormat:'gemini',reasoning:{mode:'effort',effort:'xhigh',supportedEfforts:['xhigh'],supportSource:'manual'}})).success,false);
 assert.equal(modelSettingsConfigurationSchema.safeParse(configuration({...row,reasoning:{mode:'effort',effort:'invented',supportedEfforts:['invented'],supportSource:'manual'}})).success,false);
 assert.equal(modelSettingsCredentialSchema.safeParse({...provision,apiKey:'line\nbreak'}).success,false);
 assert.throws(()=>assertModelSettingsApplicable(configuration({...row,credentialRef:null})),{code:'model_settings_model_incomplete'});
 assert.throws(()=>assertModelSettingsApplicable({...configuration(row),scenarios:{...emptyModelSettingsConfiguration().scenarios,governance:{modelId:recordId,dataPolicyApproved:false}}}),{code:'model_settings_data_policy_unapproved'});
});

test('model usage preserves native partial coverage, explicit zero and unknown tokens without model/provider calls',async t=>{
 const f=await fixture(t),now=new Date(f.now()*1000).toISOString();
 let value=await f.service.usage(f.admin,{days:7});assert.equal(value.availability.state,'unavailable');assert.equal(value.calls.total,null);assert.equal(value.tokens.total,null);assert.equal(value.coversWholeWindow,false);
 f.native.usage=days=>({availability:{state:'available'},days,from:now,to:now,coverageFrom:now,coversWholeWindow:false,calls:{total:2,completed:1,failed:0,unknown:1},tokens:{input:100,output:null,total:null,cachedInput:0,reasoning:null},unknownUsageCalls:1,byScenario:[{domain:'overview',calls:{total:2,completed:1,failed:0,unknown:1},tokens:{input:100,output:null,total:null,cachedInput:0,reasoning:null},unknownUsageCalls:1}],byModel:[]});
 value=await f.service.usage(f.admin,{days:30});assert.equal(value.days,30);assert.equal(value.coverageFrom,now);assert.equal(value.coversWholeWindow,false);assert.equal(value.calls.failed,0);assert.equal(value.tokens.total,null);assert.equal(value.tokens.cachedInput,0);assert.equal(value.unknownUsageCalls,1);assert.equal(value.byScenario[0].domain,'overview');
 f.native.usage=()=>({availability:{state:'available'},days:7,from:now,to:now,calls:{total:99,completed:99,failed:0,unknown:0},tokens:{input:999,output:999,total:1998,cachedInput:0,reasoning:0},unknownUsageCalls:0,byScenario:[],byModel:[]});
 value=await f.service.usage(f.admin,{days:30});assert.equal(value.calls.total,null);assert.equal(value.availability.state,'unavailable');assert.equal(f.native.writes('models-apply').length,0);assert.equal(f.native.writes('models-credential-provision').length,0);
});

test('model history shows the management principal name from the same endpoint and preserves its internal identity',async t=>{
 const f=await fixture(t);
 await f.service.saveDraft(f.admin,f.draft(0,emptyModelSettingsConfiguration()),options(f.admin));
 await f.db.query('UPDATE operations_operator_principals_v1 SET display_name=$3 WHERE operator_id=$1 AND endpoint=$2',[f.admin.operatorId,f.endpoint,'配置维护员']);
 const value=await f.service.history(f.admin);
 assert.equal(value.items.length,1);assert.equal(value.items[0].operatorId,f.admin.operatorId);assert.equal(value.items[0].operatorDisplayName,'配置维护员');
 assert.equal(value.items[0].phase,'applied');assert.equal(value.items[0].version,1);
 assert.equal(f.native.writes('models-apply').length,0);assert.equal(f.native.writes('models-credential-provision').length,0);
});

test('model HTTP/proxy close body and parameters while private human authorization verifies service/HMAC before reading',async()=>{
 const base='/v1/operations/model-settings',origin='https://admin.invalid',endpoint='https://api.invalid',key='synthetic-internal-service-key-'.repeat(2),now=2000000000,native=new ModelSettingsNativeClient({key,now:()=>now});
 const actor={kind:'business-operator',operatorId:'synthetic-human',role:'reader',endpoint},calls=[],service={overview:async()=>({}),history:async(_,x)=>{calls.push(x);return{};},usage:async(_,x)=>{calls.push(x);return{};},operation:async()=>({}),saveDraft:async(_,x,options)=>{await options.authorize();calls.push(x);return{};},provisionCredential:async()=>({}),apply:async()=>({}),authorizeNative:async x=>{calls.push(x);return{authorized:true};}};
 const authorizer=async(request,options)=>{calls.push(options);if(options.write&&request.headers['x-galaxy-operator-csrf']!=='synthetic')throw new ServiceError('operations_csrf_invalid',403);return actor;};
 const response={setHeader(){}};
 const invoke=async(path,{method='GET',input,headers={},address='127.0.0.1'}={})=>{const request=Readable.from(input===undefined?[]:[Buffer.from(typeof input==='string'?input:JSON.stringify(input))]);Object.assign(request,{method,url:path,headers:{origin,'content-type':'application/json','x-galaxy-operator-csrf':'synthetic',...headers},socket:{remoteAddress:address}});return dispatchOperationsModelSettings({operationsModelSettings:service,modelSettingsNative:native,authorizeOperator:authorizer,request,response,requestId:'synthetic',url:requestUrl(request,endpoint,[origin]),send(){}});};
 const browserHeaders=new Headers({origin,'sec-fetch-site':'same-origin'});assert.equal(operationsReadPath(base+'/usage?days=30'),true);await invoke(base+'/usage?days=30');assert.ok(calls.some(row=>row.days===30));
 for(const path of[base+'/overview?days=7',base+'/history?after=1&after=2',base+'/usage?unknown=1',base+'/operations/'+randomUUID()+'?taskId=5']){
  assert.equal(operationsReadPath(path),false);assert.equal(operationsProxyPolicy({url:origin+path,method:'GET',headers:browserHeaders,publicOrigin:origin}).allowed,false);await assert.rejects(invoke(path));
 }
 await invoke(base+'/draft',{method:'POST',input:{}});await assert.rejects(invoke(base+'/draft',{method:'POST',input:{},headers:{'x-galaxy-operator-csrf':'wrong'}}),{code:'operations_csrf_invalid'});
 assert.equal(operationsProxyPolicy({url:origin+base+'/draft?retry=1',method:'POST',headers:browserHeaders,publicOrigin:origin}).allowed,false);
 const internal='/v1/internal/models/authorize',id=randomUUID(),raw=JSON.stringify({operationId:id,operatorId:actor.operatorId,kind:'models-credential-provision',modelRecordId:randomUUID()}),headers={'x-galaxy-service-key':key,'x-galaxy-request-id':id,'x-galaxy-request-at':String(now),'x-galaxy-service-signature':maintenanceRequestSignature(key,{id,at:String(now),body:raw})};
 await invoke(internal,{method:'POST',input:raw,headers});assert.ok(calls.some(row=>row.operationId===id));
 await assert.rejects(invoke(internal,{method:'POST',input:raw+' ',headers}),{code:'maintenance_service_denied'});
 await assert.rejects(invoke(internal,{method:'POST',input:raw,headers,address:'192.0.2.1'}),{code:'model_settings_service_denied'});
 let read=false;const request={method:'POST',headers:{'x-galaxy-service-key':'wrong'},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){read=true;yield Buffer.from(raw);}};
 await assert.rejects(dispatchOperationsModelSettings({operationsModelSettings:service,modelSettingsNative:native,request,response,url:new URL(endpoint+internal),send(){}}),{code:'maintenance_service_denied'});assert.equal(read,false);
 assert.equal(operationsProxyPolicy({url:origin+internal,method:'POST',headers:browserHeaders,publicOrigin:origin}).allowed,false);
});

