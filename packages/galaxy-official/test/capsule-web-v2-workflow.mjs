import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createBrowserClient} from '../src/browser-client.mjs';
import {digest} from '../src/shared/digest.mjs';
import {createCapsuleWebClient,capsuleCaseSources,currentCapsuleFacts} from "../../galaxy-web/src/features/capsules/capsule-workspace-client.mjs";
import {capsuleToolDefinitions} from '../src/adapters/mcp/personal/tools/capsules-v2.mjs';

const scopes=['binding','consent','case-teaser','history','capsules','evidence','proof'];
async function actual(f,{viewers=[],outcome='succeeded'}={}){
 const caseId=randomUUID(),root={kind:'case-created',schemaVersion:2,eventId:caseId,caseId,expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),title:'合成客户端来源',summary:'只用于接口验收',source:{kind:'local',reference:'synthetic-client'},synthetic:true};
 const attempt={kind:'attempt-start',schemaVersion:2,eventId:randomUUID(),caseId,expectedVersion:1,actorId:f.actor.subjectId,role:'implementation',strategy:'核对当前依赖',inputScopeSummary:'合成材料',permissionScope:['selected-context'],environment:{name:'Node',version:'24'}};
 const result={kind:'result-recorded',schemaVersion:2,eventId:randomUUID(),caseId,expectedVersion:2,actorId:f.actor.subjectId,origin:{kind:'attempt',id:attempt.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:outcome,summary:'合成范围结果',limitations:'未作真实用户验收'};
 for(const e of [root,attempt,result])await f.cases.submitV2(f.actor,await f.authorize(e,'case.teaser.publish',{objectId:e.eventId,viewers}));return {caseId,root,attempt,result};
}
function version(source,permissionId){return {schemaVersion:2,kind:'version',id:randomUUID(),capsuleId:randomUUID(),expectedRevision:0,version:1,title:'合成网页登录方法',problemPattern:'依赖环境差异',environment:{name:'Node',version:'24'},solutionStrategy:'核对版本并执行所选检查',tools:['compiler'],skills:[],mcpRefs:[],verificationMethod:'依赖加载有限测试',limitations:['不能推断全部软件正确'],capabilityId:'software-debugging',applicableScope:'依赖加载',license:'MIT',contributors:[],sourceResolution:{caseId:source.caseId,resultId:source.result.eventId,resultVersion:1,proofIds:[],verificationRefs:[]},publicationClass:'formal-source-success',synthetic:true,sourceRefs:[],permissionRefs:[permissionId],attributionRefs:[],externalReferences:[],redactionConfirmed:true};}
export async function verifyCapsuleWebV2(db,options={}){
 const f=await serviceFixture(scopes,db,{syntheticCommunityQuota:false,now:Math.floor(Date.now()/1000),...options}),p=await serviceFixture(scopes,f.db,{syntheticCommunityQuota:false,now:f.now,...options,migrateDatabase:false});
 const server=createApi(f);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const localEndpoint=`http://127.0.0.1:${server.address().port}`,storage=new Map();let loseConsent=false,losePublish=false,offlineUse=false,lateUse=null,consentPosts=0,publicationPosts=0;
 const getLocal=async k=>structuredClone(storage.get(k)),putLocal=async(k,v)=>storage.set(k,structuredClone(v));
 const browser=createBrowserClient({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys,sign:f.signForTest,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname;
     if(path==='/v1/consents'){consentPosts++;const signed=JSON.parse(options.body).signedIntent;assert.ok([...storage.values()].some(v=>v?.active?.prepared?.signedIntent===signed),'exact signed bytes saved before Consent');}
     if(path==='/v2/capsules/events')publicationPosts++;
     if(path==='/v2/capsules/uses'&&offlineUse){offlineUse=false;lateUse={path,options};throw new Error('synthetic offline pending business');}
     const response=await fetch(localEndpoint+path,options);
     if(path==='/v1/consents'&&loseConsent){loseConsent=false;assert.equal(response.status,200);throw new Error('synthetic lost Consent ACK');}
     if(path==='/v2/capsules/events'&&losePublish){losePublish=false;assert.equal(response.status,200);throw new Error('synthetic lost publication ACK');}
     return response;}});
 const helper=()=>createCapsuleWebClient({api:browser,getLocal,putLocal,subjectId:f.actor.subjectId});
 const call=async(actor,path,input)=>{const response=await fetch(localEndpoint+path,{method:'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${actor.credential}`}:{})},body:JSON.stringify(input)});const value=await response.json();return {status:response.status,value};};
 try{
   const publicKeyPem=f.genesis.genesisProof.publicKeyPem,deviceId=randomUUID(),upgrade={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:f.actor.subjectId,expectedEpoch:0,previousEventHash:null,signerKeyId:digest(publicKeyPem),genesisProof:f.genesis.genesisProof,newDevice:{deviceId,publicKeyPem,scopes:['manage-identity',...scopes]}};
   const challenge=await f.identityControl.challenge(upgrade),signature=await f.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');await f.identityControl.commit({operationId:upgrade.operationId,controllerSignature:signature,newDeviceProof:signature});
   const connect=()=>browser.connect({subjectId:f.actor.subjectId,genesisProof:f.genesis.genesisProof,installationId:randomUUID(),scopes,control:{deviceId,keyId:digest(publicKeyPem),epoch:1}},{confirmed:true});await connect();
   const source=await actual(p,{viewers:[f.actor.subjectId]}),target=await actual(f,{outcome:'failed'}),permission={schemaVersion:2,id:randomUUID(),kind:'grant',sources:[{kind:'result',id:source.result.eventId,version:1,caseId:source.caseId},{kind:'case-root',id:source.caseId,version:1,caseId:source.caseId}],grantees:[f.actor.subjectId],license:'MIT',scope:'选定合成方法来源',basis:'authored-content',attribution:'来源作者贡献',allowPublic:true};
   const permissionSigned=await p.authorize(permission,'capsule.permission',{viewers:[f.actor.subjectId]});assert.equal((await call(p,'/v2/capsules/permissions',permissionSigned)).status,200);
   let client=helper();const v=version(source,permission.id);const catalog=await client.permissions({view:'granted'});assert.equal(catalog.items.find(i=>i.permissionId===permission.id).sourceStatus,'current');
   assert.equal((await call(null,'/v2/capsules/permissions/query',{view:'granted'})).status,401);
   const mismatch=await call(f,'/v2/capsules/receipt',{type:'permission',operationId:permission.id,payloadHash:digest(JSON.stringify(permission))});assert.equal(mismatch.value.state,'absent','cannot inspect other author operation receipt');
   const history=await client.history();const h=history.items.find(i=>i.caseId===target.caseId),sources=capsuleCaseSources(h);assert.ok(sources.some(s=>s.ref.kind==='result'&&s.ref.id===target.result.eventId));assert.equal(currentCapsuleFacts(h.results)[0].reportedOutcome,'failed');
   await client.saveDraft({kind:'synthetic-local-draft',title:'retained locally'});assert.equal((await client.loadDraft()).title,'retained locally');
   const preview=await client.prepare('publication',v,{visibility:'Public'});assert.equal(Number((await f.db.query('SELECT count(*) FROM capsules WHERE id=$1',[v.capsuleId])).rows[0].count),0);
   loseConsent=true;await assert.rejects(client.execute(preview,{confirmed:true}),/synthetic lost Consent/);assert.equal(publicationPosts,0);const firstConsentPosts=consentPosts;
   await connect();client=helper();await client.retry(v.id,{confirmed:true});assert.equal(consentPosts,firstConsentPosts,'accepted original Consent reused after reconnect');assert.equal(publicationPosts,1);
   const view=await client.get({capsuleId:v.capsuleId,versionId:v.id});assert.equal(view.readingIsReuse,false);assert.equal((await client.uses({capsuleId:v.capsuleId})).counts.applications,0);
   const newer={...v,id:randomUUID(),version:2,expectedRevision:1,title:'private corrected presentation'},p2=await client.prepare('publication',newer);losePublish=true;await assert.rejects(client.execute(p2,{confirmed:true}),/synthetic lost publication/);
   const attempted=publicationPosts;client=helper();assert.equal((await client.reconcile(newer.id)).state,'acknowledged');assert.equal(publicationPosts,attempted,'read-only receipt does not repeat publication');
   const anonymousVersions=await call(null,'/v2/capsules/versions',{capsuleId:v.capsuleId});assert.deepEqual(anonymousVersions.value.items.map(i=>i.versionId),[v.id]);assert.equal(anonymousVersions.value.management,undefined);
   assert.equal((await call(null,'/v2/capsules/read',{capsuleId:v.capsuleId})).status,404);assert.equal((await call(null,'/v2/capsules/read',{capsuleId:v.capsuleId,versionId:v.id})).status,200);
   assert.equal((await client.versions({capsuleId:v.capsuleId})).management.publishedVersionCount,2);
   const base={schemaVersion:2,id:randomUUID(),kind:'reference',capsuleId:v.capsuleId,versionId:v.id,caseId:target.caseId,attribution:f.actor.subjectId,note:'只是参考，不声明执行'};
   const pr=await client.prepare('use',base);offlineUse=true;await assert.rejects(client.execute(pr,{confirmed:true}),/synthetic offline/);
   const stop=await client.stopLocalRetry(base.id,{confirmed:true});assert.equal(stop.serverCancellationConfirmed,false);const journal=[...storage.values()].find(v=>v?.stopped?.length);assert.equal(journal.active,null);assert.ok(!JSON.stringify(journal).includes(base.note));
   assert.equal((await fetch(localEndpoint+lateUse.path,lateUse.options)).status,200);assert.equal((await client.reconcile(base.id)).state,'acknowledged');
   const use={...base,id:randomUUID(),kind:'apply',note:'实际应用仍失败',attemptRef:{id:target.attempt.eventId,version:1},resultRef:{id:target.result.eventId,version:1},environment:{name:'Node',version:'24'},environmentDifference:'不同依赖树',adoptedParts:['核对依赖版本'],outcome:'failed'};
   await client.execute(await client.prepare('use',use),{confirmed:true});const uses=await client.uses({capsuleId:v.capsuleId});assert.equal(uses.counts.references,1);assert.equal(uses.counts.applications,1);assert.equal(uses.counts.reportedSuccessfulTargetCases,0);
   const evidence={kind:'evidence',id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId:target.caseId,reportedBy:f.actor.subjectId,synthetic:true,observedAt:new Date(f.now*1000).toISOString(),evidenceType:'test-result',source:{originSystem:'synthetic-web-flow',externalStableId:randomUUID(),contentVersion:'1',issuer:f.actor.subjectId,originalAt:new Date(f.now*1000).toISOString()},reportedSourceState:'available',summary:'合成依赖检查仍失败'};
   const verification={kind:'verification',id:randomUUID(),operationId:randomUUID(),expectedVersion:0,caseId:target.caseId,reportedBy:f.actor.subjectId,synthetic:true,observedAt:evidence.observedAt,target:{type:'result',id:target.result.eventId,version:1},scopeVersion:1,method:'local-test',scope:'依赖加载',conditions:{environment:'synthetic'},observation:'failed',evidenceRefs:[{id:evidence.id,version:1}],relationship:'same-controller',summary:'有限检查未通过'};
   for(const record of [evidence,verification])await f.verificationRecords.submit(f.actor,await f.authorize(record,'evidence.submit',{objectId:record.operationId}));
   const checkedHistory=await client.history();assert.ok(capsuleCaseSources(checkedHistory.items.find(i=>i.caseId===target.caseId)).some(s=>s.ref.kind==='verification'&&s.ref.version===1));
   await client.execute(await client.prepare('use',{...use,id:randomUUID(),kind:'reverify',priorUseId:use.id,verificationRefs:[{id:verification.id,version:1}]}),{confirmed:true});
   assert.equal((await client.uses({capsuleId:v.capsuleId})).counts.reverifications,1);assert.equal((await client.uses({capsuleId:v.capsuleId})).counts.independentlyVerifiedReuseCases,0);
   const revoke={schemaVersion:2,id:randomUUID(),kind:'revoke',permissionId:permission.id,reason:'合成源许可撤回'};assert.equal((await call(p,'/v2/capsules/permissions',await p.authorize(revoke,'capsule.permission',{viewers:[f.actor.subjectId]}))).status,200);
   assert.equal((await client.get({capsuleId:v.capsuleId,versionId:v.id})).version,null);assert.equal((await client.permissions({view:'granted'})).items[0].revoked,true);
   const tombstone=await client.get({capsuleId:v.capsuleId,versionId:v.id});assert.equal(tombstone.authorId,f.actor.subjectId,'owner can still maintain a version with unavailable source');
   await client.execute(await client.prepare('publication',{schemaVersion:2,id:randomUUID(),kind:'deprecate',capsuleId:v.capsuleId,versionId:v.id,expectedRevision:2,summary:'来源撤回后停止新应用'},{visibility:'Public'}),{confirmed:true});assert.equal((await client.get({capsuleId:v.capsuleId,versionId:v.id})).deprecated,true);
   const finalReceipt=await browser.call('/v2/capsules/receipt',{type:'publication',operationId:v.id,payloadHash:preview.payloadHash});assert.equal(finalReceipt.state,'acknowledged');assert.equal(finalReceipt.currentReadPermissionConfirmed,false);
   const tools=capsuleToolDefinitions(f,f.actor);assert.equal((await tools.galaxy_capsule_v2_receipt.run({type:'publication',operationId:v.id,payloadHash:preview.payloadHash})).state,'acknowledged');
   assert.equal((await client.uses({capsuleId:v.capsuleId})).items.find(i=>i.kind==='apply').record,null);
   return {realSignedHttp:true,syntheticOnly:true,localStorage:'explicit-memory-substitute',sourcePermissionsRevoked:true,readNeverCountedAsApplication:true};
 }finally{await Promise.resolve(browser.disconnect()).catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(!db)await f.db.close();}
}
