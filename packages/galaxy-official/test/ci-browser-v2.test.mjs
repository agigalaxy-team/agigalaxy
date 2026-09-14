import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {getCiClient,ciSourceFromEvidence} from '../../galaxy-web/src/ci-client.mjs';
import {ciSourceMetadata} from '../src/shared/ci-observation-v2-schema.mjs';
import {inspectGithubRun} from '../src/github-evidence.mjs';
test('CI browser signed workflow keeps exact operations through lost Consent and publication replies',async()=>{
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000}),data=new Map();
  const store={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>{data.set(k,structuredClone(v));}};let runtime,dropConsent=false,dropPath=null;
  try{await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    const config={endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys};const fetcher=async(url,options)=>{const path=new URL(url).pathname,response=await fetch(origin+path,options);
      if(dropConsent&&path==='/v1/consents'){dropConsent=false;assert.equal(response.status,200);throw new Error('synthetic lost Consent reply');}
      if(path===dropPath){dropPath=null;assert.equal(response.status,200);throw new Error('synthetic lost write reply');}return response;};
    runtime=await createWebRuntime(config,{store,fetch:fetcher,now:()=>f.now});await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
    const subjectId=(await runtime.status()).identity.subjectId,caseId=randomUUID();
    const write=async(path,payload,action,objectId)=>runtime.api.call(path,await runtime.api.authorizePayload(payload,{action,objectId,confirmed:true}));
    const root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:subjectId,localRef:randomUUID(),title:'PRIVATE TITLE',summary:'PRIVATE SUMMARY',source:{kind:'local',reference:randomUUID()},synthetic:true};
    await write('/v2/cases/events',root,'case.teaser.publish',caseId);
    const intervention={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId,expectedVersion:1,actorId:subjectId,types:['diagnosis'],affectsAttemptIds:[],description:'Synthetic diagnosis',sourceRefs:[],observedEffect:'Scoped analysis'};
    await write('/v2/cases/events',intervention,'case.teaser.publish',intervention.eventId);
    const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:2,actorId:subjectId,scopeVersion:1,origin:{kind:'intervention',id:intervention.eventId,version:1},deliverableRefs:[],reportedOutcome:'partial',summary:'Synthetic partial result',limitations:'Only synthetic'};
    await write('/v2/cases/events',result,'case.teaser.publish',result.eventId);
    const source={provider:'github-actions',owner:'synthetic',repository:'sample',runId:12,attempt:1,commit:'b'.repeat(40)};
    const evidence={id:randomUUID(),operationId:randomUUID(),kind:'evidence',expectedVersion:0,caseId,reportedBy:subjectId,synthetic:true,evidenceType:'ci-result',
      source:{...ciSourceMetadata(source),originalAt:new Date(f.now*1000).toISOString(),issuer:'GitHub Actions'},observedAt:new Date(f.now*1000).toISOString(),reportedSourceState:'available',summary:'Private evidence note'};
    await write('/v2/verification-records/submit',evidence,'evidence.submit',evidence.operationId);
    const ev=await runtime.api.call('/v2/verification-records/read',{type:'evidence',id:evidence.id});assert.deepEqual(ciSourceFromEvidence(ev),source);
    assert.equal(ciSourceFromEvidence({...ev,referenceStatus:'superseded'}),null);
    const request={id:randomUUID(),schemaVersion:2,kind:'observe',purpose:'observe-selected-ci-source-and-prepare-bounded-proof',caseId,evidenceRef:{id:evidence.id,version:1},resultRef:{id:result.eventId,version:1},source};
    let client=getCiClient(runtime,subjectId);dropConsent=true;await assert.rejects(client.submit('request',request,{confirmed:true}),/lost Consent/);
    const signature=(await client.local()).pending.prepared.signedIntent;runtime.close();runtime=await createWebRuntime(config,{store,fetch:fetcher,now:()=>f.now});await runtime.connect({confirmed:true});client=getCiClient(runtime,subjectId);
    dropPath='/v2/ci/requests';await assert.rejects(client.reconcile({retry:true,confirmed:true}),/lost write/);
    assert.equal((await client.local()).pending.prepared.signedIntent,signature);assert.equal((await client.reconcile()).state,'recorded');
    assert.equal((await client.local()).requests.length,1);
    await f.ciV2.processNext((r,now)=>inspectGithubRun(r,{id:r.runId,run_attempt:r.attempt,head_sha:r.commit,status:'completed',conclusion:'success',repository:{id:123,full_name:`${r.owner}/${r.repository}`,private:false},updated_at:new Date(now*1000).toISOString()},now));
    const preview=await runtime.api.call('/v2/ci/proofs/preview',{id:randomUUID(),requestId:request.id}),proof=JSON.parse(preview.payloadJson);
    assert.equal(preview.payloadJson.includes(caseId),false);assert.equal(preview.payloadJson.includes(evidence.summary),false);
    dropPath='/v2/ci/proofs/publish';await assert.rejects(client.submit('proof',proof,{visibility:'Public',confirmed:true}),/lost write/);
    assert.equal((await client.reconcile()).state,'recorded');assert.equal((await client.local()).pending,null);
    assert.equal((await runtime.api.call('/v2/ci/proofs/read',{id:proof.id},{authenticated:false})).status,'active');
    assert.equal(Number((await f.db.query('SELECT count(*) FROM ci_proofs_v2 WHERE subject_id=$1',[subjectId])).rows[0].count),1);
    runtime.api.disconnect();await assert.rejects(client.local(),/身份或连接已变化/);
  }finally{runtime?.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
