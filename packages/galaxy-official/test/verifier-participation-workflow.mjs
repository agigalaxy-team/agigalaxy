import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createModerationClient } from '../src/moderation-client.mjs';
import { createModerationFlow } from '../src/moderation-flow.mjs';

export async function verifyVerifierParticipation(database=null,options={}){
  const scopes=['binding','consent','case-teaser','assistance','history','moderation','data-export'];
  const owner=await serviceFixture(scopes,database,options),reporter=await serviceFixture(scopes,owner.db,options),
    moderator=await serviceFixture(scopes,owner.db,options),verifier=await serviceFixture(scopes,owner.db,options),outsider=await serviceFixture(scopes,owner.db,options);
  owner.moderation.moderatorIds=[moderator.actor.subjectId];
  const api=createApi({...owner,rateLimit:600}),sessions=[];
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`,endpoint=owner.access.endpoint;
  const send=async(url,input)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const data=await response.json();if(response.status!==200)throw new Error(JSON.stringify(data));return data;};
  function host(who){const memory=createSessionMemory({now:()=>owner.now,isCurrent:async()=>true});sessions.push(memory);
    memory.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:owner.now+500,bindingExpiresAt:owner.now+900,takeCredential:()=>who.credential});
    return {client:createModerationClient({endpoint,sessions:memory,send}),flow:createModerationFlow({endpoint,sessions:memory,signIntent:who.signForTest,consentSend:send,moderationSend:send,now:()=>owner.now})};}
  const r=host(reporter),m=host(moderator),v=host(verifier),o=host(outsider);
  const execute=async(client,input)=>{const preview=await client.flow.prepare(input);const receipt=await client.flow.execute(preview,preview.confirmation);return {preview,receipt,payload:JSON.parse(preview.payloadJson)};};
  async function makeReport(visibleToVerifier=true,assistanceTarget=false){
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Verifier participation fixture',summary:'A claim for review',
      source:{kind:'local',reference:randomUUID()},participants:[{subjectId:owner.actor.subjectId,role:'requester'}]};
    await owner.cases.submit(owner.actor,await owner.authorize(root,'case.teaser.publish',
      {viewers:[reporter.actor.subjectId,moderator.actor.subjectId,...(visibleToVerifier?[verifier.actor.subjectId]:[])]}));
    let target={caseId:root.id,caseVersion:1,targetEventId:root.id};
    if(assistanceTarget){const request={id:randomUUID(),caseId:root.id,title:'Assistance review',problem:'Inspect requested scope',attemptedApproaches:[],scope:'Review request',
      visibility:'Public',collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:owner.now+800};
      await owner.assistance.create(owner.actor,await owner.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));target={assistanceId:request.id};}
    return {...await execute(r,{kind:'report',...target,category:'false-verification',summary:'Reporter private concern'}),root};
  }
  const invite=(report,who=verifier)=>execute(m,{kind:'invite-verifier',reportId:report.receipt.reportId,verifierId:who.actor.subjectId,
    scope:'Review the referenced source only',expiresAt:owner.now+300,summary:'Voluntary review; no payment or source permission granted'});
  try{
    const report=await makeReport(),reportId=report.receipt.reportId;
    await assert.rejects(v.client.get(reportId),/not_found/);
    await assert.rejects(r.flow.prepare({kind:'invite-verifier',reportId,verifierId:verifier.actor.subjectId,scope:'Forge assignment',expiresAt:owner.now+300,summary:'Unauthorized'}),/not available/);
    const invitation=await invite(report);let view=await v.client.get(reportId);
    assert.equal(view.report,null);assert.equal(view.canAppeal,false);assert.equal(view.canSupplement,false);assert.equal(view.canAcceptVerifier,true);
    assert.equal(view.verifierParticipation.own.target.targetEventId,report.root.id);assert.equal(view.verifierParticipation.independenceVerified,false);
    assert.deepEqual((await v.client.query({caseId:report.root.id})).items.map(item=>item.reportId),[reportId]);
    assert.deepEqual((await o.client.query({caseId:report.root.id})).items,[]);
    await assert.rejects(o.client.get(reportId),/not_found/);
    const accepted=await execute(v,{kind:'accept-verifier',reportId,summary:'I voluntarily accept this scope'});
    view=await v.client.get(reportId);assert.equal(view.canAppeal,true);assert.equal(view.canSubmitVerification,true);assert.equal(view.canModerate,false);
    const review=await execute(v,{kind:'verification-response',reportId,summary:'Source alone is inconclusive',conclusion:'inconclusive',references:[{kind:'case',id:report.root.id}]});
    const ownerView=await owner.moderation.get(owner.actor,reportId);
    assert.equal(ownerView.events.find(event=>event.id===review.receipt.eventId).conclusion,'inconclusive');
    assert.equal((await m.client.get(reportId)).state,'open');
    await execute(v,{kind:'correct',reportId,correctsEventId:review.receipt.eventId,summary:'Clarified limitation',reason:'Did not inspect an external artifact'});
    const privateStatement=await execute(v,{kind:'supplement',reportId,summary:'Concern about requested unpaid work',references:[]});
    assert.ok(!(await owner.moderation.get(owner.actor,reportId)).events.some(event=>event.id===privateStatement.receipt.eventId));
    assert.ok((await m.client.get(reportId)).events.some(event=>event.id===privateStatement.receipt.eventId));
    // Even a later global moderator assignment cannot let a participating verifier judge their own case.
    owner.moderation.moderatorIds=[moderator.actor.subjectId,verifier.actor.subjectId];
    assert.equal((await v.client.get(reportId)).canModerate,false);
    await assert.rejects(v.flow.prepare({kind:'resolve',reportId,summary:'Self adjudication',verdict:'dismissed'}),/role required/);
    const selfDecision={kind:'resolve',id:randomUUID(),reportId,expectedVersion:(await v.client.get(reportId)).version,summary:'Bypass client check',verdict:'dismissed'};
    await assert.rejects(owner.moderation.event(verifier.actor,reportId,await verifier.authorize(selfDecision,'moderation.publish',
      {viewers:[moderator.actor.subjectId,owner.actor.subjectId,reporter.actor.subjectId]})),/moderation_role_denied/);
    owner.moderation.moderatorIds=[moderator.actor.subjectId];
    await execute(m,{kind:'resolve',reportId,summary:'Process decision',verdict:'dismissed'});
    await execute(v,{kind:'appeal',reportId,summary:'Review the labor concern'});
    await execute(m,{kind:'resolve',reportId,summary:'Reconsidered decision',verdict:'upheld'});
    await execute(v,{kind:'withdraw-verifier',reportId,summary:'I end my review participation'});
    view=await v.client.get(reportId);assert.equal(view.canSubmitVerification,false);assert.equal(view.canAppeal,true);
    await assert.rejects(v.flow.prepare({kind:'verification-response',reportId,summary:'No active assignment',conclusion:'supported',references:[]}),/not available/);
    const acceptedIntent=JSON.parse(accepted.preview.intentJson);
    const replay=await owner.moderation.event(verifier.actor,reportId,{consentId:acceptedIntent.id,payloadJson:accepted.preview.payloadJson});
    assert.equal(replay.version,accepted.receipt.version);
    const ticket=await owner.dataExport.create(verifier.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'moderation',id:reportId}]});
    const page=await owner.dataExport.page(verifier.actor,{id:ticket.id,dataset:'authorized-views',limit:20});
    assert.equal(page.items[0].view.verifierParticipation.own.status,'withdrawn');
    assert.ok(page.items[0].view.events.some(event=>event.id===review.receipt.eventId));
    await owner.consents.revoke(verifier.actor,JSON.parse(review.preview.intentJson).id);
    assert.ok(!(await m.client.get(reportId)).events.some(event=>event.id===review.receipt.eventId));
    assert.ok((await owner.db.query('SELECT payload_text FROM moderation_events WHERE id=$1',[review.receipt.eventId])).rows[0].payload_text.includes('inconclusive'));
    assert.equal((await v.client.get(reportId)).canAppeal,true);
    const audit=(await owner.db.query('SELECT * FROM audit_events WHERE object_id=ANY($1::text[])',[[invitation.receipt.eventId,accepted.receipt.eventId,review.receipt.eventId]])).rows;
    assert.equal(audit.filter(row=>row.action==='moderation.event').length,3);
    assert.ok(audit.every(row=>row.context_version===1&&row.http_request_id&&row.caller_binding_id&&row.consent_id));
    assert.ok(!JSON.stringify(audit).includes('Source alone is inconclusive'));
    const hidden=await makeReport(false);await invite(hidden);
    await execute(v,{kind:'accept-verifier',reportId:hidden.receipt.reportId,summary:'Accept participation; source still needs sharing'});
    const hiddenView=await v.client.get(hidden.receipt.reportId);assert.equal(hiddenView.source,null);assert.equal(hiddenView.canSubmitVerification,false);
    await assert.rejects(v.flow.prepare({kind:'verification-response',reportId:hidden.receipt.reportId,summary:'Cannot read',conclusion:'supported',references:[]}),/not available/);
    const bypass={kind:'verification-response',id:randomUUID(),reportId:hidden.receipt.reportId,expectedVersion:hiddenView.version,
      invitationId:hiddenView.verifierParticipation.own.invitationId,summary:'Bypass source check',conclusion:'supported',references:[]};
    await assert.rejects(owner.moderation.event(verifier.actor,bypass.reportId,await verifier.authorize(bypass,'moderation.publish',
      {viewers:[moderator.actor.subjectId,owner.actor.subjectId,reporter.actor.subjectId]})),/not_found/);
    await execute(v,{kind:'withdraw-verifier',reportId:hidden.receipt.reportId,summary:'Insufficient access; no automatic grant'});
    const revoked=await makeReport();const revokedInvitation=await invite(revoked);
    await owner.consents.revoke(moderator.actor,JSON.parse(revokedInvitation.preview.intentJson).id);
    assert.equal((await v.client.get(revoked.receipt.reportId)).canAcceptVerifier,false);
    await execute(v,{kind:'decline-verifier',reportId:revoked.receipt.reportId,summary:'Declined; invitation no longer visible'});
    const assistance=await makeReport(true,true);await invite(assistance);
    await execute(v,{kind:'accept-verifier',reportId:assistance.receipt.reportId,summary:'I will review the request scope'});
    const assistanceReview=await execute(v,{kind:'verification-response',reportId:assistance.receipt.reportId,summary:'No delivered work to certify',conclusion:'inconclusive',references:[]});
    assert.equal((await m.client.get(assistance.receipt.reportId)).events.find(event=>event.id===assistanceReview.receipt.eventId).capabilityVerified,false);
    return {voluntaryAcceptance:true,privateReportPreserved:true,sourcePermissionSeparate:true,signedReviewAndCorrection:true,
      withdrawalAndAppeal:true,noSelfAdjudication:true,originalEventsRetained:true,exportAndAudit:true,caseAndAssistance:true};
  }finally{sessions.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await owner.db.close();}
}
