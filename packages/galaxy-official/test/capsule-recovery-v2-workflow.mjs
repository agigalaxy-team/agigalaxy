import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createBrowserClient} from '../src/browser-client.mjs';
import {digest} from '../src/shared/digest.mjs';
import {createCapsuleVisibilityClient} from '../../galaxy-web/src/capsule-visibility-client.mjs';
const scopes=['binding','consent','case-teaser','capsules','history','notifications','evidence','proof'];
const pub={visibility:'Public',purpose:'public-profile'};
async function work(f){const caseId=randomUUID(),attempt=randomUUID(),result=randomUUID();const events=[
 {schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),title:'合成 Capsule 修复',summary:'受影响流程验收',source:{kind:'local',reference:'synthetic-recovery:'+caseId},synthetic:true},
 {schemaVersion:2,kind:'attempt-start',eventId:attempt,caseId,expectedVersion:1,actorId:f.actor.subjectId,role:'implementation',strategy:'执行选定步骤',inputScopeSummary:'合成输入',permissionScope:['selected-context'],environment:{name:'Node',version:'24'}},
 {schemaVersion:2,kind:'result-recorded',eventId:result,caseId,expectedVersion:2,actorId:f.actor.subjectId,origin:{kind:'attempt',id:attempt,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'succeeded',summary:'合成结果',limitations:'不作为真实试点'}];
 const grants=[];for(const e of events) {const grant=await f.authorize(e,'case.teaser.publish',{objectId:e.eventId});grants.push(grant);await f.cases.submitV2(f.actor,grant);}return{caseId,attempt,result,grants};}
const version=s=>({schemaVersion:2,kind:'version',id:randomUUID(),capsuleId:randomUUID(),expectedRevision:0,version:1,title:'合成待修复方法',problemPattern:'特定问题',environment:{name:'Node',version:'24'},solutionStrategy:'敏感旧内容不可在修复预填',tools:[],skills:[],mcpRefs:[],verificationMethod:'已有有限检查',limitations:['合成数据'],capabilityId:'software-debugging',applicableScope:'选定目标',license:'MIT',contributors:[],publicationClass:'formal-source-success',synthetic:true,sourceResolution:{caseId:s.caseId,resultId:s.result,resultVersion:1,proofIds:[],verificationRefs:[]},sourceRefs:[],permissionRefs:[],attributionRefs:[],externalReferences:[],redactionConfirmed:true});
export async function verifyCapsuleRecoveryV2(db,options={}){
 const f=await serviceFixture(scopes,db,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false,...options}),p=await serviceFixture(scopes,f.db,{now:f.now,syntheticCommunityQuota:false,...options,migrateDatabase:false});
 const server=createApi(f);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const call=async(actor,path,body={})=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${actor.credential}`}:{})},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{code:value.error,status:response.status});return value;};
 let browser;
 try{
  const source=await work(f),target=await work(p),v=version(source),signed=await f.authorize(v,'capsule.publish',pub);await call(f,'/v2/capsules/events',signed);
  const use={schemaVersion:2,kind:'apply',id:randomUUID(),capsuleId:v.capsuleId,versionId:v.id,caseId:target.caseId,attribution:f.actor.subjectId,note:'合成实际应用',attemptRef:{id:target.attempt,version:1},resultRef:{id:target.result,version:1},environment:{name:'Node',version:'24'},environmentDifference:'同版本合成条件',adoptedParts:['一个步骤'],outcome:'succeeded'};
  await call(p,'/v2/capsules/uses',await p.authorize(use,'capsule.use'));
  const maintenance={schemaVersion:2,kind:'deprecate',id:randomUUID(),capsuleId:v.capsuleId,versionId:v.id,expectedRevision:1,summary:'仅此旧版停止推荐'};
  await call(f,'/v2/capsules/events',await f.authorize(maintenance,'capsule.publish',pub));
  let inbox=await f.inbox.query(p.actor,{}),notice=inbox.items.find(x=>x.id==='capsule:'+maintenance.id);assert.ok(notice);assert.deepEqual(notice.object,{type:'capsule',id:v.capsuleId,versionId:v.id});assert.equal(notice.deprecated,true);
  assert.equal((await f.capsules.getV2(p.actor,{capsuleId:v.capsuleId})).ownerControl,undefined);
  await f.consents.revoke(f.actor,source.grants[2].consentId);
  notice=(await f.inbox.query(p.actor,{})).items.find(x=>x.id==='capsule:'+maintenance.id);assert.equal(notice.sourceStatus,'source-unavailable');assert.equal(notice.title,'Capsule 来源或版本状态已变化');assert.ok(!JSON.stringify(notice).includes(v.solutionStrategy));
  const erased=await call(f,'/v2/capsules/read',{capsuleId:v.capsuleId}),management=await call(f,'/v2/capsules/versions',{capsuleId:v.capsuleId});assert.equal(erased.version,null);assert.equal(management.management.publishedVersionCount,1);
  const newSource=await work(f),next={...version(newSource),capsuleId:v.capsuleId,version:2,expectedRevision:management.management.revision,solutionStrategy:'新合法来源新正文'};
  await call(f,'/v2/capsules/events',await f.authorize(next,'capsule.publish',pub));assert.equal((await call(null,'/v2/capsules/read',{capsuleId:v.capsuleId,versionId:next.id})).version.solutionStrategy,'新合法来源新正文');assert.equal((await call(null,'/v2/capsules/read',{capsuleId:v.capsuleId,versionId:v.id})).version,null);
  const publicKeyPem=p.genesis.genesisProof.publicKeyPem,deviceId=randomUUID(),upgrade={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:p.actor.subjectId,expectedEpoch:0,previousEventHash:null,signerKeyId:digest(publicKeyPem),genesisProof:p.genesis.genesisProof,newDevice:{deviceId,publicKeyPem,scopes:['manage-identity',...scopes]}};
  const challenge=await p.identityControl.challenge(upgrade),signature=await p.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');await p.identityControl.commit({operationId:upgrade.operationId,controllerSignature:signature,newDeviceProof:signature});
  let lose=true,revokePosts=0;const storage=new Map(),getLocal=async k=>structuredClone(storage.get(k)),putLocal=async(k,x)=>storage.set(k,structuredClone(x));
  browser=createBrowserClient({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys,sign:p.signForTest,now:()=>p.now,fetch:async(url,options)=>{const path=new URL(url).pathname;if(path.endsWith('/revoke')){revokePosts++;assert.ok([...storage.values()].some(rows=>Array.isArray(rows)&&rows.some(r=>r.state==='result-unknown')));}
   const response=await fetch(origin+path,options);if(path.endsWith('/revoke')&&lose){lose=false;assert.equal(response.status,200);throw new Error('synthetic lost revoke ACK');}return response;}});
  await browser.connect({subjectId:p.actor.subjectId,genesisProof:p.genesis.genesisProof,installationId:randomUUID(),scopes,control:{deviceId,keyId:digest(publicKeyPem),epoch:1}},{confirmed:true});
  const make=()=>createCapsuleVisibilityClient({api:browser,getLocal,putLocal,subjectId:p.actor.subjectId});let client=make();
  const controls=(await call(p,'/v2/capsules/uses/query',{capsuleId:v.capsuleId})).items.find(x=>x.eventId===use.id).ownerControl;assert.ok(controls);
  const preview=await client.prepare(controls);await assert.rejects(client.execute(preview,{confirmed:true}),/synthetic lost revoke ACK/);client=make();assert.equal((await client.reconcile(controls.consentId)).state,'revoked');assert.equal(revokePosts,1);assert.equal((await call(p,'/v2/capsules/uses/query',{capsuleId:v.capsuleId})).items.length,0);assert.equal((await f.inbox.query(p.actor,{})).items.filter(x=>x.object.type==='capsule').length,0);
  const other=(await call(f,'/v2/capsules/read',{capsuleId:v.capsuleId})).ownerControl;await assert.rejects(client.prepare(other),/本人精确对象授权/);
  return{realBrowserClientAndHttp:true,syntheticOnly:true,storage:'explicit-memory-substitute',v2Notice:true,tombstoneHasNoBody:true,blankRepairUsesNewSource:true,exactRevokeLostAckRecovered:true};
 }finally{if(browser)await Promise.resolve(browser.disconnect()).catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(!db)await f.db.close();}
}
