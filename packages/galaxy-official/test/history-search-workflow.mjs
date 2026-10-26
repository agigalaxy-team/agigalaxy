import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { EvidenceService } from "../src/evidence/evidence.mjs";
import { ConsentReader } from "../src/consents/consent-reader.mjs";
import { inspectGithubRun } from "../src/evidence/github-evidence.mjs";
import { createApi } from '../src/http.mjs';
import { createHistoryClient } from "../src/clients/history.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";

export async function verifyHistorySearch(database=null,options={}){
  const scopes=['binding','consent','case-teaser','history','assistance','evidence','proof'];
  const f=await serviceFixture(scopes,database,options),other=await serviceFixture(['binding','history'],f.db,options);
  const pub={visibility:'Public',purpose:'public-profile'},shared={visibility:'Private',viewers:[other.actor.subjectId]};
  const query=(actor,input)=>f.history.query(actor,{subjectId:f.actor.subjectId,...input});
  const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerReads?.readGrant}),
    {db:options.workerDb??f.db,endpoint:f.bindings.endpoint,now:()=>f.now,readCase:options.workerReads?.readCase});
  const samples=[];let runId=100;
  const uuid=index=>`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
  const create=async(index,{title='Compiler regression',audience=pub,capabilityId,capAudience=audience,proofAudience,environment='Node'}={})=>{
    const root={kind:'case',id:uuid(index),localRef:randomUUID(),title,summary:'Dependency resolution problem',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const rootGrant=await f.authorize(root,'case.teaser.publish',audience);await f.cases.submit(f.actor,rootGrant);
    const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'Inspect dependencies',configuration:{environment,version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt,'case.teaser.publish',audience));
    const result={kind:'result',id:randomUUID(),caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'failed',summary:'Reported failure',failureReason:'Missing module',limitations:['Fixture']};
    await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',audience));
    const sample={id:root.id,rootGrant};samples.push(sample);
    if(capabilityId){
      const request={id:randomUUID(),caseId:root.id,title:'Need capability',problem:'Dependency failure',attemptedApproaches:[],scope:'Inspect module',visibility:capAudience.visibility??'Private',collaboration:'open-assistance',capabilityId,enrollmentExpiresAt:f.now+600};
      sample.capabilityGrant=await f.authorize(request,'assistance.publish',capAudience);await f.assistance.create(f.actor,sample.capabilityGrant);sample.assistanceId=request.id;
    }
    if(proofAudience){
      const evidence={id:randomUUID(),caseId:root.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'search',runId:runId++,attempt:1,commit:'a'.repeat(40)}};
      sample.evidenceId=evidence.id;
      sample.evidenceGrant=await f.authorize(evidence,'evidence.submit',audience);await f.evidence.submit(f.actor,sample.evidenceGrant);
      await worker.processNext((source,now)=>inspectGithubRun(source,{id:source.runId,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/search',private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
      const preview=await f.proofs.preview(f.actor,{id:uuid(1000+index),evidenceId:evidence.id});sample.proofGrant=await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',proofAudience);
      sample.proof=await f.proofs.publish(f.actor,sample.proofGrant);
    }
    return sample;
  };
  let api,sessions;
  try{
    await create(1,{capabilityId:'design'});await create(2,{});
    const relevant=await create(3,{capabilityId:'compiler',proofAudience:pub});
    // Twenty earlier private Proof IDs must not crowd the later public Proof
    // out of the bounded candidate list or alter anonymous strength filtering.
    for(let i=100;i<120;i++){
      const preview=await f.proofs.preview(f.actor,{id:uuid(i),evidenceId:relevant.evidenceId});
      await f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish'));
    }
    await create(4,{title:'Private needle',audience:{},capabilityId:'compiler'});
    const privateAssociation=await create(5,{capabilityId:'compiler',capAudience:{}});
    const hiddenProof=await create(6,{capabilityId:'compiler',proofAudience:{}});
    const sharedCase=await create(7,{audience:shared,capabilityId:'compiler'});
    const baseline=[
      {input:{query:'compiler',capabilityId:'compiler',verificationStrength:'ci-execution-fact'},ids:[relevant.id]},
      {input:{query:'compiler',capabilityId:'compiler',verificationStrength:'reported-only'},ids:[hiddenProof.id]},
      {input:{query:'compiler',capabilityId:'design'},ids:[uuid(1)]},
      {input:{query:'unrelated'},ids:[]},
      {input:{query:'Private needle'},ids:[]},
      {input:{query:'compiler',capabilityId:'compiler'},ids:[relevant.id,hiddenProof.id]}
    ];
    for(const scenario of baseline){const page=await query(null,scenario.input);assert.deepEqual(page.items.map(item=>item.caseId),scenario.ids);}
    const first=await query(null,{query:'compiler',capabilityId:'compiler',limit:1});
    assert.equal(first.items[0].caseId,relevant.id);assert.equal(first.nextCursor,relevant.id);
    const next=await query(null,{query:'compiler',capabilityId:'compiler',limit:1,after:first.nextCursor});
    assert.deepEqual(next.items.map(item=>item.caseId),[hiddenProof.id]);assert.equal(next.nextCursor,null);
    const explanation=first.items[0].searchExplanation;
    assert.deepEqual(explanation.textMatches,[{term:'compiler',fields:['title']}]);
    assert.equal(explanation.capabilityMatches[0].assistanceId,relevant.assistanceId);
    assert.equal(explanation.verification.strength,'ci-execution-fact');assert.equal(explanation.verification.capabilityVerified,false);
    assert.deepEqual(explanation.sources.map(source=>source.kind),['case','history','proof']);
    assert.equal(first.items[0].results[0].outcome,'failed'); // CI success does not replace the reported task failure.
    assert.equal(explanation.registeredAt,undefined);assert.ok(!JSON.stringify(explanation).includes('Node'));
    const otherView=await query(other.actor,{capabilityId:'compiler'});
    assert.ok(otherView.items.some(item=>item.caseId===sharedCase.id));assert.ok(!otherView.items.some(item=>item.caseId===privateAssociation.id));
    const owner=await query(f.actor,{environment:'node',sourceKind:'local',createdFrom:'2000-01-01T00:00:00Z',capabilityId:'compiler',verificationStrength:'ci-execution-fact'});
    assert.deepEqual(owner.items.map(item=>item.caseId),[relevant.id,hiddenProof.id]);
    assert.ok(owner.items.every(item=>item.searchExplanation.registeredAt));
    const original=JSON.stringify(await query(null,{query:'compiler',capabilityId:'compiler'}));
    await create(8,{title:'Private matching compiler',audience:{},capabilityId:'compiler'});
    assert.equal(JSON.stringify(await query(null,{query:'compiler',capabilityId:'compiler'})),original);
    await f.consents.revoke(f.actor,relevant.capabilityGrant.consentId);
    assert.deepEqual((await query(null,{capabilityId:'compiler',verificationStrength:'ci-execution-fact'})).items,[]);
    await f.consents.revoke(f.actor,hiddenProof.proofGrant.consentId);
    assert.deepEqual((await query(f.actor,{capabilityId:'compiler',verificationStrength:'ci-execution-fact'})).items,[]);
    await f.consents.revoke(f.actor,sharedCase.rootGrant.consentId);
    assert.ok(!(await query(other.actor,{capabilityId:'compiler'})).items.some(item=>item.caseId===sharedCase.id));
    // The portable client accepts both new filters through the actual HTTP API.
    api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});sessions.adopt({endpoint:f.bindings.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
    const client=createHistoryClient({endpoint:f.bindings.endpoint,sessions,send:async(url,input)=>{
      const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson});assert.equal(response.status,200);return response.json();}});
    const clientPage=await client.query({capabilityId:'compiler',verificationStrength:'reported-only',limit:1});
    assert.equal(clientPage.items[0].searchExplanation.verification.strength,'reported-only');
    await assert.rejects(client.query({verificationStrength:'expert'}));await assert.rejects(client.query({capabilityId:'invalid capability'}));
  }finally{sessions?.close();if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}if(!database)await f.db.close();}
}
