import { workerReads } from '../src/infrastructure/worker-reads.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { HonorService } from '../src/honor.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHonorClient } from '../src/honor-client.mjs';
import { createHostConnectionController } from '../src/host-connection-controller.mjs';
export async function verifyHonorWorkflow(db=null,options={}) {
  const scopes=['binding','consent','case-teaser','assistance','history','evidence','proof','moderation'];
  const f=await serviceFixture(scopes,db,options),p=await serviceFixture(scopes,f.db,options),other=await serviceFixture(scopes,f.db,options);
  const rule={id:'open-helper',version:'1',title:'Open contributor',kind:'open-contributor',capabilityId:'compiler',communityId:'fixture',
    members:[f.actor.subjectId,p.actor.subjectId,other.actor.subjectId],relatedPartyGroups:[[f.actor.subjectId,p.actor.subjectId]],
    notBefore:f.now-1,notAfter:f.now+1000,windowFrom:f.now-100,windowUntil:f.now+100,minAcceptedCases:1,minProofs:0,repositories:[],rankingEnabled:false};
  const ciRule={...rule,id:'ci-helper',kind:'ci-backed-contributor',minProofs:1,repositories:[{owner:'fixture',repository:'example'}]};
  f.honor=new HonorService(f.access,f.assistance,f.proofs,[rule,ciRule]);f.moderation.moderatorIds=[other.actor.subjectId];
  const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.bindings.endpoint;
  const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  sessions.adopt({endpoint,subjectId:p.actor.subjectId,bindingId:p.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>p.credential});
  const send=async(url,input)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',...(input.credential?{Authorization:`Bearer ${input.credential}`}:{})},body:input.bodyJson,signal:input.signal});const data=await response.json();if(response.status!==200)throw new Error(JSON.stringify(data));return data;};
  const honorClient=createHonorClient({endpoint,sessions,send}),host=createHostConnectionController({endpoint,sessions,honorClient});
  const query={ruleId:rule.id,ruleVersion:'1'},ciQuery={ruleId:ciRule.id,ruleVersion:'1'};
  try {
    const publicRules=await host.honorRules();assert.equal(publicRules.rules.length,2);assert.equal(publicRules.rules[0].members,undefined);
    assert.equal((await host.getHonor(query)).card.status,'insufficient-evidence');
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Honor fixture',summary:'Synthetic',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'Diagnose',configuration:{environment:'test',version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt));
    const result={id:randomUUID(),kind:'result',caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Claim',failureReason:'',limitations:['Synthetic']};
    await f.cases.submit(f.actor,await f.authorize(result));
    const submission={id:randomUUID(),caseId:root.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'example',runId:1,attempt:1,commit:'a'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(submission,'evidence.submit'));
    // A synthetic observation is already stored in this isolated fixture; no external CI call.
    const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerDatabase?workerReads.readGrant:undefined}),{db:options.workerDatabase??f.db,endpoint,now:()=>f.now,readCase:options.workerDatabase?workerReads.readCase:undefined});
    await worker.processNext((source,now)=>inspectGithubRun(source,{id:1,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/example',private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now));
    const preview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:submission.id});
    const proof=await f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',{viewers:[p.actor.subjectId]}));
    let version,request;
    const versions=new Map();
    async function event(who,kind,fields={}){const ev={id:randomUUID(),expectedVersion:version,kind,...fields};const grant=await who.authorize({assistanceId:request.id,event:ev},'assistance.publish',{objectId:ev.id,viewers:[who===f?p.actor.subjectId:f.actor.subjectId]});const receipt=await f.assistance.submit(who.actor,request.id,grant);version=receipt.version;versions.set(request.id,version);return {ev,grant};}
    async function collaborate(){request={id:randomUUID(),caseId:root.id,title:'Compiler help',problem:'Fixture',attemptedApproaches:[],scope:'Inspect',visibility:'Public',collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
      await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));version=1;
      const offer=await event(p,'offer',{proposal:'Read logs',scope:'Inspect'});assert.equal((await host.getHonor(query)).facets.contribution.acceptedCases,versions.size>1?1:0);
      await event(f,'select',{offerId:offer.ev.id});await event(p,'confirm');const delivery=await event(p,'deliver',{attemptId:attempt.id,evidenceIds:[submission.id],summary:'Resolved'});
      await event(f,'accept',{deliveryId:delivery.ev.id,summary:'Accepted'});return request.id;
    }
    const first=await collaborate();let card=(await host.getHonor(query)).card;
    assert.equal(card.status,'active');assert.equal(card.capabilityVerified,false);assert.equal(card.acceptedCases,1);
    assert.equal((await host.getHonor(ciQuery)).card.status,'active');
    const ciSource=(await host.getHonor(ciQuery)).card.proofs[0];
    assert.equal(ciSource.sourceKey,'github-actions:repository:123:run:1:attempt:1');
    assert.equal(ciSource.independentExecutionVerified,false);assert.equal(ciSource.independence,'repository-controlled');
    assert.equal((await host.getHonor(query)).facets.contribution.relatedPartyCases,1);
    const originalId=card.id,originalFingerprint=card.sourceFingerprint;
    const second=await collaborate();card=(await host.getHonor(query)).card;assert.equal(card.acceptedCases,1);assert.equal(card.id,originalId);assert.notEqual(card.sourceFingerprint,originalFingerprint);
    const risk=(await host.getHonor(query)).riskAssessment;
    assert.equal(risk.automaticPenalty,false);assert.equal(risk.fraudDetermined,false);
    assert.ok(risk.flags.some(flag=>flag.code==='repeated-source-case'&&flag.caseIds.includes(root.id)));
    assert.ok(risk.flags.some(flag=>flag.code==='declared-related-parties'));
    assert.equal((await host.getHonor(ciQuery)).facets.capabilityEvidence.proofCount,1);
    const anonymous=await host.getPublicHonor({...query,subjectId:p.actor.subjectId});assert.equal(anonymous.contributions.length,0);assert.equal(anonymous.card.status,'insufficient-evidence');
    assert.deepEqual(anonymous.riskAssessment.flags,[]);
    const get=await fetch(origin+new URL(card.statusUrl).pathname,{headers:{Authorization:`Bearer ${p.credential}`}});assert.equal(get.status,200);assert.equal((await get.json()).card.id,originalId);
    assert.equal((await host.honorRanking(query)).reason,'ranking-not-approved');
    const rankingRule=f.honor.rules.get('open-helper@1');rankingRule.rankingEnabled=true;rankingRule.privacyReview='approved';rankingRule.windowUntil=f.now-1;
    assert.equal((await host.honorRanking(query)).reason,'insufficient-public-cohort');rankingRule.windowUntil=f.now+100;
    // Current CI revocation removes only the stronger rule, retaining real participation.
    await f.proofs.revoke(f.actor,proof.proofId);const proofRevokedAt=performance.now();
    assert.equal((await host.getHonor(ciQuery)).card.status,'insufficient-evidence');
    options.onRevocationCheck?.({surface:'honor-ci-proof',afterCommitObservedMs:performance.now()-proofRevokedAt,passed:true});
    assert.equal((await host.getHonor(query)).card.status,'active');
    // A dispute stays in visible history and removes that contribution from active evidence.
    request.id=first;version=versions.get(first);await event(p,'dispute',{reason:'Regression'});
    const view=await host.getHonor(query);assert.equal(view.facets.collaborationReliability.disputed,1);assert.equal(view.card.acceptedCases,1);
    assert.ok(view.riskAssessment.flags.some(flag=>flag.code==='accepted-work-under-review'&&flag.assistanceIds.includes(first)));
    request.id=second;version=versions.get(second);await event(p,'dispute',{reason:'Second regression'});assert.equal((await host.getHonor(query)).card.status,'insufficient-evidence');
    rankingRule.revoked=true;assert.equal((await host.getHonor(query)).card.status,'inactive-rule');rankingRule.revoked=false;
    const correction={kind:'revision',id:randomUUID(),caseId:root.id,expectedVersion:3,correctsEventId:result.id,reason:'Changed result',summary:'Correction'};
    const correctedGrant=await f.authorize(correction,'case.teaser.publish',{viewers:[p.actor.subjectId]});await f.cases.submit(f.actor,correctedGrant);
    assert.ok((await host.getHonor(query)).contributions.every(c=>c.corrected));
    await f.consents.revoke(f.actor,correctedGrant.consentId);const ancestorRevokedAt=performance.now();
    assert.equal((await host.getHonor(query)).contributions.length,0);
    options.onRevocationCheck?.({surface:'honor-case-ancestor',afterCommitObservedMs:performance.now()-ancestorRevokedAt,passed:true});
    assert.deepEqual((await host.getHonor(query)).riskAssessment.flags,[]);
    const outside=await serviceFixture(scopes,f.db,options);await assert.rejects(f.honor.query(outside.actor,{...query,subjectId:outside.actor.subjectId}),/outside_scope/);
    assert.throws(()=>new HonorService(f.access,f.assistance,f.proofs,[{...rule,rankingEnabled:true,privacyReview:'pending'}]));
    assert.throws(()=>new HonorService(f.access,f.assistance,f.proofs,[{...rule,kind:'ci-backed-contributor'}]));
  }finally{host.cancel();sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
