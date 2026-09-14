import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';
import { QualificationService } from '../src/qualification.mjs';
import { HonorService } from '../src/honor.mjs';
import { createApi } from '../src/http.mjs';
import { operationalSnapshot } from '../src/infrastructure/operational-snapshot.mjs';

export async function verifyEvidenceRevalidation(db=null,options={}){
  const scopes=['binding','consent','case-teaser','evidence','proof','history','moderation','assistance','data-export'];
  const f=await serviceFixture(scopes,db,options),p=await serviceFixture(scopes,f.db,options),m=await serviceFixture(scopes,f.db,options);
  f.moderation.moderatorIds=[m.actor.subjectId];
  const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerReads?.readGrant}),
    {db:options.workerDb??f.db,endpoint:f.bindings.endpoint,now:()=>f.now,readCase:options.workerReads?.readCase});
  const pub={visibility:'Public',purpose:'public-profile'};
  const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Revalidation fixture',summary:'A reported outcome',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
  let api;
  try{
    api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const profile=async()=>{
      const response=await fetch('http://127.0.0.1:'+api.address().port+'/v1/profiles/'+f.actor.subjectId);
      assert.equal(response.status,200);return (await response.json()).items.find(item=>item.caseId===root.id);
    };
    const proofSearch=()=>f.search.query(null,{type:'proof',query:{subjectId:f.actor.subjectId}});
    await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',pub));
    const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'Run build',configuration:{environment:'fixture',version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt,'case.teaser.publish',pub));
    const result={kind:'result',id:randomUUID(),caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Original claim',failureReason:'',limitations:['Synthetic']};
    await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',pub));
    const evidence={id:randomUUID(),caseId:root.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'example',runId:1,attempt:1,commit:'a'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(evidence,'evidence.submit',pub));
    const verify=conclusion=>(source,now)=>inspectGithubRun(source,{id:1,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/example',private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion},now);
    assert.equal((await worker.processNext(verify('success'))).state,'observed');
    const publish=async()=>{const preview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:evidence.id});return f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',pub));};
    const proof=await publish();
    assert.equal((await profile()).proofs.length,1);
    assert.deepEqual((await proofSearch()).items.map(item=>item.id),[proof.proofId]);
    const request={id:randomUUID(),caseId:root.id,title:'Revalidation collaboration',problem:'Check CI',attemptedApproaches:[],scope:'Inspect',visibility:'Public',collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
    await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',pub));let version=1;
    const collaborate=async(who,kind,fields={})=>{const event={id:randomUUID(),expectedVersion:version,kind,...fields};
      const grant=await who.authorize({assistanceId:request.id,event},'assistance.publish',{objectId:event.id,viewers:[who===f?p.actor.subjectId:f.actor.subjectId]});
      version=(await f.assistance.submit(who.actor,request.id,grant)).version;return event;};
    const offer=await collaborate(p,'offer',{proposal:'Inspect CI',scope:'Inspect'});await collaborate(f,'select',{offerId:offer.id});await collaborate(p,'confirm');
    const delivery=await collaborate(p,'deliver',{attemptId:attempt.id,evidenceIds:[evidence.id],summary:'Reviewed'});await collaborate(f,'accept',{deliveryId:delivery.id,summary:'Accepted'});
    const honorRule={id:'revalidation-honor',version:'1',title:'CI-backed contribution',kind:'ci-backed-contributor',capabilityId:'compiler',communityId:'fixture',members:[f.actor.subjectId,p.actor.subjectId],notBefore:f.now-1,notAfter:f.now+1000,windowFrom:f.now-100,windowUntil:f.now+100,minAcceptedCases:1,minProofs:1,repositories:[{owner:'fixture',repository:'example'}]};
    const honor=new HonorService(f.access,f.assistance,f.proofs,[honorRule]);
    const card=()=>honor.query(p.actor,{ruleId:honorRule.id,ruleVersion:'1',subjectId:p.actor.subjectId});
    assert.equal((await card()).card.status,'active');
    const policy={id:'revalidation-ci',version:'1',capabilityId:'compiler',title:'CI participation',collaboration:'open-assistance',notBefore:f.now-1,notAfter:f.now+500,minProofs:1,minAcceptedCollaborations:0,historyWindowSeconds:86400,requireCiSuccess:true,repositories:[{owner:'fixture',repository:'example'}]};
    const qualification=new QualificationService(f.access,f.proofs,f.assistance,[policy]);
    const eligible=id=>qualification.evaluate(f.actor,{policyId:policy.id,policyVersion:policy.version,capabilityId:'compiler',evidence:{proofIds:[id],assistanceIds:[]}});
    assert.equal((await eligible(proof.proofId)).eligible,true);
    const history=async actor=>(await f.history.query(actor,{subjectId:f.actor.subjectId})).items.find(item=>item.caseId===root.id);
    const before=(await history(null)).rebuild.contentHash;
    const report={id:randomUUID(),caseId:root.id,caseVersion:3,targetEventId:result.id,evidenceId:evidence.id,category:'false-verification',summary:'Please independently recheck this source'};
    await f.moderation.report(p.actor,await p.authorize(report,'moderation.publish',{viewers:[m.actor.subjectId]}));
    assert.equal((await history(null)).rebuild.contentHash,before); // Private allegation cannot affect public fingerprint.
    assert.equal((await history(f.actor)).moderationContext.items[0].report,null);
    const issue=async(who,kind,extra={})=>{
      const row=await f.moderation.get(who.actor,report.id);
      const event={id:randomUUID(),reportId:report.id,expectedVersion:row.version,kind,summary:'Explicit process action',...extra};
      const grant=await who.authorize(event,'moderation.publish',{viewers:who===m?[f.actor.subjectId,p.actor.subjectId]:[m.actor.subjectId]});
      const receipt=await f.moderation.event(who.actor,report.id,grant);return {event,grant,receipt};
    };
    await assert.rejects(issue(f,'revalidate',{evidenceId:evidence.id}),/moderation_role_denied/);
    await issue(m,'pause');assert.equal((await eligible(proof.proofId)).eligible,false);
    assert.equal((await card()).card.status,'insufficient-evidence');
    assert.equal((await f.proofs.get(f.actor,proof.proofId)).signed,proof.signed);
    await issue(m,'resume');assert.equal((await eligible(proof.proofId)).eligible,true);
    assert.equal((await card()).card.status,'active');
    const first=await issue(m,'revalidate',{evidenceId:evidence.id});
    const replay=await f.moderation.event(m.actor,report.id,first.grant);assert.equal(replay.version,first.receipt.version);
    await assert.rejects(issue(m,'revalidate',{evidenceId:evidence.id}),/verification_already_pending/);
    assert.equal((await f.evidence.get(f.actor,evidence.id)).state,'revalidating');
    await assert.rejects(f.proofs.get(f.actor,proof.proofId),/not_found/);
    assert.equal((await eligible(proof.proofId)).eligible,false);
    assert.equal((await card()).card.status,'insufficient-evidence');
    assert.equal((await history(f.actor)).proofs.length,0);
    assert.equal((await profile()).proofs.length,0);
    assert.equal((await proofSearch()).items.length,0);
    assert.equal((await history(f.actor)).moderationContext.items[0].revalidation,null); // Reporter-only report context stays private.
    assert.equal((await history(m.actor)).moderationContext.items[0].revalidation.state,'pending');
    // Revoked command does not collect source data or overwrite old observations.
    await f.consents.revoke(m.actor,first.grant.consentId);let collected=0;
    const commandRevokedAt=performance.now();
    if(options.onRevocationCheck){const snapshot=await operationalSnapshot(f.db,f.now*1000);assert.equal(snapshot.revoked_jobs,0);assert.equal(snapshot.dependent_revoked_jobs,1);}
    assert.equal((await worker.processNext(()=>{collected++;throw new Error('Should not collect');})).state,'revoked');
    options.onRevocationCheck?.({surface:'revalidation-command-worker',afterCommitObservedMs:performance.now()-commandRevokedAt,passed:true});
    assert.equal(collected,0);assert.equal((await f.evidence.get(f.actor,evidence.id)).observations.length,2);
    const corrected=await issue(m,'revalidate',{evidenceId:evidence.id});
    assert.equal((await worker.processNext(verify('failure'))).state,'observed');
    const read=await f.evidence.get(f.actor,evidence.id);
    assert.equal(read.verificationGeneration,2);assert.equal(read.observations[0].conclusion,'failure');assert.equal(read.observations[2].conclusion,'success');
    await assert.rejects(f.proofs.get(f.actor,proof.proofId),/not_found/);
    const newProof=await publish();assert.equal((await eligible(newProof.proofId)).eligible,false);
    const correctedHonor=await card();
    const signal=correctedHonor.riskAssessment.flags.find(flag=>flag.code==='accepted-work-ci-not-successful');
    assert.ok(signal);assert.equal(signal.taskFailureDetermined,false);assert.ok(signal.evidenceIds.includes(evidence.id));
    assert.equal(correctedHonor.card.acceptedCases,1);assert.equal(correctedHonor.facets.capabilityEvidence.proofCount,0);
    assert.equal((await profile()).proofs.length,1);
    assert.deepEqual((await proofSearch()).items.map(item=>[item.id,item.summary]),[[newProof.proofId,'failure']]);
    assert.equal((await f.search.query(null,{type:'proof',query:{subjectId:f.actor.subjectId,conclusion:'success'}})).items.length,0);
    assert.equal((await card()).card.status,'insufficient-evidence');
    await issue(m,'resolve',{verdict:'upheld'});await issue(f,'appeal');await issue(m,'resolve',{verdict:'dismissed'});
    const view=await f.proofs.get(f.actor,newProof.proofId);
    assert.deepEqual(view.moderationContext.items[0].events.filter(event=>event.kind==='resolve').map(event=>event.verdict),['upheld','dismissed']);
    const ownerHistory=await history(f.actor);
    assert.equal(ownerHistory.rebuild.rule.version,4);assert.equal(ownerHistory.results[0].summary,'Original claim');
    assert.equal(ownerHistory.moderationContext.items[0].state,'resolved');
    assert.equal((await history(null)).moderationContext.items.length,0);
    assert.equal((await f.db.query('SELECT signed FROM proofs WHERE id=$1',[proof.proofId])).rows[0].signed,proof.signed);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM jobs WHERE payload->>\'evidenceId\'=$1',[evidence.id])).rows[0].count),3);
    const audit=(await f.db.query('SELECT * FROM audit_events WHERE object_id=ANY($1::text[])',[[first.event.id,corrected.event.id,evidence.id,newProof.proofId]])).rows;
    const jobs=(await f.db.query("SELECT id,payload FROM jobs WHERE payload->>'evidenceId'=$1 AND payload ? 'revalidation'",[evidence.id])).rows;
    assert.equal(jobs.length,2);
    for(const job of jobs){
      const command=job.payload.revalidation;
      assert.ok(audit.some(row=>row.action==='moderation.event'&&row.object_id===command.eventId&&row.consent_id===command.consentId&&row.caller_binding_id===m.actor.bindingId));
      assert.ok(audit.some(row=>row.action==='evidence.observe'&&row.object_id===evidence.id&&row.request_id===job.id&&row.idempotency_key===job.id+':1'));
    }
    assert.ok(audit.some(row=>row.action==='proof.publish'&&row.object_id===newProof.proofId));
    for(const value of [f.credential,m.credential,f.actor.credentialHash,m.actor.credentialHash])assert.ok(!JSON.stringify(audit).includes(value));
  }finally{if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}if(!db)await f.db.close();}
}
