import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {digest} from '../src/shared/digest.mjs';
import {configurationToolDefinitions} from '../src/adapters/mcp/personal/tools/configurations-v2.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
import {verifyConfigurationBrowser} from './configuration-client-workflow.mjs';
const scopes=['binding','consent','case-teaser','history','capsules','evidence','proof','data-export','data-delete'];
export const configurationExample=(actor)=>({schemaVersion:2,id:randomUUID(),operationId:randomUUID(),expectedVersion:0,actorId:actor.subjectId,kind:'record',
 title:'合成所选环境',summary:'只登记选定的软件条件',observedAt:new Date().toISOString(),synthetic:true,selectedFieldsOnly:true,
 conditions:{model:{name:null,version:null},runtime:{name:'Node',version:'24'},environment:{name:'synthetic',version:null},
 tools:[{name:'compiler',version:'1'}],skills:[],mcp:[],promptPolicyVersion:null,rulesVersion:null,operationScope:['selected-context'],inputScopeSummary:'合成材料可用性报告，不是授权',limitations:'未读取真实机器、原始提示词或文件'}});
async function facts(f,{configurationRef=null,explicit=false}={}){
 const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),title:'配置来源区别',summary:'合成范围检查',synthetic:true,source:{kind:'local',reference:randomUUID()}},
 attempt={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId,expectedVersion:1,actorId:f.actor.subjectId,role:'implementation',strategy:'检查版本差异',inputScopeSummary:'选定材料',permissionScope:['selected-context'],...(!explicit?{configurationRef}:{})},
 result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:2,actorId:f.actor.subjectId,origin:{kind:'attempt',id:attempt.eventId,version:1},scopeVersion:1,
 deliverableRefs:explicit?[{kind:'configuration',...configurationRef}]:[],reportedOutcome:'succeeded',summary:'有限合成流程完成',limitations:'不代表生产运行'};
 for(const e of [root,attempt,result])await f.cases.submitV2(f.actor,await f.authorize(e,'case.teaser.publish',{objectId:e.eventId}));
 return {caseId,root,attempt,result};
}
function capsule(source){return {schemaVersion:2,kind:'version',id:randomUUID(),capsuleId:randomUUID(),expectedRevision:0,version:1,title:'配置内容参与的方法',problemPattern:'环境比较',environment:{name:'Node',version:'24'},solutionStrategy:'按选定版本核对',tools:[],skills:[],mcpRefs:[],verificationMethod:'合成范围检查',limitations:['非生产验收'],capabilityId:'software-debugging',applicableScope:'版本比较',license:'MIT',contributors:[],sourceResolution:{caseId:source.caseId,resultId:source.result.eventId,resultVersion:1,proofIds:[],verificationRefs:[]},publicationClass:'formal-source-success',synthetic:true,sourceRefs:[],permissionRefs:[],attributionRefs:[],externalReferences:[],redactionConfirmed:true};}
export async function verifyConfigurationV2(database=null,options={}){
 const f=await serviceFixture(scopes,database,{...options,syntheticCommunityQuota:false,now:Math.floor(Date.now()/1000)}),
 p=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false,syntheticCommunityQuota:false,now:f.now});
 const api=createApi({...f,rateLimit:1000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+api.address().port;
 const request=async(actor,path,body)=>{const r=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...(actor?{authorization:'Bearer '+actor.credential}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const ok=async(actor,path,body)=>{const r=await request(actor,path,body);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 try{
  const config={...configurationExample(p.actor),observedAt:new Date(f.now*1000).toISOString()},signed=await p.authorize(config,'configuration.publish',{objectId:config.operationId,visibility:'Public',purpose:'public-profile'});
  await ok(p,'/v2/configurations/events',signed);assert.equal((await ok(p,'/v2/configurations/events',signed)).version,1);
  const ref={id:config.id,version:1};
  const malformed={...config,id:randomUUID(),operationId:randomUUID(),promptText:'must stay local'};
  assert.equal((await request(p,'/v2/configurations/events',await p.authorize(malformed,'configuration.publish',{objectId:malformed.operationId}))).status,400);
  const impostor={...config,id:randomUUID(),operationId:randomUUID(),actorId:f.actor.subjectId};
  assert.equal((await request(p,'/v2/configurations/events',await p.authorize(impostor,'configuration.publish',{objectId:impostor.operationId}))).status,403);
  const condition=await facts(f,{configurationRef:ref}),material=await facts(f,{configurationRef:ref,explicit:true}),unconfigured=await facts(f);
  const view=await f.cases.getV2(f.actor,condition.caseId);assert.equal(view.attempts[0].configurationCondition.record.conditions.runtime.version,'24');
  const v2={...config,operationId:randomUUID(),expectedVersion:1,summary:'另一私有条件版本',conditions:{...config.conditions,runtime:{name:'Node',version:'25'}}};
  await ok(p,'/v2/configurations/events',await p.authorize(v2,'configuration.publish',{objectId:v2.operationId}));
  assert.equal((await ok(f,'/v2/configurations/read',ref)).sourceStatus,'historical-version');
  assert.deepEqual((await ok(f,'/v2/configurations/versions',{id:config.id})).items.map(i=>i.version),[1]);
  assert.equal((await request(null,'/v2/configurations/read',{id:config.id})).status,403);
  assert.equal((await f.cases.getV2(f.actor,condition.caseId)).attempts[0].configurationCondition.version,1);
  const cap=capsule(material),capSigned=await f.authorize(cap,'capsule.publish');
  assert.equal((await request(f,'/v2/capsules/events',capSigned)).status,403,'reading another author configuration does not permit reuse publication');
  const permission={schemaVersion:2,id:randomUUID(),kind:'grant',sources:[{kind:'configuration',...ref}],grantees:[f.actor.subjectId],license:'MIT',scope:'登记的选定条件',basis:'authored-content',attribution:'配置作者',allowPublic:true};
  await ok(p,'/v2/capsules/permissions',await p.authorize(permission,'capsule.permission',{viewers:[f.actor.subjectId]}));
  cap.permissionRefs=[permission.id];await ok(f,'/v2/capsules/events',await f.authorize(cap,'capsule.publish'));
  assert.ok((await f.capsules.getV2(f.actor,{capsuleId:cap.capsuleId,versionId:cap.id})).version);
  const evidence={kind:'evidence',id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId:material.caseId,reportedBy:f.actor.subjectId,synthetic:true,observedAt:config.observedAt,
    evidenceType:'test-result',source:{originSystem:'synthetic',externalStableId:randomUUID(),contentVersion:'1',issuer:f.actor.subjectId,originalAt:config.observedAt},reportedSourceState:'available',summary:'所选范围的合成核对报告'};
  await f.verificationRecords.submit(f.actor,await f.authorize(evidence,'evidence.submit',{objectId:evidence.operationId}));
  const verification={kind:'verification',id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId:material.caseId,reportedBy:f.actor.subjectId,synthetic:true,observedAt:config.observedAt,
   target:{type:'result',id:material.result.eventId,version:1},scopeVersion:1,method:'human-review',scope:'选定配置条件',conditions:{environment:'synthetic'},observation:'passed',evidenceRefs:[{id:evidence.id,version:1}],relationship:'same-controller',summary:'所选范围核对'};
  await f.verificationRecords.submit(f.actor,await f.authorize(verification,'evidence.submit',{objectId:verification.operationId}));
  const ticket=await p.dataExport.create(p.actor,{id:randomUUID(),datasets:['configuration-objects','configuration-events'],views:[]});
  assert.equal((await p.dataExport.page(p.actor,{id:ticket.id,dataset:'configuration-events'})).items.length,2);
  const admin=options.adminDatabase??f.db,pendingId=randomUUID(),deletionBase={version:1,endpoint:p.access.endpoint,subjectId:p.actor.subjectId,bindingId:p.actor.bindingId,issuedAt:p.now,expiresAt:p.now+300};
  await p.deletion.submit(p.actor,await p.signForTest(JSON.stringify({...deletionBase,id:pendingId,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'}),'galaxy-deletion-intent+jws'));
  assert.equal((await f.cases.getV2(f.actor,condition.caseId)).attempts[0].configurationCondition.record,null);
  assert.equal((await f.cases.getV2(f.actor,condition.caseId)).results.length,1);
  assert.equal((await f.cases.getV2(f.actor,material.caseId)).results.length,0);
  await p.deletion.submit(p.actor,await p.signForTest(JSON.stringify({...deletionBase,id:randomUUID(),action:'cancel',requestId:pendingId,expectedRevision:1}),'galaxy-deletion-intent+jws'));
  assert.equal((await f.cases.getV2(f.actor,condition.caseId)).attempts[0].configurationCondition.conditionsKnown,true);
  const revoke={schemaVersion:2,id:config.id,operationId:randomUUID(),expectedVersion:2,actorId:p.actor.subjectId,kind:'revoke',reason:'撤回选定内容'};
  await ok(p,'/v2/configurations/events',await p.authorize(revoke,'configuration.publish',{objectId:revoke.operationId}));
  assert.equal((await f.cases.getV2(f.actor,condition.caseId)).results.length,1);assert.equal((await f.cases.getV2(f.actor,condition.caseId)).attempts[0].configurationCondition.sourceStatus,'revoked');
  assert.equal((await f.cases.getV2(f.actor,material.caseId)).results.length,0);assert.equal((await f.cases.getV2(f.actor,unconfigured.caseId)).results.length,1);
  assert.equal((await f.verificationRecords.get(f.actor,{type:'verification',id:verification.id})).record,null);
  assert.equal((await f.capsules.getV2(f.actor,{capsuleId:cap.capsuleId,versionId:cap.id})).version,null);
  const receipt={operationId:config.operationId,payloadHash:digest(signed.payloadJson)};
  assert.equal((await ok(f,'/v2/configurations/receipt',receipt)).state,'absent');
  assert.equal((await configurationToolDefinitions(p,p.actor).galaxy_configuration_v2_receipt.run(receipt)).state,'acknowledged');
  const command=await approveFixtureDeletion(p,admin,{auditUntil:f.now+180});await executeDeletion(admin,command,{now:()=>f.now});
  for(const table of ['configuration_events','configuration_objects'])assert.equal(Number((await admin.query('SELECT count(*) n FROM '+table+' WHERE subject_id=$1',[p.actor.subjectId])).rows[0].n),0);
  assert.equal((await f.cases.getV2(f.actor,condition.caseId)).results.length,1);
  assert.equal((await f.cases.getV2(f.actor,condition.caseId)).attempts[0].configurationCondition.sourceStatus,'unavailable');
  await verifyConfigurationBrowser(f,origin,{...configurationExample(f.actor),observedAt:new Date(f.now*1000).toISOString()});
  return {actualHttp:true,optionalConditionsPreserveWork:true,explicitMaterialRights:true,sourceDeletion:true,syntheticOnly:true};
 }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
