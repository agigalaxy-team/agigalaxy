import test from 'node:test';
import { verifyGovernanceWorkflow } from './governance-workflow.mjs';
import { moderationReportSchema, moderationEventSchema } from '../src/shared/moderation-schema.mjs';
test('qualification and moderation run through API clients and host flows',()=>verifyGovernanceWorkflow());

test('moderation accepts all bidirectional abuse categories and bounded typed references',()=>{
  for(const category of ['malicious-artifact','data-extraction','work-fraud','false-verification']) {
    assert.equal(moderationReportSchema.parse({id:randomUUID(),assistanceId:randomUUID(),category,summary:'Reported allegation'}).category,category);
  }
  const event={id:randomUUID(),reportId:randomUUID(),expectedVersion:1,kind:'supplement',summary:'Referenced material'};
  assert.deepEqual(moderationEventSchema.parse(event).references,[]);
  assert.throws(()=>moderationEventSchema.parse({...event,references:[{kind:'artifact',sha256:'https://example.invalid/file'}]}));
  assert.throws(()=>moderationEventSchema.parse({...event,references:Array.from({length:9},()=>({kind:'proof',id:randomUUID()}))}));
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';
import { QualificationService } from '../src/qualification.mjs';
import { loadGovernanceConfig, governanceConfigSchema } from '../src/governance-config.mjs';
test('qualification counts only current policy-matched CI facts and never certifies personal ability',async()=>{
  const f=await serviceFixture(['binding','consent','case-teaser','evidence','proof','assistance']);
  try {
    const root={id:randomUUID(),kind:'case',localRef:'qualification',title:'Synthetic',summary:'Fixture',source:{kind:'local',reference:'fixture'},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'Fixture',configuration:{environment:'test',version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt));
    const result={id:randomUUID(),kind:'result',caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Claim',failureReason:'',limitations:['Synthetic']};
    await f.cases.submit(f.actor,await f.authorize(result));
    const source={provider:'github-actions',owner:'fixture',repository:'example',runId:1,attempt:1,commit:'a'.repeat(40)};
    const submission={id:randomUUID(),caseId:root.id,resultId:result.id,source};
    await f.evidence.submit(f.actor,await f.authorize(submission,'evidence.submit'));
    const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now}),{db:f.db,endpoint:f.bindings.endpoint,now:()=>f.now});
    await worker.processNext((source,now)=>inspectGithubRun(source,{id:1,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/example',private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
    const preview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:submission.id});
    const proof=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish'));
    const policy={id:'compiler-ci',version:'1',capabilityId:'compiler',title:'CI check',collaboration:'open-assistance',notBefore:f.now-1,notAfter:f.now+500,minProofs:1,minAcceptedCollaborations:0,historyWindowSeconds:86400,requireCiSuccess:true,repositories:[{owner:'fixture',repository:'example'}]};
    const qualification=new QualificationService(f.access,f.proofs,f.assistance,[policy]);
    const query={policyId:policy.id,policyVersion:'1',capabilityId:'compiler',evidence:{proofIds:[proof.proofId],assistanceIds:[]}};
    assert.equal((await qualification.evaluate(f.actor,query)).eligible,true);
    assert.equal((await qualification.evaluate(f.actor,query)).capabilityVerified,false);
    const again=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:submission.id});
    const repeated=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(again.payloadJson),'proof.publish'));
    const distinct=new QualificationService(f.access,f.proofs,f.assistance,[{...policy,minProofs:2}]);
    const two=await distinct.evaluate(f.actor,{...query,evidence:{proofIds:[proof.proofId,repeated.proofId],assistanceIds:[]}});
    assert.equal(two.eligible,false);assert.equal(two.proofs.length,1);assert.ok(two.proofs[0].sourceKey);assert.equal(two.evaluationRule.version,2);
    const wrongRepo=new QualificationService(f.access,f.proofs,f.assistance,[{...policy,repositories:[{owner:'other',repository:'other'}]}]);
    assert.equal((await wrongRepo.evaluate(f.actor,query)).eligible,false);
    await f.proofs.revoke(f.actor,proof.proofId);assert.equal((await qualification.evaluate(f.actor,query)).eligible,false);
    assert.throws(()=>new QualificationService(f.access,f.proofs,f.assistance,[{...policy,collaboration:'basic-bounty'}]));
    assert.deepEqual(await loadGovernanceConfig(),{auditReaderIds:[],auditReviewerIds:[],conformanceSuitePins:[],builderAssessorIds:[],honorRules:[],qualificationPolicies:[],moderatorIds:[]});
    assert.throws(()=>governanceConfigSchema.parse({moderatorIds:['not-a-galaxy-id']}));
  } finally {await f.db.close();}
});
