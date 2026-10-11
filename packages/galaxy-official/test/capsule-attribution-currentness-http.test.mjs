import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';



async function fixture(){
  // Fictional synthetic task/source actors. HTTP, Ed25519 Consent, Task/Case
  // transactions execute; no real coauthorship, legal rights or human acceptance.
  const scopes=['binding','consent','case-teaser','assistance','capsules','history'];
  const requester=await serviceFixture(scopes,null,{syntheticCommunityQuota:false});
  const contributor=await serviceFixture(scopes,requester.db,{migrateDatabase:false,syntheticCommunityQuota:false});
  const api=createApi(requester);
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const post=async(who,path,body)=>{
    const r=await fetch(`http://127.0.0.1:${api.address().port}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(who?{Authorization:`Bearer ${who.credential}`}:{})},body:JSON.stringify(body)});
    const value=await r.json();assert.equal(r.status,200,JSON.stringify({path,status:r.status,...value}));return value;
  };
  const signed=(who,payload,action,viewers=[],publicly=false)=>who.authorize(payload,action,{
    objectId:payload.eventId??payload.operationId??payload.id,viewers,visibility:publicly?'Public':'Private',purpose:publicly?'public-profile':'operational'
  });

  try{
    const taskId=randomUUID(),caseId=randomUUID(),participantId=randomUUID();
    const task={operationId:randomUUID(),taskId,caseId:null,intent:'proactive-review',title:'FICTIONAL capsule contribution',summary:'Private synthetic work',
      workContext:{goal:'Observe attribution continuity',currentSituation:'Synthetic fixture only',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:requester.now+1000};
    await post(requester,'/v2/tasks',await signed(requester,task,'assistance.publish',[contributor.actor.subjectId]));
    const root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:requester.actor.subjectId,taskId,
      localRef:randomUUID(),title:'FICTIONAL private source',summary:'Do not publish the underlying private source',source:{kind:'active-task',reference:taskId},synthetic:true};
    const event=(who,kind,expectedVersion,extra={})=>({schemaVersion:2,kind,eventId:randomUUID(),caseId,expectedVersion,actorId:who.actor.subjectId,taskId,...extra});
    const initial=event(requester,'intervention',1,{types:['context-addition'],affectsAttemptIds:[],description:'Private background from requester',sourceRefs:[],observedEffect:'Selected input scope'});
    await post(requester,`/v2/tasks/${taskId}/case`,{operationId:randomUUID(),expectedTaskVersion:1,
      case:await signed(requester,root,'case.teaser.publish',[contributor.actor.subjectId]),
      initialFact:await signed(requester,initial,'case.teaser.publish',[contributor.actor.subjectId])});
    const proposal={eventId:randomUUID(),kind:'propose',expectedTaskVersion:1,participationId:participantId,subjectId:contributor.actor.subjectId,role:'patch',scopeVersion:1,agreedScope:'FICTIONAL isolated patch observation'};
    await post(requester,`/v2/tasks/${taskId}/participations`,await signed(requester,proposal,'assistance.publish',[contributor.actor.subjectId]));
    await post(contributor,`/v2/participations/${participantId}/events`,await signed(contributor,{eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1},'assistance.publish',[requester.actor.subjectId]));
    const intervention=event(contributor,'intervention',2,{participationId:participantId,types:['patch'],affectsAttemptIds:[],description:'Private contributor patch',sourceRefs:[],observedEffect:'Observed correction'});
    await post(contributor,'/v2/cases/events',await signed(contributor,intervention,'case.teaser.publish',[requester.actor.subjectId]));
    const response=event(requester,'intervention-response',3,{interventionRef:{id:intervention.eventId,version:1},state:'accepted',summary:'PRIVATE RESPONSE BODY MUST NEVER BE COPIED'});
    await post(requester,'/v2/cases/events',await signed(requester,response,'case.teaser.publish',[contributor.actor.subjectId]));
    const result=event(contributor,'result-recorded',4,{participationId:participantId,origin:{kind:'intervention',id:intervention.eventId,version:1},scopeVersion:1,
      deliverableRefs:[],reportedOutcome:'succeeded',summary:'Synthetic scoped result',limitations:'Not independent verification or actual professional work'});
    await post(contributor,'/v2/cases/events',await signed(contributor,result,'case.teaser.publish',[requester.actor.subjectId]));
    const interventionRef={kind:'intervention',id:intervention.eventId,version:1,caseId};
    const permission={schemaVersion:2,id:randomUUID(),kind:'grant',sources:[interventionRef,{kind:'result',id:result.eventId,version:1,caseId}],
      grantees:[requester.actor.subjectId],license:'MIT',scope:'Only selected synthetic method, not private response',basis:'authored-content',attribution:'Synthetic patch author',allowPublic:true};
    await post(contributor,'/v2/capsules/permissions',await signed(contributor,permission,'capsule.permission',[requester.actor.subjectId]));
    const version={schemaVersion:2,kind:'version',id:randomUUID(),capsuleId:randomUUID(),expectedRevision:0,version:1,publicationClass:'formal-source-success',synthetic:true,
      title:'FICTIONAL public method',problemPattern:'Scoped patch reuse',environment:{name:'unknown',version:'unknown'},solutionStrategy:'Only deliberately selected method',
      tools:[],skills:[],mcpRefs:[],verificationMethod:'Separate current report and requester contribution response',limitations:['Synthetic fixture only'],
      capabilityId:'software-debugging',applicableScope:'Isolated example',license:'MIT',contributors:[contributor.actor.subjectId],
      sourceResolution:{caseId,resultId:result.eventId,resultVersion:1,proofIds:[],verificationRefs:[]},sourceRefs:[],permissionRefs:[permission.id],
      attributionRefs:[{subjectId:contributor.actor.subjectId,source:interventionRef}],externalReferences:[],redactionConfirmed:true};
    await post(requester,'/v2/capsules/events',await signed(requester,version,'capsule.publish',[],true));

    const read=who=>post(who,'/v2/capsules/read',{capsuleId:version.capsuleId,versionId:version.id});
    const respond=async(state,viewers=[contributor.actor.subjectId],extra={})=>{
      const current=(await requester.db.query('SELECT version FROM cases WHERE id=$1',[caseId])).rows[0].version;
      const payload=event(requester,'intervention-response',current,{interventionRef:{id:intervention.eventId,version:1},state,summary:'PRIVATE '+state+' RESPONSE BODY'});
      const grant=await signed(requester,payload,'case.teaser.publish',viewers);
      await post(requester,'/v2/cases/events',grant);
      return {payload,grant,...extra};
    };
    return {requester,contributor,api,post,signed,read,respond,event,taskId,caseId,participantId,root,initial,intervention,response,result,permission,version,
      close:async()=>{await new Promise(resolve=>api.close(resolve));await requester.db.close();}};
  }catch(error){await new Promise(resolve=>api.close(resolve));await requester.db.close();throw error;}
}
const attribution=view=>view.attributions[0].contributionResponses;
const noBody=view=>{
  const text=JSON.stringify(view);
  assert.equal(text.includes('PRIVATE RESPONSE BODY'),false);
  assert.equal(text.includes('PRIVATE partial RESPONSE BODY'),false);
  assert.equal(text.includes('PRIVATE disputed RESPONSE BODY'),false);
};

test('retained Intervention correction keeps exact historical responses without reviving current target status; explicit new target remains confirmable',async()=>{
  const f=await fixture();try{
    const beforeCapsule=(await f.requester.db.query('SELECT payload_text,payload_hash FROM capsule_events WHERE id=$1',[f.version.id])).rows[0];
    const beforeResponse=(await f.requester.db.query('SELECT payload_text,payload_hash FROM case_events WHERE id=$1',[f.response.eventId])).rows[0];
    const initial=attribution(await f.read(f.requester));assert.equal(initial.status,'current');assert.equal(initial.confirmation,'confirmed');
    const current=(await f.requester.db.query('SELECT version FROM cases WHERE id=$1',[f.caseId])).rows[0].version;
    const correction={...f.intervention,eventId:randomUUID(),expectedVersion:current,supersedes:{id:f.intervention.eventId,version:1},description:'PRIVATE SYNTHETIC later intervention scope'};
    const correctionRequest=await f.signed(f.contributor,correction,'case.teaser.publish',[f.requester.actor.subjectId]);
    await f.post(f.contributor,'/v2/cases/events',correctionRequest);
    const corrected=attribution(await f.read(f.requester));assert.equal(corrected.status,'source-version-superseded');assert.deepEqual(corrected.responses,initial.responses);
    await f.contributor.consents.revoke(f.contributor.actor,correctionRequest.consentId);
    assert.equal(attribution(await f.read(f.requester)).status,'source-version-superseded');
    const metadata=async()=>(await f.requester.db.query('SELECT id,kind,version,subject_id,payload_hash FROM case_events WHERE id=$1',[correction.eventId])).rows[0];
    const beforeMetadata=await metadata();
    // Existing retained-row shape only, not a deletion-worker execution claim.
    await f.requester.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1",[correction.eventId]);assert.deepEqual(await metadata(),beforeMetadata);
    const retainedView=await f.read(f.requester),retained=attribution(retainedView);
    assert.equal(retained.status,'source-currentness-unavailable');assert.equal(retained.confirmation,'confirmed');assert.deepEqual(retained.responses,initial.responses);assert.deepEqual(retained.source,initial.source);
    assert.equal(JSON.stringify(retainedView).includes(correction.eventId),false);assert.equal(JSON.stringify(retainedView).includes(correction.description),false);noBody(retainedView);
    assert.deepEqual((await f.requester.db.query('SELECT payload_text,payload_hash FROM capsule_events WHERE id=$1',[f.version.id])).rows[0],beforeCapsule);
    assert.deepEqual((await f.requester.db.query('SELECT payload_text,payload_hash FROM case_events WHERE id=$1',[f.response.eventId])).rows[0],beforeResponse);
    const receipt=await f.post(f.requester,'/v2/capsules/receipt',{type:'publication',operationId:f.version.id,payloadHash:beforeCapsule.payload_hash});assert.equal(receipt.state,'acknowledged');assert.equal(receipt.currentReadPermissionConfirmed,false);
    const independent={...f.intervention,eventId:randomUUID(),expectedVersion:current+1,description:'SYNTHETIC independent intervention after retained row'};
    await f.post(f.contributor,'/v2/cases/events',await f.signed(f.contributor,independent,'case.teaser.publish',[f.requester.actor.subjectId]));
    const reply=f.event(f.requester,'intervention-response',current+2,{interventionRef:{id:independent.eventId,version:1},state:'partial',summary:'SYNTHETIC original participant partial response'});
    await f.post(f.requester,'/v2/cases/events',await f.signed(f.requester,reply,'case.teaser.publish',[f.contributor.actor.subjectId]));
    const source={kind:'intervention',id:independent.eventId,version:1,caseId:f.caseId};
    const permission={...f.permission,id:randomUUID(),sources:[source]};
    await f.post(f.contributor,'/v2/capsules/permissions',await f.signed(f.contributor,permission,'capsule.permission',[f.requester.actor.subjectId]));
    const version={...f.version,id:randomUUID(),version:2,expectedRevision:1,permissionRefs:[f.permission.id,permission.id],attributionRefs:[{subjectId:f.contributor.actor.subjectId,source}]};
    await f.post(f.requester,'/v2/capsules/events',await f.signed(f.requester,version,'capsule.publish',[],true));
    const next=await f.post(f.requester,'/v2/capsules/read',{capsuleId:version.capsuleId,versionId:version.id});
    assert.equal(attribution(next).status,'current');assert.equal(attribution(next).confirmation,'partially-confirmed');assert.equal(attribution(next).responses[0].eventId,reply.eventId);
    assert.deepEqual(attribution(await f.read(f.requester)).responses,initial.responses);assert.equal(attribution(await f.read(f.requester)).status,'source-currentness-unavailable');
  }finally{await f.close();}
});
