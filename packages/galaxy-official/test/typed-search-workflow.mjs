import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSearchClient } from '../src/history-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';

export async function verifyTypedSearch(database=null,options={}){
  const scopes=['binding','consent','case-teaser','evidence','proof','history','capsules'];
  const f=await serviceFixture(scopes,database,options),outsider=await serviceFixture(['binding','history'],f.db,options);
  const pub={visibility:'Public',purpose:'public-profile'},endpoint=f.access.endpoint;
  const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerReads?.readGrant}),
    {db:options.workerDb??f.db,endpoint,now:()=>f.now,readCase:options.workerReads?.readCase});
  async function createCase(title,audience){
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title,summary:'Dependency repair',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const grant=await f.authorize(root,'case.teaser.publish',audience);await f.cases.submit(f.actor,grant);
    const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'Inspect compiler',configuration:{environment:'Node',version:'24',tools:['compiler']}};
    await f.cases.submit(f.actor,await f.authorize(attempt,'case.teaser.publish',audience));
    const result={id:randomUUID(),kind:'result',caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Owner-reported result',failureReason:'',limitations:['Synthetic fixture']};
    await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',audience));
    return {root,result,grant};
  }
  async function publishProof(evidenceId,audience){
    const preview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId}),grant=await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',audience);
    return {...await f.proofs.publish(f.actor,grant),grant};
  }
  async function publishCapsule(source,audience){
    const payload={id:randomUUID(),capsuleId:randomUUID(),kind:'version',expectedRevision:0,version:1,title:'Compiler repair',problemPattern:'Missing dependency',
      environment:{name:'Node',version:'24'},solutionStrategy:'Inspect dependency resolution',tools:['compiler'],skills:[],mcpRefs:[],verificationMethod:'Owner result',
      limitations:['Synthetic method'],capabilityId:'compiler',applicableScope:'Node',license:'MIT',contributors:[],sourceResolution:{caseId:source.root.id,resultId:source.result.id,proofIds:[]},redactionConfirmed:true};
    const grant=await f.authorize(payload,'capsule.publish',audience);await f.capsules.publish(f.actor,grant);return {...payload,grant};
  }
  let api,sessions;
  try{
    const visible=await createCase('Public compiler case',pub),privateSource=await createCase('Private unreleased design',{});
    const evidence={id:randomUUID(),caseId:privateSource.root.id,resultId:privateSource.result.id,
      source:{provider:'github-actions',owner:'fixture',repository:'typed-'+privateSource.root.id.slice(0,8),runId:917,attempt:1,commit:'b'.repeat(40)}};
    const evidenceGrant=await f.authorize(evidence,'evidence.submit');await f.evidence.submit(f.actor,evidenceGrant);
    await worker.processNext((source,now)=>inspectGithubRun(source,{id:source.runId,run_attempt:1,head_sha:source.commit,repository:{full_name:`${source.owner}/${source.repository}`,private:false,id:123},
      updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
    const proof1=await publishProof(evidence.id,pub),proof2=await publishProof(evidence.id,pub),privateProof=await publishProof(evidence.id,{});
    const cap1=await publishCapsule(privateSource,pub),cap2=await publishCapsule(privateSource,pub);
    api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${api.address().port}`;
    const request=(input,credential)=>fetch(origin+'/v1/search/query',{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(input)});
    sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
    sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+600,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
    const client=createSearchClient({endpoint,sessions,send:async(url,input)=>{assert.equal(url,endpoint+'/v1/search/query');const response=await request(JSON.parse(input.bodyJson),input.credential);assert.equal(response.status,200);return response.json();}});
    const query=(type,input={},actor=null)=>f.search.query(actor,{type,query:{[type==='capsule'?'authorId':'subjectId']:f.actor.subjectId,...input}});
    const casePage=await query('case'),historyPage=await query('history');
    assert.deepEqual(casePage.items.map(i=>i.id),[visible.root.id]);assert.deepEqual(historyPage.items.map(i=>i.id),[visible.root.id]);
    assert.equal(casePage.items[0].source.kind,'case');assert.equal(historyPage.items[0].source.kind,'history');
    assert.equal(historyPage.items[0].source.projectionRule.version,4);assert.equal(casePage.items[0].source.sourceVersion,3);
    assert.ok(!JSON.stringify(casePage).includes(privateSource.root.title));
    const publicProofs=await query('proof',{query:evidence.source.repository,conclusion:'success',limit:1});
    const ordered=[proof1.proofId,proof2.proofId].sort((a,b)=>a.localeCompare(b));
    assert.deepEqual(publicProofs.items.map(i=>i.id),ordered.slice(0,1));assert.equal(publicProofs.nextCursor,ordered[0]);
    const last=await query('proof',{query:evidence.source.repository,after:publicProofs.nextCursor,limit:1});
    assert.deepEqual(last.items.map(i=>i.id),ordered.slice(1));assert.equal(last.nextCursor,null);
    assert.equal(publicProofs.pageCount,1);assert.equal(publicProofs.countsScope,'visible-page-only');
    assert.equal(publicProofs.items[0].record.assertion.source.commit,evidence.source.commit);
    assert.equal(publicProofs.items[0].source.evidenceId,evidence.id);assert.equal(publicProofs.items[0].capabilityVerified,false);
    assert.ok(publicProofs.items[0].matchReasons[0].includes('repository'));assert.ok(!JSON.stringify(publicProofs).includes(privateSource.root.id));
    assert.equal((await query('proof',{conclusion:'failure'})).items.length,0);
    assert.ok((await query('proof',{},f.actor)).items.some(i=>i.id===privateProof.proofId));
    for(const type of ['case','history','proof','capsule']){
      const input={type,query:{[type==='capsule'?'authorId':'subjectId']:f.actor.subjectId,limit:8}};
      const response=await request(input);assert.equal(response.status,200);assert.deepEqual(await response.json(),await f.search.query(null,input));
      const page=await client.query(input);assert.equal(page.source,'endpoint-reported');assert.equal(page.type,type);assert.ok(page.items.length);
    }
    const capPage=await query('capsule',{query:'repair',capabilityId:'compiler',limit:1});
    const orderedCapsules=[cap1.capsuleId,cap2.capsuleId].sort((a,b)=>a.localeCompare(b));assert.equal(capPage.items[0].id,orderedCapsules[0]);
    assert.equal(capPage.items[0].source.version,1);assert.equal(capPage.nextCursor,orderedCapsules[0]);
    const capLast=await query('capsule',{after:capPage.nextCursor,limit:1});assert.equal(capLast.items[0].id,orderedCapsules[1]);assert.equal(capLast.nextCursor,null);
    const before=JSON.stringify(await query('capsule'));
    await publishCapsule(privateSource,{});assert.equal(JSON.stringify(await query('capsule')),before);
    assert.equal((await request({type:'proof',query:{}},outsider.credential)).status,401);
    assert.equal((await request({type:'case',query:{}},'invalid')).status,401);
    assert.equal((await request({type:'proof',query:{limit:21}})).status,400);
    assert.equal((await request({type:'proof',query:{offset:10000}})).status,400);
    await f.consents.revoke(f.actor,proof1.grant.consentId);
    assert.deepEqual((await query('proof')).items.map(i=>i.id),[proof2.proofId]);
    await f.consents.revoke(f.actor,evidenceGrant.consentId);assert.equal((await query('proof')).items.length,0);
    await f.consents.revoke(f.actor,privateSource.grant.consentId);assert.equal((await query('capsule')).items.length,0);
    await f.consents.revoke(f.actor,visible.grant.consentId);assert.equal((await query('case')).items.length,0);assert.equal((await query('history')).items.length,0);
  }finally{sessions?.close();if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}if(!database)await f.db.close();}
}
