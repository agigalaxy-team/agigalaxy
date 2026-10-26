import { contextScopeEvent } from '../src/shared/context-schema.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createModerationClient } from "../src/clients/moderation.mjs";
import { createModerationFlow } from "../src/clients/flows/moderation.mjs";
import { createAssistanceClient } from "../src/clients/assistance.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";
import { qualificationPolicySchema } from '../src/shared/qualification-schema.mjs';
export async function verifyGovernanceWorkflow(db=null,options={}) {
  const scopes=['data-export','binding','consent','case-teaser','assistance','context','moderation'];
  const f=await serviceFixture(scopes,db,options),p=await serviceFixture(scopes,f.db,options),m=await serviceFixture(scopes,f.db,options);
  f.moderation.moderatorIds=[m.actor.subjectId];
  const policy=qualificationPolicySchema.parse({id:'compiler-paid',version:'1',capabilityId:'compiler',title:'Related accepted history',collaboration:'basic-bounty',
    notBefore:f.now-1,notAfter:f.now+1000,minProofs:0,minAcceptedCollaborations:1,historyWindowSeconds:86400,requireCiSuccess:true,repositories:[]});
  f.qualification.policies.set('compiler-paid@1',policy);
  // This synthetic workflow compresses many user operations into one second.
  // Request-limit behavior has its own test; production defaults are unchanged.
  const api=createApi({...f,rateLimit:600}),memories=[];
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.bindings.endpoint;
  const send=async(url,input,method='POST')=>{const res=await fetch(origin+new URL(url).pathname,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},...(method==='POST'?{body:input.bodyJson}:{}),signal:input.signal});const data=await res.json();if(res.status!==200)throw new Error(JSON.stringify(data));return data;};
  function host(who){const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    return createHostConnectionController({endpoint,sessions,
      assistanceClient:createAssistanceClient({endpoint,sessions,send,read:(url,input)=>send(url,input,'GET')}),
      moderationClient:createModerationClient({endpoint,sessions,send}),
      moderationFlow:createModerationFlow({endpoint,sessions,signIntent:who.signForTest,consentSend:send,moderationSend:send,now:()=>f.now})});
  }
  const requester=host(f),provider=host(p),moderator=host(m);
  try {
    assert.equal((await provider.qualificationPolicies()).policies.length,1);
    const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Governance fixture',summary:'Synthetic',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'Diagnose',configuration:{environment:'test',version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt));
    const request={id:randomUUID(),caseId:root.id,title:'Compiler help',problem:'Fixture',attemptedApproaches:[],scope:'Inspect',visibility:'Public',collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
    await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));
    const versions=new Map([[request.id,1]]);
    async function event(who,id,kind,fields={}) {const ev={id:randomUUID(),expectedVersion:versions.get(id),kind,...fields};const grant=await who.authorize({assistanceId:id,event:ev},'assistance.publish',{objectId:ev.id,viewers:[who===f?p.actor.subjectId:f.actor.subjectId]});const receipt=await f.assistance.submit(who.actor,id,grant);versions.set(id,receipt.version);return ev;}
    const offer=await event(p,request.id,'offer',{proposal:'Read logs',scope:'Inspect'});await event(f,request.id,'select',{offerId:offer.id});await event(p,request.id,'confirm');
    const deliver=await event(p,request.id,'deliver',{attemptId:attempt.id,evidenceIds:[],summary:'Observed compiler issue'});await event(f,request.id,'accept',{deliveryId:deliver.id,summary:'Accepted'});
    const query={policyId:policy.id,policyVersion:'1',capabilityId:'compiler',evidence:{proofIds:[],assistanceIds:[request.id]}};
    const qualified=await provider.evaluateQualification(query);assert.equal(qualified.eligible,true);assert.equal(qualified.capabilityVerified,false);
    await assert.rejects(provider.evaluateQualification({...query,capabilityId:'unrelated'}),/policy_unavailable/);
    assert.equal((await requester.evaluateQualification(query)).eligible,false);
    assert.equal((await provider.evaluateQualification({...query,evidence:{proofIds:[],assistanceIds:[]}})).eligible,false);
    const duplicate={...request,id:randomUUID()};
    await f.assistance.create(f.actor,await f.authorize(duplicate,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));versions.set(duplicate.id,1);
    const duplicateOffer=await event(p,duplicate.id,'offer',{proposal:'Same source work',scope:'Inspect'});
    await event(f,duplicate.id,'select',{offerId:duplicateOffer.id});await event(p,duplicate.id,'confirm');
    const duplicateDelivery=await event(p,duplicate.id,'deliver',{attemptId:attempt.id,evidenceIds:[],summary:'Same Case'});
    await event(f,duplicate.id,'accept',{deliveryId:duplicateDelivery.id,summary:'Repeated wrapper'});
    f.qualification.policies.set('two-cases@1',{...policy,id:'two-cases',minAcceptedCollaborations:2});
    const distinct=await provider.evaluateQualification({...query,policyId:'two-cases',evidence:{proofIds:[],assistanceIds:[request.id,duplicate.id]}});
    assert.equal(distinct.eligible,false);assert.equal(distinct.acceptedCollaborations.length,1);
    assert.equal(distinct.acceptedCollaborations[0].relatedAssistanceIds.length,2);assert.equal(distinct.evaluationRule.historyCounting,'distinct-case');
    const paid={...request,id:randomUUID(),collaboration:'basic-bounty',budget:{mode:'fixed',amount:'10',unit:'USD'},qualification:{policyId:policy.id,policyVersion:'1'}};
    await f.assistance.create(f.actor,await f.authorize(paid,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));versions.set(paid.id,1);
    const paidOffer=await event(p,paid.id,'offer',{proposal:'Fix',scope:'Inspect',qualificationEvidence:query.evidence});await event(f,paid.id,'select',{offerId:paidOffer.id});
    const report=await provider.prepareModeration({kind:'report',assistanceId:request.id,category:'scope',summary:'Private report details'});
    await provider.executeModeration(report,report.confirmation);
    assert.equal((await requester.getModeration(report.reportId)).report,null);
    assert.equal((await moderator.getModeration(report.reportId)).report.summary,'Private report details');
    const participantTicket=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'moderation',id:report.reportId}]});
    assert.equal((await f.dataExport.page(f.actor,{id:participantTicket.id,dataset:'authorized-views'})).items[0].view.report,null);
    const moderatorTicket=await f.dataExport.create(m.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'moderation',id:report.reportId}]});
    const exportedModeration=()=>f.dataExport.page(m.actor,{id:moderatorTicket.id,dataset:'authorized-views'});
    assert.equal((await exportedModeration()).items[0].view.report.summary,'Private report details');

    await assert.rejects(provider.prepareModeration({kind:'pause',reportId:report.reportId,summary:'Self pause'}),/role/);
    async function action(host,kind,fields={}){const preview=await host.prepareModeration({kind,reportId:report.reportId,summary:'Synthetic decision',...fields});return host.executeModeration(preview,preview.confirmation);}
    await action(moderator,'pause');assert.equal((await f.assistance.get(p.actor,request.id)).paused,true);
    assert.equal((await provider.evaluateQualification(query)).eligible,false);
    await assert.rejects(event(p,paid.id,'confirm'),/qualification_required/);
    await f.consents.revoke(p.actor,JSON.parse(report.intentJson).id);
    assert.equal((await exportedModeration()).items[0].view.report,null);
    assert.equal((await moderator.getModeration(report.reportId)).report,null);assert.equal((await f.assistance.get(p.actor,request.id)).paused,true);
    await action(moderator,'resolve',{verdict:'upheld'});await action(requester,'appeal');assert.equal((await moderator.getModeration(report.reportId)).state,'appealed');
    await action(moderator,'resume');await event(p,paid.id,'confirm');
    // A second report pauses an active collaboration and its selected materials.
    const current=await f.assistance.get(f.actor,paid.id);
    const material={id:randomUUID(),assistanceId:paid.id,caseId:root.id,participantId:p.actor.subjectId,scope:current.agreedScope,scopeEventId:contextScopeEvent(current),expiresAt:f.now+500,materials:[{id:randomUUID(),label:'Excerpt',mediaType:'text/plain',content:'Synthetic text'}]};
    await f.context.create(f.actor,await f.authorize(material,'context.grant',{viewers:[p.actor.subjectId]}));
    assert.equal((await f.context.get(f.actor,material.id)).materials[0].content,'Synthetic text');
    const report2=await provider.prepareModeration({kind:'report',assistanceId:paid.id,category:'other',summary:'Active workflow'});await provider.executeModeration(report2,report2.confirmation);
    const pause=await moderator.prepareModeration({kind:'pause',reportId:report2.reportId,summary:'Hold investigation'});await moderator.executeModeration(pause,pause.confirmation);
    await assert.rejects(event(p,paid.id,'deliver',{attemptId:attempt.id,evidenceIds:[],summary:'Blocked'}),/assistance_paused/);
    await assert.rejects(f.context.get(f.actor,material.id), /context_collaboration_changed/);
    await event(f,paid.id,'cancel',{reason:'Cancel while paused'});
    assert.equal((await provider.queryModeration({assistanceId:paid.id})).items.length,1);
    const audit=(await f.db.query("SELECT * FROM audit_events WHERE action LIKE 'moderation.%' AND actor IN ($1,$2,$3)",[f.actor.subjectId,p.actor.subjectId,m.actor.subjectId])).rows;
    assert.equal(audit.length,7);assert.ok(audit.every(row=>row.context_version===1&&row.scope==='moderation'));
    const before=(await moderator.getModeration(report.reportId));
    const rawBefore=(await f.db.query('SELECT payload_text FROM moderation_reports WHERE id=$1',[report.reportId])).rows[0].payload_text;
    const supplement=await provider.prepareModeration({kind:'supplement',reportId:report.reportId,summary:'Artifact review evidence',
      references:[{kind:'artifact',sha256:'a'.repeat(64)},{kind:'case',id:root.id}]});
    const supplementReceipt=await provider.executeModeration(supplement,supplement.confirmation);
    let updated=await moderator.getModeration(report.reportId);
    assert.equal(updated.state,before.state);assert.equal(updated.paused,before.paused);
    assert.equal(updated.events.find(e=>e.id===supplementReceipt.eventId).references.length,2);
    assert.equal((await requester.getModeration(report.reportId)).events.some(e=>e.id===supplementReceipt.eventId),false);
    assert.equal((await exportedModeration()).items[0].view.events.some(e=>e.id===supplementReceipt.eventId),true);
    await action(provider,'correct',{correctsEventId:supplementReceipt.eventId,summary:'Corrected artifact explanation',reason:'Clarified observation'});
    updated=await moderator.getModeration(report.reportId);
    assert.equal(updated.events.find(e=>e.id===supplementReceipt.eventId).summary,'Artifact review evidence');
    assert.ok(updated.events.some(e=>e.kind==='correct'&&e.correctsEventId===supplementReceipt.eventId));
    const originalDecision=updated.events.find(e=>e.kind==='resolve');
    await assert.rejects(provider.prepareModeration({kind:'correct',reportId:report.reportId,correctsEventId:originalDecision.id,summary:'Rewrite moderator',reason:'Unauthorized'}),/Own moderation/);
    const forged={kind:'correct',id:randomUUID(),reportId:report.reportId,expectedVersion:updated.version,correctsEventId:originalDecision.id,summary:'Forge correction',reason:'Unauthorized'};
    await assert.rejects(f.moderation.event(p.actor,report.reportId,await p.authorize(forged,'moderation.publish',{viewers:[m.actor.subjectId]})),/moderation_correction_denied/);
    await action(moderator,'correct',{correctsEventId:originalDecision.id,summary:'Decision wording clarified',reason:'Typographical correction'});
    await action(moderator,'supplement',{summary:'Shared process update',references:[]});
    assert.ok((await requester.getModeration(report.reportId)).events.some(e=>e.kind==='supplement'&&e.summary==='Shared process update'));
    await action(moderator,'resolve',{verdict:'dismissed'});
    await action(requester,'supplement',{summary:'Post-decision response',references:[]});
    assert.equal((await moderator.getModeration(report.reportId)).state,'resolved');
    await f.consents.revoke(p.actor,JSON.parse(supplement.intentJson).id);
    assert.equal((await exportedModeration()).items[0].view.events.some(e=>e.id===supplementReceipt.eventId),false);
    assert.equal((await f.db.query('SELECT payload_text FROM moderation_reports WHERE id=$1',[report.reportId])).rows[0].payload_text,rawBefore);
    assert.ok(!JSON.stringify(audit).includes('Private report details'));
  } finally { requester.cancel();provider.cancel();moderator.cancel();memories.forEach(s=>s.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close(); }
}
