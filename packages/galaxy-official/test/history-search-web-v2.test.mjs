import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {createHistoryClient,prepareHistoryQuery} from '../../galaxy-web/src/history-client.mjs';
import {createHelpSearchClient} from '../../galaxy-web/src/help-search-client.mjs';

test('history browser queries real visible facts and more than 64 loaded search results preserve only the explicit comparison',async()=>{
  // The fixture clock is fixed while database timestamps continue advancing
  // during the 65 writes. Keep those synthetic rows inside its query window.
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)+30}),api=createApi({...f,rateLimit:1000}),data=new Map();
  let runtime,history,search;const calls=[];
  try{
    const rows=[];
    const put=async p=>{const signed=await f.authorize(p,'case.teaser.publish',{objectId:p.eventId,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,signed);return signed;};
    for(let n=0;n<65;n++){
      const id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),
        title:`History-browser synthetic ${n}`,summary:'Only synthetic API evidence, not a pilot',synthetic:true,source:{kind:'local',reference:randomUUID()}};
      await put(root);rows.push(root);
    }
    const first=rows[0],intervention={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId:first.caseId,expectedVersion:1,actorId:f.actor.subjectId,types:['diagnosis'],affectsAttemptIds:[],description:'Actual limited diagnostic record',sourceRefs:[],observedEffect:'Not yet repaired'};
    await put(intervention);
    const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId:first.caseId,expectedVersion:2,actorId:f.actor.subjectId,scopeVersion:1,
      origin:{kind:'intervention',id:intervention.eventId,version:1},deliverableRefs:[],reportedOutcome:'failed',summary:'Failed synthetic result',limitations:'No production execution'};
    const resultGrant=await put(result);
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    runtime=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store:{get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),update:memoryAtomicUpdate(data)},now:()=>f.now,
      fetch:async(url,options)=>{calls.push(new URL(url).pathname);return fetch(origin+new URL(url).pathname,options);}});
    history=createHistoryClient(runtime);search=createHelpSearchClient(runtime);
    const request=prepareHistoryQuery({subjectId:f.actor.subjectId,query:'History-browser',environment:'Windows',limit:50});
    assert.deepEqual(request.timeWindow,{kind:'all-visible'});
    const page=await history.query(request),next=await history.query({...request,after:page.nextCursor});
    assert.equal(page.items.length+next.items.length,65);assert.equal(next.nextCursor,null);
    const detail=[...page.items,...next.items].find(v=>v.caseId===first.caseId);
    assert.equal(detail.results[0].reportedOutcome,'failed');assert.equal(detail.interventions[0].actorId,f.actor.subjectId);assert.equal(detail.attempts.length,0);
    assert.equal(detail.capabilityVerified,false);assert.ok(detail.matchReasons.some(r=>r.kind==='environment-unknown'));
    assert.equal((await history.query(prepareHistoryQuery({subjectId:f.actor.subjectId,timeWindow:'90-days',limit:50}))).items.length,50);
    assert.equal((await history.query(prepareHistoryQuery({subjectId:f.actor.subjectId,timeWindow:'custom',from:'2000-01-01T00:00:00Z',before:'2001-01-01T00:00:00Z'}))).items.length,0);
    assert.throws(()=>prepareHistoryQuery({subjectId:f.actor.subjectId,timeWindow:'custom',from:'2001-01-01T00:00:00Z',before:'2000-01-01T00:00:00Z'}));
    const loaded=[];let after=null;
    do{const response=await search.query({type:'history',query:{query:'History-browser',limit:20,after}});loaded.push(...response.items);after=response.nextCursor;}while(after);
    assert.equal(loaded.length,65);
    const keys=[loaded[0],loaded[40],loaded[64]].map(search.candidateKey),input={id:randomUUID(),localTaskRef:'local-comparison',visibleRationale:'Compare three exact current sources; currently no selection',rationaleAuthor:'user',candidateKeys:keys,selectedKeys:[]};
    const saved=await search.saveChoice(input);assert.equal(saved.candidateRefs.length,3);assert.equal(saved.selectedRefs.length,0);
    assert.equal(saved.candidateRefs[2].id,loaded[64].ref.id,'last loaded source is kept; no implicit first-64 slice');
    const chosen=await search.saveChoice({...input,expectedVersion:1,selectedKeys:[keys[2]]});assert.equal(chosen.selectedRefs[0].id,loaded[64].ref.id);
    await assert.rejects(search.saveChoice({...input,id:randomUUID(),candidateKeys:loaded.map(search.candidateKey)}),/invalid_choice_snapshot/);
    await f.consents.revoke(f.actor,resultGrant.consentId);
    await assert.rejects(history.query({...request,after:page.nextCursor}),e=>e.code==='history_sources_changed_retry');
    const refreshed=await history.query({...request,query:'History-browser synthetic 0'});assert.equal(refreshed.items[0].results.length,0);
    assert.ok(calls.every(p=>p==='/v2/history/query'||p==='/v2/search/query'),'browser uses read routes only; comparison remains local');
    await runtime.createIdentity({confirmed:true});await assert.rejects(history.query(request),/history_identity_changed/);
  }finally{history?.close();search?.close();runtime?.close();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
