import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { HonorService } from '../src/honor.mjs';
import { createApi } from '../src/http.mjs';
import { createAssistanceFlow } from '../src/assistance-flow.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHonorClient } from '../src/honor-client.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';

export async function verifyHonorCorrection(database=null,options={}){
  const endpoint=options.endpoint??'https://correction-honor.example.org',scopes=['binding','consent','case-teaser','assistance','history','evidence','proof','moderation'];
  const setup={...options,endpoint},f=await serviceFixture(scopes,database,setup),p=await serviceFixture(scopes,f.db,setup),m=await serviceFixture(scopes,f.db,setup);
  const rule={id:'correction',version:'1',title:'Corrected contribution',kind:'open-contributor',capabilityId:'compiler',communityId:'fixture',members:[f.actor.subjectId,p.actor.subjectId],relatedPartyGroups:[[f.actor.subjectId,p.actor.subjectId]],
    notBefore:f.now-1,notAfter:f.now+1000,windowFrom:f.now-100,windowUntil:f.now+100,minAcceptedCases:1,minProofs:0,repositories:[{owner:'fixture',repository:'example'}]};
  f.honor=new HonorService(f.access,f.assistance,f.proofs,[rule,{...rule,id:'correction-ci',kind:'ci-backed-contributor',minProofs:1}]);
  f.moderation.moderatorIds=[m.actor.subjectId];
  f.qualification.policies.set('corrected-history@1',{id:'corrected-history',version:'1',capabilityId:'compiler',title:'Current accepted history',collaboration:'basic-bounty',
    notBefore:f.now-1,notAfter:f.now+1000,minProofs:0,minAcceptedCollaborations:1,historyWindowSeconds:86400,requireCiSuccess:true,repositories:[]});
  const api=createApi({...f,rateLimit:10000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
  const transport=async(url,input,method)=>{const response=await fetch(origin+new URL(url).pathname,{method,headers:{'Content-Type':'application/json',...(input.credential?{Authorization:`Bearer ${input.credential}`}:{})},...(method==='POST'?{body:input.bodyJson}:{})});
    const data=await response.json();if(response.status!==200)throw Object.assign(new Error(data.error),{status:response.status});return data;};
  const send=(url,input)=>transport(url,input,'POST'),read=(url,input)=>transport(url,input,'GET'),memories=[];
  function flow(who){const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    return createAssistanceFlow({endpoint,sessions,signIntent:who.signForTest,consentSend:send,assistanceSend:send,assistanceRead:read,now:()=>f.now});}
  const flows=new Map([[f,flow(f)],[p,flow(p)]]),client=createHonorClient({endpoint,send}),pub={visibility:'Public',purpose:'public-profile'};
  const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerReads?.readGrant}),{db:options.workerDb??f.db,endpoint,now:()=>f.now,readCase:options.workerReads?.readCase});
  const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Corrected Case',summary:'Initial summary',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
  let caseVersion=3;
  try{
    await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',pub));
    const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'Inspect',configuration:{environment:'test',version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt,'case.teaser.publish',pub));
    const result={id:randomUUID(),kind:'result',caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Reported outcome',failureReason:'',limitations:[]};
    await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',pub));
    const evidence={id:randomUUID(),caseId:root.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'example',runId:1,attempt:1,commit:'a'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(evidence,'evidence.submit',pub));
    const observe=(source,now)=>inspectGithubRun(source,{id:1,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/example',private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion:'success'},now);
    await worker.processNext(observe);
    const publish=async()=>{const preview=await f.proofs.preview(f.actor,{id:randomUUID(),evidenceId:evidence.id});return f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',pub));};
    const originalProof=await publish();
    const request={id:randomUUID(),caseId:root.id,title:'Correction work',problem:'Inspect',attemptedApproaches:[],scope:'Inspect',visibility:'Public',collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
    await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',pub));
    async function event(who,kind,extra={},visible=true){const flow=flows.get(who),preview=await flow.prepare({assistanceId:request.id,event:{kind,...extra},...(visible?{eventVisibility:'Public'}:{})});
      await flow.execute(preview,preview.confirmation);return {value:JSON.parse(preview.payloadJson).event,intent:JSON.parse(preview.intentJson)};}
    const offer=await event(p,'offer',{proposal:'Inspect',scope:'Inspect'},false);await event(f,'select',{offerId:offer.value.id},false);await event(p,'confirm');
    const deliveryInput={attemptId:attempt.id,evidenceIds:[evidence.id],summary:'Version-bound delivery'};
    const firstDelivery=await event(p,'deliver',deliveryInput);assert.equal(firstDelivery.value.caseReviewVersion,0);
    const firstAcceptance=await event(f,'accept',{deliveryId:firstDelivery.value.id,summary:'Original acceptance'});
    const eligibility=()=>f.qualification.evaluate(p.actor,{policyId:'corrected-history',policyVersion:'1',capabilityId:'compiler',evidence:{proofIds:[],assistanceIds:[request.id]}});
    assert.equal((await eligibility()).eligible,true);
    const query={ruleId:rule.id,ruleVersion:'1',subjectId:p.actor.subjectId},card=()=>client.publicQuery(query),ci=()=>client.publicQuery({...query,ruleId:'correction-ci'});
    assert.equal((await card()).card.acceptedCases,1);assert.equal((await ci()).card.status,'active');
    async function correct(publicly=true){const revision={id:randomUUID(),kind:'revision',caseId:root.id,expectedVersion:caseVersion,correctsEventId:result.id,reason:'Clarify the outcome',summary:publicly?'Updated scope and limitations':'PRIVATE CORRECTION BODY'};
      await f.cases.submit(f.actor,await f.authorize(revision,'case.teaser.publish',publicly?pub:{}));caseVersion++;return revision;}
    const correction=await correct();let view=await card();assert.equal(view.card.acceptedCases,0);assert.equal(view.contributions[0].correctionPending,true);
    assert.equal((await eligibility()).eligible,false,'old acceptance cannot satisfy qualification after a Case correction');
    assert.equal(view.contributions[0].correctionReview.state,'new-delivery-required');
    await event(p,'dispute',{reason:'Review the correction'});const proposal=await event(f,'propose-resolution',{summary:'Redo against the updated Case',outcome:'resume-work'});
    await assert.rejects(event(f,'confirm-resolution',{proposalId:proposal.value.id}),/transition_denied/);
    await event(p,'confirm-resolution',{proposalId:proposal.value.id});const current=await f.assistance.get(p.actor,request.id);
    assert.equal(current.state,'active');assert.equal(current.delivery,null);assert.equal(current.paymentExecuted,false);
    assert.equal((await card()).card.acceptedCases,0); // Agreeing to resume does not re-award the prior acceptance.
    assert.equal((await eligibility()).eligible,false);
    const stale=await flows.get(p).prepare({assistanceId:request.id,event:{kind:'deliver',...deliveryInput},eventVisibility:'Public'});
    assert.equal(JSON.parse(stale.payloadJson).event.caseReviewVersion,4);await correct();
    await assert.rejects(flows.get(p).execute(stale,stale.confirmation),/case_version_changed/);
    const nextDelivery=await event(p,'deliver',deliveryInput);assert.equal(nextDelivery.value.caseReviewVersion,5);
    await correct();await assert.rejects(event(f,'accept',{deliveryId:nextDelivery.value.id,summary:'Stale acceptance'}),/case_version_changed/);
    const finalDelivery=await event(p,'deliver',deliveryInput);assert.equal(finalDelivery.value.caseReviewVersion,6);
    const awaiting=await card();assert.equal(awaiting.card.acceptedCases,0);assert.equal(awaiting.contributions[0].correctionReview.state,'awaiting-requester-acceptance');
    const finalAcceptance=await event(f,'accept',{deliveryId:finalDelivery.value.id,summary:'Accepted after checking current Case'});
    const qualifiedAgain=await eligibility();assert.equal(qualifiedAgain.eligible,true);assert.equal(qualifiedAgain.acceptedCollaborations[0].acceptanceEventId,finalAcceptance.value.id);
    assert.equal(qualifiedAgain.acceptedCollaborations[0].deliveryEventId,finalDelivery.value.id);assert.equal(qualifiedAgain.acceptedCollaborations[0].caseReviewVersion,6);
    view=await card();assert.equal(view.card.acceptedCases,1);assert.equal(view.facets.contribution.relatedPartyCases,1);assert.equal(view.contributions[0].corrected,true);assert.equal(view.contributions[0].correctionPending,false);
    assert.equal(view.contributions[0].correctionReview.state,'participant-reaccepted');assert.equal(view.contributions[0].correctionReview.acceptanceEventId,finalAcceptance.value.id);
    assert.ok(view.riskAssessment.flags.some(flag=>flag.code==='corrected-work-reaccepted'));assert.ok(!view.riskAssessment.flags.some(flag=>flag.code==='accepted-work-under-review'));
    assert.equal(view.card.capabilityVerified,false);assert.equal(view.card.acceptedCases,1);assert.equal((await ci()).card.status,'active');
    // Actual CI recollection remains a separate existing verification flow.
    const report={id:randomUUID(),caseId:root.id,caseVersion,targetEventId:result.id,evidenceId:evidence.id,category:'false-verification',summary:'Recheck current CI'};
    await f.moderation.report(p.actor,await p.authorize(report,'moderation.publish',{viewers:[m.actor.subjectId]}));
    const revalidate={id:randomUUID(),reportId:report.id,expectedVersion:1,kind:'revalidate',evidenceId:evidence.id,summary:'Explicit independent source recollection'};
    await f.moderation.event(m.actor,report.id,await m.authorize(revalidate,'moderation.publish',{viewers:[f.actor.subjectId,p.actor.subjectId]}));
    assert.equal((await ci()).card.status,'insufficient-evidence');assert.equal((await card()).card.acceptedCases,1);
    await worker.processNext(observe);await assert.rejects(f.proofs.get(f.actor,originalProof.proofId),/not_found/);
    const newProof=await publish();assert.equal((await ci()).card.status,'active');assert.equal((await ci()).card.proofs[0].proofId,newProof.proofId);
    const privateAttempt={...attempt,id:randomUUID(),expectedVersion:caseVersion,sequence:2,approach:'PRIVATE ATTEMPT BODY'};
    await f.cases.submit(f.actor,await f.authorize(privateAttempt));caseVersion++;
    const privateView=await f.assistance.get(p.actor,request.id);assert.equal(privateView.deliverySource.reviewVersion,6);assert.ok(!JSON.stringify(privateView).includes('PRIVATE ATTEMPT BODY'));
    assert.equal((await f.assistance.get(f.actor,request.id)).deliverySource.reviewVersion,6);
    await assert.rejects(flows.get(p).prepare({assistanceId:request.id,event:{kind:'deliver',...deliveryInput,caseReviewVersion:7}}),/not visible/);
    assert.equal((await card()).card.acceptedCases,1); // A separate private attempt does not rewrite the accepted work.
    assert.equal((await eligibility()).eligible,true,'unrelated private attempts do not invalidate the current accepted correction version');
    await f.consents.revoke(f.actor,finalAcceptance.intent.id);assert.equal((await card()).card.acceptedCases,0);
    assert.equal((await eligibility()).eligible,false);
    const originalRows=(await f.db.query('SELECT id FROM assistance_events WHERE id=ANY($1::uuid[])',[[firstDelivery.value.id,firstAcceptance.value.id,finalDelivery.value.id,finalAcceptance.value.id]])).rows;assert.equal(originalRows.length,4);
    assert.equal((await f.db.query('SELECT payload FROM case_events WHERE id=$1',[correction.id])).rows[0].payload.summary,correction.summary);
    const confidential={...request,id:randomUUID()};await f.assistance.create(f.actor,await f.authorize(confidential,'assistance.publish',pub));let privateVersion=1;
    async function privateEvent(who,kind,extra={}){const event={id:randomUUID(),expectedVersion:privateVersion,kind,...extra};
      const receipt=await f.assistance.submit(who.actor,confidential.id,await who.authorize({assistanceId:confidential.id,event},'assistance.publish',{objectId:event.id,viewers:[who===f?p.actor.subjectId:f.actor.subjectId]}));privateVersion=receipt.version;return event;}
    const privateOffer=await privateEvent(p,'offer',{proposal:'Review selected corrections',scope:'Inspect'});await privateEvent(f,'select',{offerId:privateOffer.id});await privateEvent(p,'confirm');
    await correct(false);assert.equal((await f.assistance.get(p.actor,confidential.id)).deliverySource,null);
    assert.equal((await f.assistance.get(f.actor,confidential.id)).deliverySource.reviewVersion,8);
    await assert.rejects(privateEvent(p,'deliver',{...deliveryInput,caseReviewVersion:8}),/case_review_unavailable/);
    assert.ok(!JSON.stringify(await card()).includes('PRIVATE CORRECTION BODY'));
    return {versionBoundDelivery:true,caseChangeRejectsDelivery:true,caseChangeRejectsAcceptance:true,bilateralResume:true,reacceptanceRequired:true,acceptedCasesRestored:1,
      relatedPartyCountPreserved:true,oldEventsPreserved:true,evidenceRevalidationSeparate:true,oldProofNotRewritten:true,privateCaseVersionHidden:true,privateCorrectionUnavailable:true,withdrawalRemovesRestoredContribution:true,qualificationTracksCurrentAcceptance:true};
  }finally{memories.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}
