import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createCapsuleClient } from "../src/clients/capsule.mjs";
import { createCapsuleFlow } from "../src/clients/flows/capsule.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";
import { EvidenceService } from "../src/evidence/evidence.mjs";
import { ConsentReader } from "../src/consents/consent-reader.mjs";
import { workerReads } from '../src/infrastructure/worker-reads.mjs';
import { inspectGithubRun } from "../src/evidence/github-evidence.mjs";
export async function verifyCapsuleWorkflow(db=null,options={}) {
  const scopes=['data-export','binding','consent','case-teaser','evidence','proof','history','assistance','context','notifications','moderation','capsules'];
  const f=await serviceFixture(scopes,db,options),p=await serviceFixture(scopes,f.db,options),outsider=await serviceFixture(scopes,f.db,options);
  const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.bindings.endpoint,memories=[];
  let httpRequests=0;
  const send=async(url,input,method='POST')=>{httpRequests++;const response=await fetch(origin+new URL(url).pathname,{method,headers:{'Content-Type':'application/json',...(input.credential?{Authorization:`Bearer ${input.credential}`}:{})},...(method==='POST'?{body:input.bodyJson}:{}),signal:input.signal});const result=await response.json();if(response.status!==200)throw new Error(JSON.stringify(result));return result;};
  function host(who){const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    return createHostConnectionController({endpoint,sessions,capsuleClient:createCapsuleClient({endpoint,sessions,send}),capsuleFlow:createCapsuleFlow({endpoint,sessions,signIntent:who.signForTest,consentSend:send,capsuleSend:send,caseSend:send,caseRead:(url,input)=>send(url,input,'GET'),now:()=>f.now})});}
  const author=host(f),consumer=host(p);
  async function recordCase(who,outcome){const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Capsule fixture',summary:'Synthetic',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:who.actor.subjectId,role:'requester'}]};await f.cases.submit(who.actor,await who.authorize(root));
    const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'Synthetic',configuration:{environment:'Node',version:'24',tools:['compiler']}};await f.cases.submit(who.actor,await who.authorize(attempt));
    const result={id:randomUUID(),kind:'result',caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome,summary:'Synthetic outcome',failureReason:outcome==='failed'?'Did not solve':'',limitations:['Fixture']};await f.cases.submit(who.actor,await who.authorize(result));return {root,attempt,result};}
  async function execute(host,input){const preview=await host.prepareCapsule(input);const receipt=await host.executeCapsule(preview,preview.confirmation);return {preview,receipt};}
  try {
    const source=await recordCase(f,'succeeded'),failed=await recordCase(p,'failed'),success=await recordCase(p,'succeeded');
    const draft={kind:'version',title:'Compiler repair',problemPattern:'Missing package',environment:{name:'Node',version:'24'},solutionStrategy:'Check dependency resolution',tools:['compiler'],skills:[],mcpRefs:[],verificationMethod:'Author result plus separate CI facts when provided',limitations:['Synthetic only'],capabilityId:'compiler',applicableScope:'Node package resolution',license:'MIT',contributors:[p.actor.subjectId],sourceResolution:{caseId:source.root.id,resultId:source.result.id,proofIds:[]},redactionConfirmed:true,visibility:'Public',viewers:[]};
    const canceled=await author.prepareCapsule(draft);author.cancel();await assert.rejects(author.executeCapsule(canceled,canceled.confirmation));assert.equal((await f.db.query('SELECT * FROM capsules')).rows.length,0);
    const published=await execute(author,draft),capsuleId=published.receipt.capsuleId,v1=published.receipt.eventId;
    const viewTicket=await f.dataExport.create(p.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'capsule',id:capsuleId,versionId:v1}]});
    const exportedCapsule=()=>f.dataExport.page(p.actor,{id:viewTicket.id,dataset:'authorized-views'});
    assert.deepEqual((await exportedCapsule()).items[0].view,await f.capsules.get(p.actor,{capsuleId,versionId:v1}));
    const original=await consumer.getCapsule({capsuleId});assert.equal(original.version.version,1);assert.equal(original.authorId,f.actor.subjectId);assert.equal(original.disclosure,undefined);
    assert.equal((await f.db.query('SELECT * FROM capsule_uses')).rows.length,0);
    assert.equal((await consumer.queryCapsules({query:'repair'})).items[0].capsuleId,capsuleId);
    const ref=await execute(consumer,{kind:'reference',capsuleId,versionId:v1,caseId:failed.root.id,note:'Consider this method',visibility:'Private',viewers:[]});
    assert.equal((await consumer.capsuleUses({capsuleId})).counts.references,1);assert.equal((await consumer.capsuleUses({capsuleId})).items[0].reuseEvidence,null);assert.equal((await author.capsuleUses({capsuleId})).items.length,0);
    assert.equal((await author.capsuleUses({capsuleId,limit:1})).nextAfter,null);
    assert.equal((await consumer.capsuleUses({capsuleId,limit:1})).nextAfter,null);
    const apply={kind:'apply',capsuleId,versionId:v1,caseId:failed.root.id,attemptId:failed.attempt.id,resultId:failed.result.id,note:'Applied dependency strategy',environmentDifference:'Different module graph',visibility:'Private',viewers:[f.actor.subjectId]};
    const failedUse=await execute(consumer,apply);assert.equal(JSON.parse(failedUse.preview.payloadJson).outcome,'failed');
    assert.equal((await author.capsuleUses({capsuleId})).counts.failed,1);
    const privateUses=await consumer.capsuleUses({capsuleId,limit:1});
    assert.equal(privateUses.items.length,1);assert.equal(privateUses.counts.references+privateUses.counts.applications,1);
    assert.ok(privateUses.nextAfter);
    const finalUse=await consumer.capsuleUses({capsuleId,limit:1,after:privateUses.nextAfter});
    assert.equal(finalUse.items.length,1);assert.equal(finalUse.nextAfter,null);
    assert.equal((await f.cases.get(p.actor,failed.root.id)).capsuleUses.items.length,2);
    const linkedHistory=await f.history.query(p.actor,{subjectId:p.actor.subjectId});
    assert.equal(linkedHistory.items.find(i=>i.caseId===failed.root.id).capsuleReuse.items.find(i=>i.kind==='apply').reuseEvidence.provenance,'case-owner-reported-application');
    const duplicate=await consumer.prepareCapsule(apply);await assert.rejects(consumer.executeCapsule(duplicate,duplicate.confirmation),/already_recorded/);
    const applied=await execute(consumer,{...apply,caseId:success.root.id,attemptId:success.attempt.id,resultId:success.result.id,visibility:'Public',viewers:[]});
    const submission={id:randomUUID(),caseId:success.root.id,resultId:success.result.id,source:{provider:'github-actions',owner:'fixture',repository:'capsule-'+capsuleId.slice(0,8),runId:1,attempt:1,commit:'a'.repeat(40)}};
    const sourceGrant=await p.authorize(submission,'evidence.submit');await f.evidence.submit(p.actor,sourceGrant);
    const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerDatabase?workerReads.readGrant:undefined}),{db:options.workerDatabase??f.db,endpoint,now:()=>f.now,readCase:options.workerDatabase?workerReads.readCase:undefined});
    await worker.processNext((source,now)=>inspectGithubRun(source,{id:1,run_attempt:1,head_sha:source.commit,repository:{full_name:`${source.owner}/${source.repository}`,private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
    const proofPreview=await f.proofs.preview(p.actor,{id:randomUUID(),evidenceId:submission.id}),proof=await f.proofs.publish(p.actor,await p.authorize(JSON.parse(proofPreview.payloadJson),'proof.publish',{visibility:'Public',purpose:'public-profile'}));
    await execute(consumer,{...apply,kind:'reverify',caseId:success.root.id,attemptId:success.attempt.id,resultId:success.result.id,priorUseId:applied.receipt.eventId,proofIds:[proof.proofId],visibility:'Public',viewers:[]});
    assert.equal((await author.capsuleUses({capsuleId})).items.find(i=>i.kind==='reverify').verification,'current-ci-facts');
    const beforeRevoke=(await f.history.query(p.actor,{subjectId:p.actor.subjectId})).items.find(item=>item.caseId===success.root.id);
    assert.ok(beforeRevoke.proofs.some(item=>item.proofId===proof.proofId));
    await f.consents.revoke(p.actor,sourceGrant.consentId);
    assert.ok(!(await f.history.query(p.actor,{subjectId:p.actor.subjectId})).items.find(item=>item.caseId===success.root.id).proofs.some(item=>item.proofId===proof.proofId));
    await f.proofs.revoke(p.actor,proof.proofId);assert.equal((await author.capsuleUses({capsuleId})).items.find(i=>i.kind==='reverify').verification,'participant-reported');
    const afterRevoke=(await f.history.query(p.actor,{subjectId:p.actor.subjectId})).items.find(item=>item.caseId===success.root.id);
    assert.ok(!afterRevoke.proofs.some(item=>item.proofId===proof.proofId));
    assert.notEqual(afterRevoke.rebuild.contentHash,beforeRevoke.rebuild.contentHash);
    assert.deepEqual(afterRevoke.results,beforeRevoke.results);
    const revised=await execute(author,{...draft,capsuleId,solutionStrategy:'Check dependency resolution and package exports'});assert.equal((await consumer.getCapsule({capsuleId})).version.version,2);
    assert.equal((await consumer.getCapsule({capsuleId,versionId:v1})).version.solutionStrategy,'Check dependency resolution');
    const inbox=await f.notifications.query(p.actor,{});assert.ok(inbox.items.some(item=>item.capsuleId===capsuleId&&item.eventKind==='version'));
    const notice=inbox.items.find(item=>item.capsuleId===capsuleId);await f.notifications.markRead(p.actor,{id:notice.id});
    const preferences=await f.notifications.preferences(p.actor);await f.notifications.save(p.actor,{expectedRevision:preferences.revision,settings:{...preferences.settings,capsules:false}});assert.ok(!(await f.notifications.query(p.actor,{})).items.some(item=>item.capsuleId));
    await execute(author,{kind:'security-issue',capsuleId,versionId:v1,summary:'Older strategy has a known issue'});
    assert.equal((await consumer.getCapsule({capsuleId,versionId:v1})).securityIssue,true);
    const blocked=await consumer.prepareCapsule({...apply,caseId:success.root.id,attemptId:success.attempt.id,resultId:success.result.id});await assert.rejects(consumer.executeCapsule(blocked,blocked.confirmation),/not_applicable/);
    await execute(author,{kind:'resolve-security',capsuleId,versionId:v1,summary:'Investigation complete'});
    await execute(author,{kind:'deprecate',capsuleId,versionId:v1,summary:'Use version 2',replacementVersionId:revised.receipt.eventId});
    const old=await consumer.getCapsule({capsuleId,versionId:v1});assert.equal(old.deprecated,true);assert.equal(old.version.version,1);
    assert.ok((await consumer.capsuleUses({capsuleId,versionId:v1})).items.some(i=>i.outcome==='failed'));
    await f.consents.revoke(p.actor,JSON.parse(ref.preview.intentJson).id);assert.equal((await consumer.capsuleUses({capsuleId})).counts.references,0);
    const privateCapsule=await execute(author,{...draft,visibility:'Private',viewers:[]});await assert.rejects(f.capsules.get(outsider.actor,{capsuleId:privateCapsule.receipt.capsuleId}),/unavailable/);
    await f.consents.revoke(f.actor,JSON.parse(published.preview.intentJson).id);await assert.rejects(consumer.getCapsule({capsuleId,versionId:v1}),/unavailable/);
    await assert.rejects(exportedCapsule(),/export_view_unavailable/);
    assert.equal((await consumer.getCapsule({capsuleId})).version.version,2);
    const audit=(await f.db.query("SELECT * FROM audit_events WHERE action LIKE 'capsule.%' AND actor IN ($1,$2)",[f.actor.subjectId,p.actor.subjectId])).rows;
    assert.ok(audit.length>=9);assert.ok(audit.every(e=>e.context_version===1&&e.scope==='capsules'));assert.ok(!JSON.stringify(audit).includes('Missing package'));
    return {httpRequests,versions:2,readingCreatesUse:false,referenceCreatesReuseEvidence:false,failedApplicationPreserved:true,
      duplicateApplicationRejected:true,newCaseApplicationRecorded:true,ciReverificationRecorded:true,revokedProofDowngraded:true,
      historicalVersionPreserved:true,revokedVersionUnavailable:true,syntheticOnly:true,realReuseVerified:false};
  }finally{author.cancel();consumer.cancel();memories.forEach(s=>s.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
