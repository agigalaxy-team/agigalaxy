import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createAssistanceFlow } from '../src/assistance-flow.mjs';
import { createAssistanceClient } from '../src/assistance-client.mjs';
import { createHonorClient } from '../src/honor-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHostConnectionController } from '../src/host-connection-controller.mjs';
import { recordRuntimeConfig,runtimeConfigSnapshot } from '../src/operations/runtime-config-audit.mjs';

export async function verifyPublicHonor(db=null,options={}){
  const endpoint=`https://public-honor-${randomUUID()}.example.org`,scopes=['binding','consent','case-teaser','assistance','history'];
  const setup={...options,endpoint},f=await serviceFixture(scopes,db,setup),providers=[];
  for(let i=0;i<5;i++)providers.push(await serviceFixture(scopes,f.db,setup));
  const rule={id:'public-helper',version:'1',title:'Synthetic public contributors',kind:'open-contributor',capabilityId:'compiler',communityId:'fixture',
    members:[f,...providers].map(who=>who.actor.subjectId),relatedPartyGroups:[[f.actor.subjectId,providers[0].actor.subjectId]],
    notBefore:f.now-1,notAfter:f.now+1000,windowFrom:f.now-100,windowUntil:f.now+1,minAcceptedCases:1,minProofs:0,repositories:[],
    rankingEnabled:true,privacyReview:'approved',minimumCohort:5,minimumCasesPerMember:3};
  await recordRuntimeConfig(f.db,{endpoint,component:'api',honorRules:[rule],snapshot:runtimeConfigSnapshot({governance:{honorRules:[rule]}})});
  await f.honor.useRegistry();
  const api=createApi({...f,rateLimit:10000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,memories=[],controllers=[],signed=[];
  const transport=async(url,input,method)=>{
    const response=await fetch(origin+new URL(url).pathname,{method,headers:{'Content-Type':'application/json',...(input.credential?{Authorization:`Bearer ${input.credential}`}:{})},
      ...(method==='POST'?{body:input.bodyJson}:{}),signal:input.signal});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
  };
  const send=(url,input)=>transport(url,input,'POST'),read=(url,input)=>transport(url,input,'GET');
  function host(who){
    const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>who.credential});
    const assistanceClient=createAssistanceClient({endpoint,sessions,send,read});
    const assistanceFlow=createAssistanceFlow({endpoint,sessions,now:()=>f.now,signIntent:async(payload,typ)=>{signed.push(JSON.parse(payload));return who.signForTest(payload,typ);},consentSend:send,assistanceSend:send,assistanceRead:read});
    const result=createHostConnectionController({endpoint,sessions,assistanceClient,assistanceFlow});controllers.push(result);return result;
  }
  const hosts=new Map([f,...providers].map(who=>[who,host(who)]));
  const honor=createHonorClient({endpoint,send}),query={ruleId:rule.id,ruleVersion:rule.version};
  const records=[];
  async function collaborate(provider,{privateAcceptance=false,visibility='Public'}={}){
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Public contributor fixture',summary:'Selected public summary',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',{visibility:'Public',purpose:'public-profile'}));
    const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'Private diagnostics',configuration:{environment:'test',version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt));
    const request={id:randomUUID(),caseId:root.id,title:'Compiler help',problem:'Public fixture',attemptedApproaches:[],scope:'Inspect',visibility,collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
    await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',{visibility,purpose:visibility==='Public'?'public-profile':'operational',viewers:visibility==='Private'?[provider.actor.subjectId]:[]}));
    const event=async(who,kind,fields={},publicEvent=false)=>{
      const controller=hosts.get(who),preview=await controller.prepareCollaboration({assistanceId:request.id,event:{kind,...fields},...(publicEvent?{eventVisibility:'Public'}:{})});
      const intent=JSON.parse(preview.intentJson);assert.equal(intent.visibility,publicEvent?'Public':'Private');
      if(publicEvent){assert.equal(intent.purpose,'public-profile');assert.deepEqual(intent.viewers,[]);}
      await controller.executeCollaboration(preview,preview.confirmation);return {event:JSON.parse(preview.payloadJson).event,intent};
    };
    const controller=hosts.get(provider),offerInput={assistanceId:request.id,event:{kind:'offer',proposal:'Private offer text',scope:'Inspect'},eventVisibility:'Public'};
    if(records.length===0){
      await assert.rejects(controller.prepareCollaboration(offerInput),/eligible contribution event/);
      const ev={id:randomUUID(),expectedVersion:1,...offerInput.event};
      await assert.rejects(f.assistance.submit(provider.actor,request.id,await provider.authorize({assistanceId:request.id,event:ev},'assistance.publish',{objectId:ev.id,visibility:'Public',purpose:'public-profile'})),/participant_consent_required/);
    }
    const offer=await event(provider,'offer',offerInput.event);await event(f,'select',{offerId:offer.event.id});
    if(visibility==='Private'){
      await assert.rejects(controller.prepareCollaboration({assistanceId:request.id,event:{kind:'confirm'},eventVisibility:'Public'}),/public request/);
      const ev={id:randomUUID(),expectedVersion:3,kind:'confirm'};
      await assert.rejects(f.assistance.submit(provider.actor,request.id,await provider.authorize({assistanceId:request.id,event:ev},'assistance.publish',{objectId:ev.id,visibility:'Public',purpose:'public-profile'})),/participant_consent_required/);
    }
    const preview=await controller.prepareCollaboration({assistanceId:request.id,event:{kind:'confirm'},...(visibility==='Public'?{eventVisibility:'Public'}:{})});
    const before=signed.length;await assert.rejects(controller.executeCollaboration(preview,'wrong'),/confirmation/);assert.equal(signed.length,before);controller.cancel();
    await event(provider,'confirm',{},visibility==='Public');
    await event(provider,'deliver',{attemptId:attempt.id,evidenceIds:[],summary:'Selected contribution summary'},visibility==='Public');
    const current=await f.assistance.get(f.actor,request.id);
    const accept=await event(f,'accept',{deliveryId:current.delivery.id,summary:privateAcceptance?'Private acceptance text':'Public acceptance'},visibility==='Public'&&!privateAcceptance);
    const record={requestId:request.id,provider,accept,caseId:root.id};records.push(record);return record;
  }
  try{
    for(const provider of providers)for(let i=0;i<3;i++)await collaborate(provider,{privateAcceptance:provider===providers[0]&&i===2});
    // The private acceptance is preserved; a new distinct publicly shared Case
    // supplies the third eligible contribution without republishing old records.
    await collaborate(providers[0]);
    const privateRequest=await collaborate(providers[0],{visibility:'Private'});
    assert.equal((await honor.ranking(query)).reason,'rule-inactive-or-window-open');
    f.access.now=()=>f.now+2;
    let ranked=await honor.ranking(query);assert.equal(ranked.status,'published');assert.equal(ranked.items.length,5);
    assert.deepEqual(ranked.items.map(item=>item.rank),[1,1,1,1,1]);assert.ok(ranked.items.every(item=>item.acceptedCases===3));
    assert.equal(ranked.statistics.cohort,5);assert.equal(ranked.statistics.acceptedCases,15);assert.equal(ranked.statistics.industryComparison,false);
    assert.equal(ranked.capabilityVerified,false);assert.equal(ranked.qualificationGranted,false);
    const first=ranked.items.find(item=>item.subjectId===providers[0].actor.subjectId);assert.equal(first.relatedPartyCases,3);
    const card=await honor.publicQuery({...query,subjectId:first.subjectId});assert.equal(card.card.status,'active');assert.equal(card.card.acceptedCases,3);
    const statusLink=async()=>{const response=await fetch(origin+new URL(card.card.statusUrl).pathname);assert.equal(response.status,200);return response.json();};
    assert.equal((await statusLink()).card.id,card.card.id);
    assert.ok(!JSON.stringify(card).includes('Private acceptance text'));assert.ok(!JSON.stringify(card).includes('Private offer text'));
    const hidden=records.find(record=>record.accept.intent.visibility==='Private');
    assert.equal((await f.db.query('SELECT intent FROM consents WHERE id=$1',[hidden.accept.intent.id])).rows[0].intent.visibility,'Private');
    assert.ok(!(await honor.publicQuery({...query,subjectId:first.subjectId})).contributions.some(item=>item.assistanceId===privateRequest.requestId));
    const withdrew=records.find(record=>record.provider===providers[0]&&record.accept.intent.visibility==='Public');
    await f.consents.revoke(f.actor,withdrew.accept.intent.id);
    ranked=await honor.ranking(query);assert.equal(ranked.status,'suppressed');assert.equal(ranked.statistics,undefined);assert.deepEqual(ranked.items,[]);
    assert.equal(ranked.reason,'insufficient-public-cohort');
    assert.equal((await honor.publicQuery({...query,subjectId:first.subjectId})).card.acceptedCases,2);
    assert.equal((await statusLink()).card.acceptedCases,2);
    assert.equal((await f.db.query('SELECT id FROM assistance_events WHERE id=$1',[withdrew.accept.event.id])).rows.length,1);
    f.access.now=()=>f.now+1001;const expired=(await statusLink()).card;
    assert.equal(expired.status,'inactive-rule');assert.ok(expired.checkedAt>card.card.checkedAt);assert.equal(expired.id,card.card.id);
    return {publicCohort:5,publicCases:15,privateHistoryPreserved:true,explicitPerEventConsent:true,privateRequestCannotDisclose:true,applicationsRemainPrivate:true,
      minimumCohortEnforced:true,windowEnforced:true,tiedRanks:true,relatedPartyFacet:true,revocationSuppressesRanking:true,statusLinkRefresh:true,expiredCardInactive:true,capabilityCertified:false};
  }finally{controllers.forEach(controller=>controller.cancel());memories.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
