import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {qualificationDecisionV2} from '../src/domain/qualification-v2.mjs';
import {fixture,task,target,experience,review,ag,cg,xg,verifyScopedCalculationWorkflow} from './qualification-v2-workflow.mjs';
import {recordRuntimeConfig,runtimeConfigSnapshot} from '../src/operations/runtime-config-audit.mjs';

test('scoped qualification calculation needs each original author, never grants old Task reading, and revokes dynamically',()=>verifyScopedCalculationWorkflow());
test('qualification v2 bounded decision deduplicates Cases and refuses synthetic records for actual participation',()=>{
  const policy={collaboration:'basic-bounty',minAcceptedCollaborations:1,minProofs:0};
  const a={kind:'participation',id:'a',group:'case:a',usable:true,synthetic:false},b={...a,id:'b'};
  const result=qualificationDecisionV2({policy,sources:[a,b],proofs:[]});assert.equal(result.state,'satisfied');assert.equal(result.counts.distinctRelevantExperiences,1);assert.equal(result.capabilityVerified,false);
  const synthetic=qualificationDecisionV2({policy,sources:[{...a,synthetic:true}],proofs:[],includeSimulation:true});
  assert.equal(synthetic.state,'insufficient-evidence');assert.equal(synthetic.simulation.state,'satisfied');assert.equal(synthetic.simulation.grantsParticipation,false);
  assert.equal(qualificationDecisionV2({policy,sources:[a],proofs:[],effectiveRestrictions:[{kind:'task-paused'}]}).state,'not-satisfied');
});

test('external declaration, registered nonparty scope review, stable source and revocation are distinct real service operations',async()=>{
  const{f,p}=await fixture();try{
    const t=await target(f,p),e=experience(f);await f.experienceReviews.submit(f.actor,await xg(f,e,[p.actor.subjectId]));
    assert.equal((await f.experienceReviews.read(f.actor,{id:e.id})).verification,'not-reviewed-by-this-statement');
    await assert.rejects(f.experienceReviews.submit(f.actor,await xg(f,{...e,id:randomUUID(),operationId:randomUUID(),source:{...e.source,links:['https://example.org/another-link']}},[p.actor.subjectId])),/experience_stable_source_already_registered/);
    const r=review(p,e);await assert.rejects(f.experienceReviews.submit(f.actor,await xg(f,{...r,reportedBy:f.actor.subjectId})),/experience_reviewer_unavailable/);
    await assert.rejects(f.experienceReviews.submit(p.actor,await xg(p,{...r,checked:{...r.checked,attribution:false}},[f.actor.subjectId])),/experience_review_checks_incomplete/);
    await f.experienceReviews.submit(p.actor,await xg(p,r,[f.actor.subjectId]));
    const input={taskId:t.taskId,subjectId:f.actor.subjectId,evidence:{externalReviewRefs:[{id:r.id,version:1}]},includeSimulation:true};
    let q=await f.qualification.v2.evaluate(f.actor,input);assert.equal(q.state,'insufficient-evidence');assert.equal(q.simulation.state,'satisfied');
    assert.equal(q.sourceStatuses[0].reason,'synthetic-excluded');
    const read=await f.experienceReviews.read(f.actor,{id:r.id});assert.equal(read.experienceKind,'challenge');assert.equal(read.capabilityVerified,false);
    await f.experienceReviews.submit(f.actor,await xg(f,{...e,operationId:randomUUID(),expectedVersion:1,reason:'纠正来源版本',source:{...e.source,contentVersion:'2'}},[p.actor.subjectId]));
    assert.equal((await f.experienceReviews.read(f.actor,{id:r.id})).referenceStatus,'dependency-unavailable');
    q=await f.qualification.v2.evaluate(f.actor,input);assert.equal(q.simulation.state,'insufficient-evidence');
    const next={...r,operationId:randomUUID(),expectedVersion:1,reason:'核对新版本',experienceRef:{id:e.id,version:2}};await f.experienceReviews.submit(p.actor,await xg(p,next,[f.actor.subjectId]));
    assert.equal((await f.experienceReviews.read(f.actor,{id:r.id})).referenceStatus,'current');
    await f.experienceReviews.submit(f.actor,await xg(f,{id:e.id,operationId:randomUUID(),expectedVersion:2,kind:'revoke',objectType:'experience',reportedBy:f.actor.subjectId,synthetic:true,reason:'撤回来源'},[p.actor.subjectId]));
    assert.equal((await f.experienceReviews.read(f.actor,{id:r.id})).record,null);
  }finally{await f.db.close();}
});

test('actual Task participation acceptance can support only the matching scope; empty history remains open',async()=>{
  const{f,p}=await fixture();try{
    const open=task(f);await f.assistance.createTask(f.actor,await ag(f,open,[p.actor.subjectId]));
    assert.equal((await f.qualification.v2.evaluate(p.actor,{taskId:open.taskId,subjectId:p.actor.subjectId})).state,'satisfied');
    const t=await target(f,p);assert.equal((await f.qualification.v2.evaluate(f.actor,{taskId:t.taskId,subjectId:p.actor.subjectId})).state,'insufficient-evidence');
    const cid=randomUUID(),r={schemaVersion:2,kind:'case-created',eventId:cid,caseId:cid,expectedVersion:0,actorId:f.actor.subjectId,taskId:open.taskId,
      localRef:randomUUID(),title:'合成工作',summary:'只用于验收服务',source:{kind:'active-task',reference:open.taskId},synthetic:true};
    const first={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId:cid,expectedVersion:1,actorId:f.actor.subjectId,taskId:open.taskId,
      types:['diagnosis'],affectsAttemptIds:[],description:'有限诊断',sourceRefs:[],observedEffect:'已确定范围'};
    await f.cases.createAndLinkTask(f.actor,{operationId:randomUUID(),taskId:open.taskId,expectedTaskVersion:1,case:await cg(f,r,[p.actor.subjectId]),initialFact:await cg(f,first,[p.actor.subjectId])});
    const proposal={eventId:randomUUID(),kind:'propose',expectedTaskVersion:1,participationId:randomUUID(),subjectId:p.actor.subjectId,role:'diagnosis',scopeVersion:1,agreedScope:'有限诊断'};
    await f.assistance.proposeParticipation(f.actor,open.taskId,await ag(f,proposal,[p.actor.subjectId]));
    await f.assistance.submitParticipationEvent(p.actor,proposal.participationId,await ag(p,{eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1},[f.actor.subjectId]));
    const d={...first,eventId:randomUUID(),actorId:p.actor.subjectId,expectedVersion:2,participationId:proposal.participationId};await f.cases.submitV2(p.actor,await cg(p,d,[f.actor.subjectId]));
    const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId:cid,expectedVersion:3,actorId:p.actor.subjectId,taskId:open.taskId,participationId:proposal.participationId,
      scopeVersion:1,origin:{kind:'intervention',id:d.eventId,version:1},deliverableRefs:[],reportedOutcome:'partial',summary:'诊断完成，修复未完成',limitations:'仅诊断'};
    await f.cases.submitV2(p.actor,await cg(p,result,[f.actor.subjectId]));
    const delivered={eventId:randomUUID(),kind:'deliver',expectedParticipationVersion:2,resultRef:{id:result.eventId,version:1},interventionRefs:[{id:d.eventId,version:1}],evidenceRefs:[],summary:'诊断交付'};
    await f.assistance.submitParticipationEvent(p.actor,proposal.participationId,await ag(p,delivered,[f.actor.subjectId]));
    await f.assistance.submitParticipationEvent(f.actor,proposal.participationId,await ag(f,{eventId:randomUUID(),kind:'accept',expectedParticipationVersion:3,deliveryId:delivered.eventId,summary:'接受有限诊断'},[p.actor.subjectId]));
    const input={taskId:t.taskId,subjectId:p.actor.subjectId,evidence:{participationIds:[proposal.participationId]},includeSimulation:true};
    let q=await f.qualification.v2.evaluate(f.actor,input);assert.equal(q.state,'insufficient-evidence');assert.equal(q.simulation.state,'satisfied');assert.equal(q.counts.distinctRelevantExperiences,0);
    const wrong={...input,capabilityId:'security-audit'};await assert.rejects(f.qualification.v2.evaluate(f.actor,wrong),/qualification_task_policy_mismatch/);
    await f.cases.submitV2(p.actor,await cg(p,{...result,eventId:randomUUID(),expectedVersion:4,supersedes:{id:result.eventId,version:1},summary:'修正结果'},[f.actor.subjectId]));
    q=await f.qualification.v2.evaluate(f.actor,input);assert.equal(q.simulation.state,'insufficient-evidence');assert.ok(q.observations.some(x=>x.reason==='fact_version_conflict'));
  }finally{await f.db.close();}
});

test('current registered reviewer removal, nonparty rule and erased source invalidate external eligibility evidence',async()=>{
  const{f,p,policy}=await fixture();try{
    const reviewers=[...f.experienceReviews.reviewers,{...f.experienceReviews.reviewers[0],subjectId:f.actor.subjectId}];
    f.experienceReviews.reviewers=reviewers;
    const record=reviewers=>recordRuntimeConfig(f.db,{endpoint:f.access.endpoint,component:'api',experienceReviewers:reviewers,
      qualificationPolicies:[policy],snapshot:runtimeConfigSnapshot({governance:{experienceReviewers:reviewers,qualificationPolicies:[policy]}})});
    await record(reviewers);await f.experienceReviews.useRegistry();
    const e=experience(f);await f.experienceReviews.submit(f.actor,await xg(f,e,[p.actor.subjectId]));
    const self=review(f,e);await assert.rejects(f.experienceReviews.submit(f.actor,await xg(f,self)),/experience_nonparty_reviewer_required/);
    const r=review(p,e);await f.experienceReviews.submit(p.actor,await xg(p,r,[f.actor.subjectId]));
    assert.equal((await f.experienceReviews.read(f.actor,{id:r.id})).registeredRuntimeReviewer,true);
    await record([]);let out=await f.experienceReviews.read(f.actor,{id:r.id});assert.equal(out.record,null);assert.equal(out.reason,'experience_reviewer_unavailable');
    await assert.rejects(recordRuntimeConfig(f.db,{endpoint:f.access.endpoint,component:'api',qualificationPolicies:[policy],
      snapshot:runtimeConfigSnapshot({governance:{qualificationPolicies:[policy]}})}),/memory-only/);
    await record(reviewers);assert.equal((await f.experienceReviews.read(f.actor,{id:r.id})).referenceStatus,'current');
    // Exercise the reader against the exact M19 retained-row shape. This is
    // not a claim that the lifecycle worker was executed in this test.
    await f.db.query("UPDATE experience_events SET payload_text='',context='{}' WHERE object_id=$1",[e.id]);
    out=await f.experienceReviews.read(f.actor,{id:r.id});assert.equal(out.record,null);assert.equal(out.referenceStatus,'dependency-unavailable');
    await assert.rejects(f.experienceReviews.read(f.actor,{id:e.id}),/experience_unavailable/);
  }finally{await f.db.close();}
});
