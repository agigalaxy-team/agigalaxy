import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {handoffExistingWebIdentity,existingWebFixtureWebsite} from './existing-web-identity-fixture.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createHelpSearchClient} from '../../galaxy-web/src/help-search-client.mjs';
test('Browser help composition and local choice versions use actual API, survive source failure and never imply application or cloud sync',async()=>{
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000}),data=new Map();
  const store={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),update:memoryAtomicUpdate(data)};
  let runtime,client,taskFailure=true;const requests=[];
  try{
    const id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,
      localRef:randomUUID(),title:'Browser search example',summary:'Only synthetic facts',synthetic:true,source:{kind:'local',reference:randomUUID()}};
    const put=async payload=>{const signed=await f.authorize(payload,'case.teaser.publish',{objectId:payload.eventId,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,signed);return signed;};
    await put(root);
    const intervention={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId:id,expectedVersion:1,actorId:f.actor.subjectId,
      types:['diagnosis'],affectsAttemptIds:[],description:'Selected actual diagnosis',sourceRefs:[],observedEffect:'Limited conclusion'};await put(intervention);
    const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId:id,expectedVersion:2,actorId:f.actor.subjectId,scopeVersion:1,
      origin:{kind:'intervention',id:intervention.eventId,version:1},deliverableRefs:[],reportedOutcome:'partial',summary:'Partial result not a success certificate',limitations:'Synthetic'};
    const resultGrant=await put(result);
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    runtime=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store,now:()=>f.now,website:existingWebFixtureWebsite,
      fetch:async(url,options)=>{const path=new URL(url).pathname;requests.push(path);if(taskFailure&&path==='/v2/search/query'&&JSON.parse(options.body).type==='task')throw new Error('synthetic task transport interruption');return fetch(origin+path,options);}});
    client=createHelpSearchClient(runtime);
    await runtime.putLocal('personal-summary-preferences',{cloudSyncEnabled:true});
    const combined=await client.combine([{type:'history',query:{query:'Browser'}},{type:'task',query:{}},{type:'capsule',query:{}}]);
    assert.equal(combined.hasPartialFailure,true);assert.equal(combined.sources[0].page.items.length,1);assert.equal(combined.sources[1].state,'failed');assert.equal(combined.sources[1].page,null);assert.equal(combined.sources[2].page.pageCount,0);
    const item=combined.sources[0].page.items[0],k=client.candidateKey(item),choice={id:randomUUID(),expectedVersion:0,localTaskRef:'local-work',visibleRationale:'相关诊断值得复看，环境尚未确认',rationaleAuthor:'user-agent',candidateKeys:[k],selectedKeys:[k],resultRefs:client.resultReferences()};
    assert.equal(choice.resultRefs.length,1);const one=await client.saveChoice(choice);const again=await client.saveChoice(choice);assert.equal(one.hash,again.hash);
    const local=await client.local();assert.equal(local.cloudSyncEnabled,false);assert.equal(local.choices.length,1);assert.equal(local.choices[0].versions.length,1);
    assert.equal(local.choices[0].versions[0].resultRefs[0].id,result.eventId);assert.match(one.selectionMeaning,/not-contacted-or-applied/);
    assert.equal(JSON.stringify(local).includes(intervention.description),false);assert.equal(JSON.stringify(local).includes('reasoning'),false);
    await assert.rejects(client.saveChoice({...choice,id:randomUUID(),candidateKeys:['invented'],selectedKeys:[]}),/source_not_read/);
    await assert.rejects(client.saveChoice({...choice,id:randomUUID(),resultRefs:[{caseId:id,id:randomUUID(),version:1}]}),/actual_fact_workflow/);
    await assert.rejects(client.saveChoice({...choice,visibleRationale:'different bytes same version'}),/version_conflict/);
    await f.consents.revoke(f.actor,resultGrant.consentId);
    client.close();client=createHelpSearchClient(runtime);const refreshed=await client.refreshChoice(choice.id);
    assert.equal(refreshed.referenceStates[k].state,'changed');assert.equal(refreshed.referenceStates[k].priorRationaleCurrent,false);
    assert.equal(refreshed.choices[0].versions[0].visibleRationale,choice.visibleRationale);
    assert.ok(requests.every(path=>path.startsWith('/v2/search/')),'only read queries, no cloud save or business write');
    assert.equal((await client.removeChoice(choice.id)).choices.length,0);
    await handoffExistingWebIdentity(runtime,{now:()=>f.now});await assert.rejects(client.local(),/identity_changed/);
    taskFailure=false;
  }finally{client?.close();runtime?.close();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
