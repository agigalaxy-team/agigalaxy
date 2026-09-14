import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {createServices} from '../src/services.mjs';
import {createApi} from '../src/http.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createGalaxyGenesis} from '../../galaxy-core/src/galaxy-guid.mjs';
import {createRetirementController} from '../src/retirement.mjs';
import {createIncidentController} from '../src/operations/incident.mjs';
import {retirementFixturePolicy} from './retirement-workflow.mjs';

const store=()=>{const values=new Map();return{get:async key=>structuredClone(values.get(key)),put:async(key,value)=>{values.set(key,structuredClone(value));}};};

test('existing browser control reconnects for bounded takeout and incident withdrawal, without reopening publication or enrollment',async()=>{
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)});
  const base=f.now;let at=base;
  const policy=retirementFixturePolicy(base),retirement=createRetirementController(policy,{endpoint:f.bindings.endpoint,now:()=>at});
  let state=createIncidentController(null,{endpoint:f.bindings.endpoint,now:()=>at});
  const incident={snapshot:()=>state.snapshot(),canProcessEvidence:()=>state.canProcessEvidence(),
    assertRoute:(...args)=>state.assertRoute(...args),assertBindingSubject:(...args)=>state.assertBindingSubject(...args)};
  const key=generateKeyPairSync('ed25519'),trustedKeys=new Map([['exit-fixture',{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:base-1,notAfter:base+100000,revoked:false}]]);
  const services=createServices({db:f.db,endpoint:f.bindings.endpoint,kid:'exit-fixture',signingKey:key.privateKey,trustedKeys,
    allowedScopes:browserScopes,operator:'Synthetic',region:'isolated',now:()=>at,retirement,incident});
  const origin='https://galaxy.example.org',api=createApi({...services,browserOrigins:[origin],rateLimit:10000});
  let runtime,other,dropTask=true,dropDeletion=false;
  try{
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const local='http://127.0.0.1:'+api.address().port,config={endpoint:f.bindings.endpoint,trustedKeys};
    const wire=async(url,options)=>{
      const path=new URL(url).pathname;
      const response=await fetch(local+path,{...options,headers:{...options.headers,Origin:origin}});
      if(dropTask&&path==='/v2/tasks'){dropTask=false;assert.equal(response.status,200);throw new Error('lost committed task acknowledgement');}
      if(dropDeletion&&path==='/v1/deletion-requests/submit'){dropDeletion=false;assert.equal(response.status,200);throw new Error('lost deletion acknowledgement');}
      return response;
    };
    const disk=store();runtime=await createWebRuntime(config,{store:disk,fetch:wire,now:()=>at});
    await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
    const subjectId=(await runtime.status()).identity.subjectId;
    await assert.rejects(runtime.publishTask({title:'退役取回夹具',summary:'本人私有任务',intent:'collaboration',
      workContext:{goal:'验证退出',currentSituation:'没有失败尝试',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:base+86400},{confirmed:true}),/lost committed/);
    const saved=await runtime.getLocal('task-publication'),taskId=saved.payload.taskId,consentId=saved.preparedConsent.intent.id;
    other=await createWebRuntime(config,{store:store(),fetch:wire,now:()=>at});await other.createIdentity({confirmed:true});await other.connect({confirmed:true});
    const strangerKeys=generateKeyPairSync('ed25519'),stranger=createGalaxyGenesis({publicKeyPem:strangerKeys.publicKey.export({type:'spki',format:'pem'}),originCode:'5'});
    const enrollment={subjectId:stranger.id,genesisProof:stranger.genesisProof,installationId:randomUUID(),scopes:['binding']};

    at=policy.stopWritesAt;
    runtime.close();runtime=await createWebRuntime(config,{store:disk,fetch:wire,now:()=>at});
    await runtime.connect({confirmed:true});assert.equal((await runtime.status()).connection.subjectId,subjectId);
    const consent=await runtime.api.reconcileAuthorization(saved.preparedConsent);assert.equal(consent.state,'acknowledged');
    const restored=await runtime.reconcilePublication();assert.equal(restored.taskId,taskId);assert.equal(restored.state,'acknowledged');
    assert.equal((await runtime.api.call(`/v2/tasks/${taskId}`,null,{method:'GET'})).caseId,null);
    await assert.rejects(other.api.call(`/v2/tasks/${taskId}`,null,{method:'GET'}),{code:'not_found',status:404});
    await assert.rejects(runtime.api.call('/v1/binding-challenges',enrollment,{authenticated:false}),/service_enrollment_stopped/);
    const ticket=await runtime.privacy.createExport({datasets:['identity','tasks']},{confirmed:true});
    assert.equal(ticket.expiresAt,policy.takeoutUntil);
    const takeout=await runtime.privacy.download();assert.equal(takeout.manifest.complete,true);assert.ok(takeout.content.includes(subjectId));
    for(const path of ['/v2/tasks',`/v2/tasks/${taskId}/events`,'/v2/capsules/events','/v2/configurations/events','/v2/contributions/publish','/v1/consents','/v2/identity/control/challenges'])
      await assert.rejects(runtime.api.call(path,{consentId,payloadJson:'{"kind":"publish"}'}),/service_writes_stopped/,path);

    state=createIncidentController({version:1,id:'isolated',revision:1,endpoint:f.bindings.endpoint,state:'contained',updatedAt:at,publicMessage:'Synthetic incident',recovery:null},{endpoint:f.bindings.endpoint,now:()=>at});
    runtime.disconnect();await runtime.connect({confirmed:true});
    await assert.rejects(runtime.api.call('/v1/binding-challenges',enrollment,{authenticated:false}),/service_enrollment_stopped/);
    const rejected=await fetch(local+`/v1/consents/${consentId}/revoke`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer invalid'},body:'{}'});
    assert.equal(rejected.status,401);
    await assert.rejects(runtime.api.call(`/v2/tasks/${taskId}`,null,{method:'GET'}),/service_incident_contained/);
    await assert.rejects(runtime.api.call('/v1/data-exports/page',{id:ticket.id,dataset:'identity'}),{code:'service_incident_contained',status:503});
    const deletion=await runtime.privacy.prepareDeletion({action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'});
    dropDeletion=true;await assert.rejects(runtime.privacy.submitDeletion(deletion,{confirmed:true}),/lost deletion/);
    runtime.disconnect();await runtime.connect({confirmed:true});
    const requested=await runtime.privacy.reconcileDeletion();assert.equal(requested.state,'requested');assert.equal(requested.physicalDeletionPerformed,false);
    assert.equal((await runtime.privacy.queryDeletion()).items.length,1);
    const cancel=await runtime.privacy.prepareDeletion({action:'cancel',requestId:requested.id,expectedRevision:requested.revision});
    assert.equal((await runtime.privacy.submitDeletion(cancel,{confirmed:true})).state,'cancelled');
    await runtime.api.call(`/v1/consents/${consentId}/revoke`,{});
    assert.equal((await runtime.api.call('/v2/consents/receipt',{consentId})).status,'revoked');

    state=createIncidentController(null,{endpoint:f.bindings.endpoint,now:()=>at});
    await assert.rejects(runtime.api.call(`/v2/tasks/${taskId}`,null,{method:'GET'}),/consent|task_unavailable|task_not_found|access_denied/);
    at=policy.takeoutUntil;
    await assert.rejects(runtime.api.call(`/v2/identity/${subjectId}/control`,null,{method:'GET',authenticated:false}),/service_retired/);
    await assert.rejects(runtime.api.call('/v1/data-exports/page',{id:ticket.id,dataset:'identity'}),{code:'service_retired',status:410});
    assert.equal(retirement.phase(),'status-only');
  }finally{runtime?.close();other?.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});

test('the explicit stop/readonly policy never admits a mixed events route or a similarly named future mutation',()=>{
  const policy=retirementFixturePolicy(),retirement=createRetirementController(policy,{endpoint:policy.endpoint,now:()=>policy.stopWritesAt});
  const incident=createIncidentController({version:1,id:'contained',revision:1,endpoint:policy.endpoint,state:'contained',updatedAt:policy.stopWritesAt,publicMessage:'Synthetic',recovery:null},{endpoint:policy.endpoint,now:()=>policy.stopWritesAt});
  const participants='/v2/chat/rooms/'+randomUUID()+'/agent-participants';
  retirement.assertRoute('POST',participants);
  assert.throws(()=>incident.assertRoute('POST',participants),/service_incident_contained/);
  assert.throws(()=>retirement.assertRoute('PUT',participants),/service_writes_stopped/);
  assert.throws(()=>retirement.assertRoute('POST',participants+'/events'),/service_writes_stopped/);
  for(const path of ['/v2/capsules/events','/v2/context/'+randomUUID()+'/events','/v2/trust-package/permissions/submit',
    '/v2/hubs/peering/exchange','/v2/chat/rooms/'+randomUUID()+'/send','/v2/choice-snapshots/put','/v2/ci/proofs/publish','/v2/ci/proofs/revoke-all']){
    assert.throws(()=>retirement.assertRoute('POST',path),/service_writes_stopped/);
    assert.throws(()=>incident.assertRoute('POST',path),/service_incident_contained/);
  }
  for(const path of ['/v2/ci/proofs/revoke','/v2/choice-snapshots/delete','/v2/chat/rooms/'+randomUUID()+'/agent-revoke']){
    retirement.assertRoute('POST',path);incident.assertRoute('POST',path);
    assert.throws(()=>retirement.assertRoute('PUT',path),/service_writes_stopped/);
  }
});
