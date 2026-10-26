import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createApi } from '../src/http.mjs';
import { createBuilderClient } from "../src/clients/builder.mjs";
import { createBuilderFlow } from "../src/clients/flows/builder.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { EvidenceService } from "../src/evidence/evidence.mjs";
import { ConsentReader } from "../src/consents/consent-reader.mjs";
import { workerReads } from '../src/infrastructure/worker-reads.mjs';
import { inspectGithubRun } from "../src/evidence/github-evidence.mjs";

export async function verifyBuilderWorkEvidence(db=null,options={}){
  const scopes=['binding','consent','builders','case-teaser','evidence','proof','data-export'];
  const f=await serviceFixture(scopes,db,options),node=await serviceFixture(scopes,f.db,options),other=await serviceFixture(scopes,f.db,options);
  const endpoint=f.bindings.endpoint,memories=[],publicGrant={visibility:'Public',purpose:'public-profile'};
  const api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`;
  const send=async(url,input)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const value=await response.json();if(response.status!==200)throw new Error(JSON.stringify(value));return value;};
  function host(who){const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    const flow=createBuilderFlow({endpoint,sessions,signIntent:who.signForTest,builderSend:send,consentSend:send,now:()=>f.now});
    return {flow,client:createBuilderClient({endpoint,sessions,send}),async execute(input){const preview=await flow.prepare(input);return {preview,receipt:await flow.execute(preview,preview.confirmation)};}};
  }
  const owner=host(f),holder=host(node);
  const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerDatabase?workerReads.readGrant:undefined}),
    {db:options.workerDatabase??f.db,endpoint,now:()=>f.now,readCase:options.workerDatabase?workerReads.readCase:undefined});
  async function sources(disclosure){
    const source={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Node CI association fixture',summary:'Synthetic controlled source',
      source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    const rootGrant=await f.authorize(source,'case.teaser.publish',disclosure);await f.cases.submit(f.actor,rootGrant);
    const attempt={id:randomUUID(),kind:'attempt',caseId:source.id,expectedVersion:1,sequence:1,approach:'Fixture',configuration:{environment:'Node',version:'24',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt,'case.teaser.publish',disclosure));
    const result={id:randomUUID(),kind:'result',caseId:source.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Fixture',failureReason:'',limitations:['Synthetic']};
    await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',disclosure));
    const submission={id:randomUUID(),caseId:source.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'node-'+source.id,runId:1,attempt:1,commit:'a'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(submission,'evidence.submit',disclosure));
    await worker.processNext((input,now)=>inspectGithubRun(input,{id:1,run_attempt:1,head_sha:input.commit,
      repository:{full_name:`${input.owner}/${input.repository}`,private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
    const preview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:submission.id});
    const proof=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',disclosure));
    return {rootGrant,proofId:proof.proofId,input:{caseId:source.id,attemptId:attempt.id,resultId:result.id,proofIds:[proof.proofId],summary:'Node attests association; execution attribution remains unverified'}};
  }
  try{
    const publicSource=await sources(publicGrant),privateSource=await sources({viewers:[node.actor.subjectId]});
    const declaration=builderDeclaration('worker',node.actor.subjectId);
    const created=await owner.execute({kind:'declare',declaration,visibility:'Public'}),builderId=created.receipt.builderId;
    const input={kind:'work-evidence',builderId,...publicSource.input,task:{protocol:'a2a/1.0',endpoint:'https://agent.example/a2a',taskId:'declared-task'}};
    await assert.rejects(holder.flow.prepare(input)); // No active Node control ID yet.
    await holder.execute({kind:'node-control',builderId,expiresAt:f.now+100});
    await assert.rejects(owner.flow.prepare(input),/required/);
    const current=await holder.client.get({builderId});
    const forged={...input,id:randomUUID(),expectedRevision:current.revision,declarationId:current.declarationId,declarationHash:current.declarationHash,
      controlId:current.nodeControl.controlId,nodeId:node.actor.subjectId};
    await assert.rejects(f.builders.publish(other.actor,await other.authorize(forged,'builder.publish',publicGrant)),/node_holder_required/);
    await assert.rejects(holder.execute({...input,attemptId:publicSource.input.resultId}),/source_mismatch/);
    await assert.rejects(holder.execute({...input,proofIds:[privateSource.proofId]}),/source_mismatch/);
    await assert.rejects(holder.execute({...input,...privateSource.input}),/source_unavailable/);
    const canceled=await holder.flow.prepare(input);holder.flow.cancel(canceled);await assert.rejects(holder.flow.execute(canceled,canceled.confirmation));
    assert.equal((await owner.client.get({builderId})).evidence.state,'none-current');
    const first=await holder.execute(input),read=()=>f.builders.get(null,{builderId});
    const view=await read(),work=view.evidence.nodeWorkEvidence;
    assert.equal(view.evidence.state,'node-attested-ci-evidence');assert.equal(work.currentCount,1);
    assert.equal(work.items[0].nodeId,node.actor.subjectId);assert.equal(work.items[0].source.caseId,publicSource.input.caseId);
    assert.equal(work.items[0].source.proofs[0].verification,'ci-execution-fact');assert.equal(work.items[0].source.outcomeAuthority,'case-owner-reported');
    assert.equal(work.items[0].executionAttributionVerified,false);assert.equal(work.items[0].capabilityVerified,false);
    assert.equal(work.items[0].task.authority,'node-declared-task-reference');assert.equal(work.items[0].task.endpointProbed,false);
    assert.equal(view.reachability.endpointReachable,null);assert.equal(view.compatibility.state,'unverified');
    assert.deepEqual(await f.builders.publish(node.actor,{consentId:JSON.parse(first.preview.intentJson).id,payloadJson:first.preview.payloadJson}),first.receipt);
    assert.equal((await f.builders.query(null,{ownerId:f.actor.subjectId})).items[0].evidence,'node-attested-ci-evidence');
    const ticket=await f.dataExport.create(other.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'builder',id:builderId}]});
    assert.deepEqual((await f.dataExport.page(other.actor,{id:ticket.id,dataset:'authorized-views'})).items[0].view.evidence,view.evidence);
    f.access.now=()=>f.now+101;assert.equal((await read()).evidence.nodeWorkEvidence.items[0].state,'node-authorization-unavailable');f.access.now=()=>f.now;

    const second=await holder.execute({...input,summary:'Revised association'});
    assert.equal((await read()).evidence.nodeWorkEvidence.currentCount,1);
    await f.consents.revoke(node.actor,JSON.parse(second.preview.intentJson).id);
    const superseded=(await read()).evidence.nodeWorkEvidence;assert.equal(superseded.currentCount,0);assert.equal(superseded.items[0].state,'superseded');
    assert.equal(superseded.items[0].source,undefined); // Never revive the older association.
    const third=await holder.execute(input);
    const revoke=await owner.execute({kind:'work-evidence-revoke',builderId,workEventId:third.receipt.eventId,reason:'Owner withdraws this association'});
    await f.consents.revoke(f.actor,JSON.parse(revoke.preview.intentJson).id);
    assert.equal((await read()).evidence.nodeWorkEvidence.items.find(item=>item.eventId===third.receipt.eventId).state,'revoked');
    const fourth=await holder.execute(input);
    await holder.execute({kind:'node-control-revoke',builderId,reason:'Node changes authorization'});
    assert.equal((await read()).evidence.nodeWorkEvidence.currentCount,0);
    await holder.execute({kind:'node-control',builderId});
    assert.equal((await read()).evidence.nodeWorkEvidence.items.find(item=>item.eventId===fourth.receipt.eventId).state,'node-authorization-unavailable');
    const fifth=await holder.execute(input);
    await f.proofs.revoke(f.actor,publicSource.proofId);
    const invalid=(await read()).evidence.nodeWorkEvidence.items.find(item=>item.eventId===fifth.receipt.eventId);
    assert.equal(invalid.state,'source-unavailable');assert.equal(invalid.source,undefined);assert.equal(invalid.summary,undefined);assert.equal(invalid.task,undefined);
    assert.equal((await f.dataExport.page(other.actor,{id:ticket.id,dataset:'authorized-views'})).items[0].view.evidence.state,'none-current');
    await holder.execute({kind:'work-evidence-revoke',builderId,workEventId:fifth.receipt.eventId,reason:'Proof no longer valid'});

    const privateEntry=await owner.execute({kind:'declare',declaration,viewers:[node.actor.subjectId]}),privateId=privateEntry.receipt.builderId;
    await holder.execute({kind:'node-control',builderId:privateId});
    const privateLink=await holder.execute({kind:'work-evidence',builderId:privateId,...privateSource.input});
    assert.deepEqual(JSON.parse(privateLink.preview.intentJson).viewers,[f.actor.subjectId]);
    assert.equal((await owner.client.get({builderId:privateId})).evidence.nodeWorkEvidence.currentCount,1);
    await assert.rejects(f.builders.get(other.actor,{builderId:privateId}),/unavailable/);
    await owner.execute({kind:'declare',builderId:privateId,declaration:{...declaration,name:'Changed Node declaration'},viewers:[node.actor.subjectId]});
    assert.equal((await owner.client.get({builderId:privateId})).evidence.nodeWorkEvidence.items[0].state,'stale-declaration');
    await holder.execute({kind:'node-control',builderId:privateId});
    await holder.execute({kind:'work-evidence',builderId:privateId,...privateSource.input});
    await f.consents.revoke(f.actor,privateSource.rootGrant.consentId);
    const unavailable=await holder.client.get({builderId:privateId});assert.equal(unavailable.evidence.nodeWorkEvidence.currentCount,0);
    assert.ok(unavailable.evidence.nodeWorkEvidence.items.every(item=>!item.source));
    const audits=(await f.db.query("SELECT * FROM audit_events WHERE action='builder.event' AND actor=$1",[node.actor.subjectId])).rows;
    assert.ok(audits.length>=10);assert.ok(audits.every(row=>row.context_version===1&&row.scope==='builders'));
  }finally{f.access.now=()=>f.now;memories.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
