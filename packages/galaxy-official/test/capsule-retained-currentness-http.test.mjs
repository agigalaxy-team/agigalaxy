import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {digest} from '../src/shared/digest.mjs';

async function fixture(){
  // Actual HTTP, Ed25519 Consent and PGlite; fictional work and subjects only.
  // No registration, independent causality, deletion worker or remote DB claim.
  const scopes=['binding','consent','case-teaser','capsules','history','assistance'];
  const author=await serviceFixture(scopes,null,{syntheticCommunityQuota:false});
  const applicant=await serviceFixture(scopes,author.db,{migrateDatabase:false,syntheticCommunityQuota:false});
  const api=createApi(author);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const post=async(who,route,input)=>{
    const r=await fetch(`http://127.0.0.1:${api.address().port}${route}`,{method:'POST',headers:{'Content-Type':'application/json',
      ...(who?{Authorization:`Bearer ${who.credential}`}:{})},body:JSON.stringify(input)});
    return {status:r.status,body:await r.json()};
  };
  const accepted=async(who,route,input)=>{const response=await post(who,route,input);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
  const signed=(who,payload,action='case.teaser.publish',options={})=>who.authorize(payload,action,{objectId:payload.eventId??payload.id,...options});
  const fact=async(who,payload)=>{const request=await signed(who,payload);await accepted(who,'/v2/cases/events',request);return request;};
  const work=async(who,label,outcome='succeeded')=>{
    const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:who.actor.subjectId,
      localRef:randomUUID(),title:'SYNTHETIC '+label,summary:'Local consumer test; not human value',source:{kind:'local',reference:randomUUID()},synthetic:true};
    const rootRequest=await fact(who,root);
    const attempt={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId,expectedVersion:1,actorId:who.actor.subjectId,
      role:'implementation',strategy:'Selected synthetic method',inputScopeSummary:'Synthetic only',permissionScope:['selected-context'],environment:{name:'Node',version:'24'}};
    const attemptRequest=await fact(who,attempt);
    const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:2,actorId:who.actor.subjectId,
      origin:{kind:'attempt',id:attempt.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:outcome,
      summary:'Synthetic reported result',limitations:'No independent verification or causality'};
    const resultRequest=await fact(who,result);return {root,attempt,result,rootRequest,attemptRequest,resultRequest};
  };
  const version=(source,extra={})=>({schemaVersion:2,id:randomUUID(),capsuleId:randomUUID(),kind:'version',expectedRevision:0,version:1,
    publicationClass:'formal-source-success',synthetic:true,title:'SYNTHETIC exact source method',problemPattern:'Current support and exact history',
    environment:{name:'Node',version:'24'},solutionStrategy:'Only the selected method',tools:[],skills:[],mcpRefs:[],verificationMethod:'Scoped synthetic report',
    limitations:['Synthetic only'],capabilityId:'software-debugging',applicableScope:'Local test',license:'MIT',contributors:[],
    sourceResolution:{caseId:source.root.caseId,resultId:source.result.eventId,resultVersion:1,proofIds:[],verificationRefs:[]},
    sourceRefs:[],permissionRefs:[],attributionRefs:[],externalReferences:[],redactionConfirmed:true,...extra});
  const publication=async(payload)=>{const request=await signed(author,payload,'capsule.publish',{visibility:'Public',purpose:'public-profile'});
    await accepted(author,'/v2/capsules/events',request);return request;};
  const application=(capsule,target)=>({schemaVersion:2,id:randomUUID(),kind:'apply',capsuleId:capsule.capsuleId,versionId:capsule.id,caseId:target.root.caseId,
    attribution:author.actor.subjectId,note:'SYNTHETIC explicitly selected subset',attemptRef:{id:target.attempt.eventId,version:1},resultRef:{id:target.result.eventId,version:1},
    environment:{name:'Node',version:'24'},environmentDifference:'Independent synthetic target',adoptedParts:['Selected method'],outcome:target.result.reportedOutcome});
  const read=capsule=>accepted(applicant,'/v2/capsules/read',{capsuleId:capsule.capsuleId,versionId:capsule.id});
  const uses=capsule=>accepted(applicant,'/v2/capsules/uses/query',{capsuleId:capsule.capsuleId,versionId:capsule.id});
  const receipt=async(who,type,request,operationId)=>{
    const result=await accepted(who,'/v2/capsules/receipt',{type,operationId,payloadHash:digest(request.payloadJson)});
    assert.equal(result.state,'acknowledged');assert.equal(result.currentReadPermissionConfirmed,false);return result;
  };
  const erase=async(id)=>{
    const metadata=async()=> (await author.db.query('SELECT id,version,subject_id,kind,payload_hash FROM case_events WHERE id=$1',[id])).rows[0];
    const before=await metadata();
    // Existing retained-row shape only; do not claim the deletion worker ran.
    await author.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1",[id]);
    assert.deepEqual(await metadata(),before);
  };
  const stored=async(table,id)=>(await author.db.query(`SELECT payload_text,payload_hash FROM ${table} WHERE id=$1`,[id])).rows[0];
  const noPrivate=(view,correction)=>{assert.equal(JSON.stringify(view).includes(correction.eventId),false);assert.equal(JSON.stringify(view).includes(correction.summary),false);};
  return {author,applicant,post,accepted,signed,fact,work,version,publication,application,read,uses,receipt,erase,stored,noPrivate,
    close:async()=>{await new Promise(resolve=>api.close(resolve));await author.db.close();}};
}

test('private/revoked/retained source correction cannot revive new application; exact history and a fresh lawful source remain usable',async()=>{
  const f=await fixture();try{
    const source=await f.work(f.author,'source'),first=await f.work(f.applicant,'first','partial'),later=await f.work(f.applicant,'later','failed');
    const capsule=f.version(source),publicationRequest=await f.publication(capsule);
    assert.equal((await f.read(capsule)).newApplicationAllowed,true);
    const oldUse=f.application(capsule,first),oldRequest=await f.signed(f.applicant,oldUse,'capsule.use');
    await f.accepted(f.applicant,'/v2/capsules/uses',oldRequest);
    const originalPublication=await f.stored('capsule_events',capsule.id),originalUse=await f.stored('capsule_uses_v2',oldUse.id);
    const correction={...source.result,eventId:randomUUID(),expectedVersion:3,supersedes:{id:source.result.eventId,version:1},
      reportedOutcome:'failed',summary:'PRIVATE synthetic correction body'};
    const correctionRequest=await f.fact(f.author,correction);
    const deniedUse=f.application(capsule,later),deniedRequest=await f.signed(f.applicant,deniedUse,'capsule.use');
    const denyNew=async()=>{const result=await f.post(f.applicant,'/v2/capsules/uses',deniedRequest);assert.equal(result.status,409);assert.equal(result.body.error,'capsule_not_applicable');};
    const corrected=await f.read(capsule);assert.equal(corrected.sourceStatus,'source-result-superseded');assert.equal(corrected.newApplicationAllowed,false);f.noPrivate(corrected,correction);await denyNew();
    await f.author.consents.revoke(f.author.actor,correctionRequest.consentId);
    assert.equal((await f.read(capsule)).sourceStatus,'source-result-superseded');await denyNew();
    await f.erase(correction.eventId);
    const retained=await f.read(capsule);assert.equal(retained.sourceStatus,'source-currentness-unavailable');assert.equal(retained.newApplicationAllowed,false);
    assert.deepEqual(retained.version,capsule);f.noPrivate(retained,correction);await denyNew();
    assert.equal(await f.stored('capsule_uses_v2',deniedUse.id),undefined);
    const history=await f.uses(capsule);assert.equal(history.items[0].capsuleSourceStatus,'source-currentness-unavailable');assert.equal(history.items[0].reportedOutcome,'partial');
    await f.receipt(f.author,'publication',publicationRequest,capsule.id);await f.receipt(f.applicant,'use',oldRequest,oldUse.id);
    await f.accepted(f.author,'/v2/capsules/events',publicationRequest);await f.accepted(f.applicant,'/v2/capsules/uses',oldRequest);
    assert.deepEqual(await f.stored('capsule_events',capsule.id),originalPublication);assert.deepEqual(await f.stored('capsule_uses_v2',oldUse.id),originalUse);
    const staleVersion=f.version(source,{capsuleId:capsule.capsuleId,version:2,expectedRevision:1});
    const staleRequest=await f.signed(f.author,staleVersion,'capsule.publish',{visibility:'Public',purpose:'public-profile'});
    const deniedPublication=await f.post(f.author,'/v2/capsules/events',staleRequest);assert.equal(deniedPublication.status,409);assert.equal(deniedPublication.body.error,'fact_currentness_unavailable');
    const independent={...source.result,eventId:randomUUID(),expectedVersion:4,summary:'SYNTHETIC newly observed independent Result'};
    await f.fact(f.author,independent);
    const freshSource={...source,result:independent},fresh=f.version(freshSource,{capsuleId:capsule.capsuleId,version:2,expectedRevision:1});
    await f.publication(fresh);assert.equal((await f.read(fresh)).sourceStatus,'current');assert.equal((await f.read(fresh)).newApplicationAllowed,true);
    const freshUse=f.application(fresh,later);await f.accepted(f.applicant,'/v2/capsules/uses',await f.signed(f.applicant,freshUse,'capsule.use'));
    assert.equal((await f.read(capsule)).sourceStatus,'source-currentness-unavailable');
    assert.deepEqual(await f.stored('capsule_events',capsule.id),originalPublication);assert.deepEqual(await f.stored('capsule_uses_v2',oldUse.id),originalUse);
  }finally{await f.close();}
});

test('retained target correction is unknown current support without rewriting the original use; a new exact target Result can restore support',async()=>{
  const f=await fixture();try{
    const source=await f.work(f.author,'source'),target=await f.work(f.applicant,'target','partial'),capsule=f.version(source);
    await f.publication(capsule);
    const oldUse=f.application(capsule,target),oldRequest=await f.signed(f.applicant,oldUse,'capsule.use');await f.accepted(f.applicant,'/v2/capsules/uses',oldRequest);
    const oldBytes=await f.stored('capsule_uses_v2',oldUse.id);
    const correction={...target.result,eventId:randomUUID(),expectedVersion:3,supersedes:{id:target.result.eventId,version:1},reportedOutcome:'failed',summary:'PRIVATE target correction body'};
    const correctionRequest=await f.fact(f.applicant,correction);
    assert.equal((await f.uses(capsule)).items[0].sourceStatus,'application-result-superseded');
    await f.applicant.consents.revoke(f.applicant.actor,correctionRequest.consentId);
    assert.equal((await f.uses(capsule)).items[0].sourceStatus,'application-result-superseded');
    await f.erase(correction.eventId);
    const unknown=await f.uses(capsule);assert.equal(unknown.items[0].sourceStatus,'application-currentness-unavailable');f.noPrivate(unknown,correction);
    assert.equal(unknown.items[0].reportedOutcome,'partial');assert.equal((await f.read(capsule)).newApplicationAllowed,true);
    const staleUse=f.application(capsule,target),staleRequest=await f.signed(f.applicant,staleUse,'capsule.use');
    const stale=await f.post(f.applicant,'/v2/capsules/uses',staleRequest);assert.equal(stale.status,409);assert.equal(stale.body.error,'fact_currentness_unavailable');
    assert.equal(await f.stored('capsule_uses_v2',staleUse.id),undefined);
    await f.receipt(f.applicant,'use',oldRequest,oldUse.id);await f.accepted(f.applicant,'/v2/capsules/uses',oldRequest);assert.deepEqual(await f.stored('capsule_uses_v2',oldUse.id),oldBytes);
    const independent={...target.result,eventId:randomUUID(),expectedVersion:4,reportedOutcome:'succeeded',summary:'SYNTHETIC separate target result'};await f.fact(f.applicant,independent);
    const freshUse=f.application(capsule,{...target,result:independent});await f.accepted(f.applicant,'/v2/capsules/uses',await f.signed(f.applicant,freshUse,'capsule.use'));
    const history=await f.uses(capsule);assert.equal(history.items.find(item=>item.eventId===oldUse.id).sourceStatus,'application-currentness-unavailable');
    assert.equal(history.items.find(item=>item.eventId===freshUse.id).sourceStatus,'current');assert.deepEqual(await f.stored('capsule_uses_v2',oldUse.id),oldBytes);
  }finally{await f.close();}
});

test('nested exact historical materials need current permission but are not all forced to latest versions',async()=>{
  const f=await fixture();try{
    const source=await f.work(f.author,'nested source'),target=await f.work(f.applicant,'target','partial');
    const correction={...source.result,eventId:randomUUID(),expectedVersion:3,supersedes:{id:source.result.eventId,version:1},reportedOutcome:'failed'};await f.fact(f.author,correction);
    const independent={...source.result,eventId:randomUUID(),expectedVersion:4,deliverableRefs:[{kind:'result',id:source.result.eventId,version:1}],summary:'SYNTHETIC fresh main result with deliberate historical material'};
    await f.fact(f.author,independent);
    const capsule=f.version({...source,result:independent}),publicationRequest=await f.publication(capsule);
    assert.equal((await f.read(capsule)).newApplicationAllowed,true);
    const use=f.application(capsule,target),request=await f.signed(f.applicant,use,'capsule.use');await f.accepted(f.applicant,'/v2/capsules/uses',request);
    await f.author.consents.revoke(f.author.actor,source.resultRequest.consentId);
    const revoked=await f.read(capsule);assert.equal(revoked.sourceStatus,'source-unavailable');assert.equal(revoked.version,null);assert.equal(revoked.newApplicationAllowed,false);
    const next=f.application(capsule,target),nextRequest=await f.signed(f.applicant,next,'capsule.use');assert.equal((await f.post(f.applicant,'/v2/capsules/uses',nextRequest)).status,403);
    assert.equal(await f.stored('capsule_uses_v2',next.id),undefined);assert.equal((await f.uses(capsule)).items[0].sourceStatus,'capsule-source-unavailable');
    await f.receipt(f.author,'publication',publicationRequest,capsule.id);await f.receipt(f.applicant,'use',request,use.id);
  }finally{await f.close();}
});

test('a retained Result in another Case does not contaminate an unrelated exact source',async()=>{
  const f=await fixture();try{
    const source=await f.work(f.author,'source'),unrelated=await f.work(f.author,'other Case'),capsule=f.version(source);
    await f.publication(capsule);
    const correction={...unrelated.result,eventId:randomUUID(),expectedVersion:3,supersedes:{id:unrelated.result.eventId,version:1},reportedOutcome:'failed'};await f.fact(f.author,correction);await f.erase(correction.eventId);
    const view=await f.read(capsule);assert.equal(view.sourceStatus,'current');assert.equal(view.newApplicationAllowed,true);
    const target=await f.work(f.applicant,'target','failed'),use=f.application(capsule,target);
    await f.accepted(f.applicant,'/v2/capsules/uses',await f.signed(f.applicant,use,'capsule.use'));
    assert.equal((await f.uses(capsule)).items[0].sourceStatus,'current');
  }finally{await f.close();}
});
