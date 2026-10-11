import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {capsuleToolDefinitions} from '../src/personal-mcp-capsules-v2.mjs';
import {digest} from '../src/shared/digest.mjs';

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
test('current authorized original contribution responses appear in Capsule read and preview without coauthor approval or private body',async()=>{
 const f=await fixture();try{
  const before=(await f.requester.db.query('SELECT id,payload_text,payload_hash FROM case_events WHERE case_id=$1 ORDER BY version',[f.caseId])).rows;
  const own=await f.read(f.requester),participant=await f.read(f.contributor),anonymous=await f.read(null);
  assert.equal(attribution(own).status,'current');assert.equal(attribution(own).confirmation,'confirmed');
  assert.deepEqual(attribution(own).responses,[{eventId:f.response.eventId,actorId:f.requester.actor.subjectId,relationship:'requester',state:'accepted',interventionRef:{id:f.intervention.eventId,version:1}}]);
  assert.deepEqual(attribution(participant).responses,attribution(own).responses);
  assert.equal(attribution(anonymous).status,'source-not-readable');assert.deepEqual(attribution(anonymous).responses,[]);
  assert.equal(JSON.stringify(anonymous).includes(f.response.eventId),false);
  const outsider=await serviceFixture(['binding','consent','case-teaser','assistance','capsules','history'],f.requester.db,{migrateDatabase:false,syntheticCommunityQuota:false});
  assert.deepEqual(attribution(await f.read(outsider)).responses,[]);
  const preview=await f.post(f.requester,'/v2/capsules/preview',{payload:f.version});
  assert.equal(attribution(preview).confirmation,'confirmed');
  const tools=capsuleToolDefinitions(f.requester,f.requester.actor),mcp=await tools.galaxy_capsule_v2_read.run({capsuleId:f.version.capsuleId,versionId:f.version.id});
  assert.deepEqual(attribution(mcp),attribution(own)); // Factory service contract, not an SDK/network claim.
  for(const view of [own,participant,anonymous,preview,mcp]){noBody(view);assert.equal(view.coauthorApproval,false);assert.equal(view.capabilityVerified,false);}
  assert.deepEqual((await f.requester.db.query('SELECT id,payload_text,payload_hash FROM case_events WHERE case_id=$1 ORDER BY version',[f.caseId])).rows,before);
  assert.equal(Number((await f.requester.db.query('SELECT count(*) FROM capsule_uses_v2 WHERE capsule_id=$1',[f.version.capsuleId])).rows[0].count),0);
  assert.equal((await f.requester.db.query('SELECT payload_hash FROM capsule_events WHERE id=$1',[f.version.id])).rows[0].payload_hash,digest(JSON.stringify(f.version)));
 }finally{await f.close();}
});
test('a newer private or revoked response and a retained body-free row never revive earlier accepted contribution',async()=>{
 const f=await fixture();try{
  const oldBytes=(await f.requester.db.query('SELECT payload_text FROM case_events WHERE id=$1',[f.response.eventId])).rows[0].payload_text;
  const partial=await f.respond('partial',[]);
  assert.equal(attribution(await f.read(f.requester)).confirmation,'partially-confirmed');
  const withheld=attribution(await f.read(f.contributor));assert.deepEqual(withheld.responses,[]);assert.equal(withheld.confirmation,'unconfirmed');
  await f.requester.consents.revoke(f.requester.actor,partial.grant.consentId);
  assert.deepEqual(attribution(await f.read(f.requester)).responses,[]);
  const disputed=await f.respond('disputed');
  assert.equal(attribution(await f.read(f.contributor)).confirmation,'disputed');
  assert.equal(attribution(await f.read(f.contributor)).responses[0].eventId,disputed.payload.eventId);
  const current=await f.respond('accepted');
  // Only robustness of retained-row metadata is simulated here. This is not a
  // claim that the real deletion worker was executed or deleted a subject.
  await f.requester.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1",[current.payload.eventId]);
  const erased=await f.read(f.contributor);assert.deepEqual(attribution(erased).responses,[]);assert.equal(attribution(erased).confirmation,'unconfirmed');noBody(erased);
  const version=(await f.requester.db.query('SELECT version FROM cases WHERE id=$1',[f.caseId])).rows[0].version;
  const temporary=f.event(f.requester,'intervention-response',version,{interventionRef:{id:f.intervention.eventId,version:1},state:'accepted',summary:'PRIVATE temporary RESPONSE BODY'});
  const grant=await f.requester.authorize(temporary,'case.teaser.publish',{objectId:temporary.eventId,viewers:[f.contributor.actor.subjectId],expiresAt:f.requester.now+10});
  await f.post(f.requester,'/v2/cases/events',grant);
  assert.equal(attribution(await f.read(f.contributor)).responses[0].eventId,temporary.eventId);
  f.requester.access.now=()=>f.requester.now+11;f.requester.consents.now=()=>f.requester.now+11;
  assert.deepEqual(attribution(await f.read(f.contributor)).responses,[]);
  assert.equal((await f.requester.db.query('SELECT payload_text FROM case_events WHERE id=$1',[f.response.eventId])).rows[0].payload_text,oldBytes);
 }finally{await f.close();}
});
test('exact Intervention versions retain scoped responses through correction and losing source permission withholds them without rewriting Capsule bytes',async()=>{
 const f=await fixture();try{
  const current=(await f.requester.db.query('SELECT version FROM cases WHERE id=$1',[f.caseId])).rows[0].version;
  const correction={...f.intervention,eventId:randomUUID(),expectedVersion:current,supersedes:{id:f.intervention.eventId,version:1},description:'Corrected synthetic scope'};
  await f.post(f.contributor,'/v2/cases/events',await f.signed(f.contributor,correction,'case.teaser.publish',[f.requester.actor.subjectId]));
  const old=attribution(await f.read(f.requester));assert.equal(old.status,'source-version-superseded');assert.equal(old.responses[0].interventionRef.version,1);
  const newResponse=f.event(f.requester,'intervention-response',current+1,{interventionRef:{id:f.intervention.eventId,version:2},state:'disputed',summary:'PRIVATE CORRECTED VERSION RESPONSE'});
  await f.post(f.requester,'/v2/cases/events',await f.signed(f.requester,newResponse,'case.teaser.publish',[f.contributor.actor.subjectId]));
  assert.equal(attribution(await f.read(f.requester)).responses[0].eventId,f.response.eventId);
  assert.equal(JSON.stringify(await f.read(f.requester)).includes(newResponse.eventId),false);
  const row=(await f.requester.db.query('SELECT * FROM case_events WHERE id=$1',[f.intervention.eventId])).rows[0];
  await f.contributor.consents.revoke(f.contributor.actor,row.consent_id);
  const unavailable=await f.read(f.requester);assert.equal(unavailable.version,null);assert.equal(unavailable.attributions,undefined);assert.equal(unavailable.newApplicationAllowed,false);
  const receipt=await f.post(f.requester,'/v2/capsules/receipt',{type:'publication',operationId:f.version.id,payloadHash:digest(JSON.stringify(f.version))});
  assert.equal(receipt.state,'acknowledged');assert.equal(receipt.currentReadPermissionConfirmed,false);assert.equal(JSON.stringify(receipt).includes(f.response.eventId),false);
  assert.equal((await f.requester.db.query('SELECT payload_text FROM capsule_events WHERE id=$1',[f.version.id])).rows[0].payload_text,JSON.stringify(f.version));
 }finally{await f.close();}
});
