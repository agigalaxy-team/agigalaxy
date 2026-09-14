import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { QualificationService } from '../src/qualification.mjs';
import { recordRuntimeConfig,runtimeConfigSnapshot,exportRuntimeConfigPage } from '../src/operations/runtime-config-audit.mjs';

export async function verifyQualificationPolicyRegistry(database=null,options={}){
  const f=await serviceFixture(['binding','consent','case-teaser','assistance'],database,options),endpoint=f.bindings.endpoint;
  const policy={id:'fixture-participation',version:'1',capabilityId:'compiler',title:'Synthetic eligibility policy',collaboration:'open-assistance',
    notBefore:f.now-1,notAfter:f.now+500,minProofs:0,minAcceptedCollaborations:0,historyWindowSeconds:86400,requireCiSuccess:true,repositories:[{owner:'fixture',repository:'example'}]};
  f.qualification.policies.set(policy.id+'@1',policy);
  const record=policies=>recordRuntimeConfig(f.db,{endpoint,component:'api',qualificationPolicies:policies,snapshot:runtimeConfigSnapshot({governance:{qualificationPolicies:policies}})});
  const query={policyId:policy.id,policyVersion:'1',capabilityId:'compiler',evidence:{proofIds:[],assistanceIds:[]}};
  try{
    const first=await record([policy]);await f.qualification.useRegistry();
    const initial=await f.qualification.evaluate(f.actor,query);assert.equal(initial.eligible,true);assert.equal(initial.registeredPolicyVersion,true);
    const list=await f.qualification.list(f.actor);assert.equal(list.policies[0].definitionHash,initial.policyDefinitionHash);assert.equal(list.configurationEventId,first.id);
    await record([{...policy,repositories:[{owner:'FIXTURE',repository:'Example'},{owner:'fixture',repository:'example'}]}]);
    assert.equal((await f.qualification.evaluate(f.actor,query)).eligible,true,'case-insensitive duplicate repository spelling preserves policy meaning');
    await assert.rejects(record([{...policy,minAcceptedCollaborations:1}]),/policy version conflict/);
    await record([]);assert.deepEqual((await f.qualification.list(f.actor)).policies,[]);
    await assert.rejects(f.qualification.evaluate(f.actor,query),/policy_unavailable/);
    // A stale service cannot create new requests under a removed policy.
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Registry fixture',summary:'Source',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const request={id:randomUUID(),caseId:root.id,title:'Policy request',problem:'Fixture',attemptedApproaches:[],scope:'Inspect',visibility:'Private',collaboration:'open-assistance',
      capabilityId:policy.capabilityId,qualification:{policyId:policy.id,policyVersion:'1'},enrollmentExpiresAt:f.now+400};
    await assert.rejects(f.assistance.create(f.actor,await f.authorize(request,'assistance.publish')),/policy_unavailable/);
    await assert.rejects(record([{...policy,title:'Replacement under removed version'}]),/policy version conflict/);
    await record([policy]);assert.equal((await f.qualification.evaluate(f.actor,query)).eligible,true);
    const v2={...policy,version:'2',title:'Explicit new version'};await record([v2]);
    const restarted=new QualificationService(f.access,f.proofs,f.assistance,[v2]);await restarted.useRegistry();
    assert.equal((await restarted.evaluate(f.actor,{...query,policyVersion:'2'})).eligible,true);
    await assert.rejects(f.qualification.evaluate(f.actor,query),/policy_unavailable/);
    await assert.rejects(recordRuntimeConfig(f.db,{endpoint,component:'api',snapshot:runtimeConfigSnapshot({governance:{qualificationPolicies:[v2]}})}),/memory-only/);
    const raced=await Promise.allSettled([record([{...policy,version:'3',title:'First candidate'}]),record([{...policy,version:'3',title:'Second candidate'}])]);
    assert.equal(raced.filter(row=>row.status==='fulfilled').length,1);assert.equal(raced.filter(row=>row.status==='rejected').length,1);
    const archive=await exportRuntimeConfigPage(f.db,{endpoint,component:'api'});
    assert.ok(archive.events.some(row=>row.payload.snapshot.qualificationRegistry?.policies.some(p=>p.definitionHash===initial.policyDefinitionHash)));
    return {immutablePolicyVersions:true,removedVersionCannotBeRewritten:true,removedPolicyRejectedByStaleService:true,explicitNewVersion:true,concurrentConflict:true,operatorHistoryReused:true,newTables:0};
  }finally{if(!database)await f.db.close();}
}
