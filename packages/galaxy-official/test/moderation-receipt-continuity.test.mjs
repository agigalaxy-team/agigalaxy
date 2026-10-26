import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createSessionMemory} from "../src/infrastructure/session-memory.mjs";
import {createModerationClient} from "../src/clients/moderation.mjs";
import {createModerationFlow} from "../src/clients/flows/moderation.mjs";

const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(){
  const scopes=['binding','consent','case-teaser','moderation'],owner=await serviceFixture(scopes),reporter=await serviceFixture(scopes,owner.db),moderator=await serviceFixture(scopes,owner.db),other=await serviceFixture(scopes,owner.db);
  owner.moderation.moderatorIds=[moderator.actor.subjectId];
  const api=createApi({...owner,rateLimit:600});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const endpoint=owner.access.endpoint,origin=`http://127.0.0.1:${api.address().port}`,memories=[];
  let loss=null,businessRequests=0;
  const send=async(url,input)=>{
    const path=new URL(url).pathname,isBusiness=path==='/v1/moderation/reports'||path.endsWith('/events');
    if(isBusiness)businessRequests++;
    if(isBusiness&&loss==='before'){loss=null;throw new Error('synthetic network loss before dispatch');}
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const result=await response.json();if(response.status!==200)throw new Error(JSON.stringify(result));
    if(isBusiness&&loss==='after'){loss=null;throw new Error('synthetic ACK lost after actual commit');}return result;
  };
  function host(who){
    const sessions=createSessionMemory({now:()=>owner.now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:owner.now+500,bindingExpiresAt:owner.now+900,takeCredential:()=>who.credential});
    return {sessions,client:createModerationClient({endpoint,sessions,send}),flow:createModerationFlow({endpoint,sessions,signIntent:who.signForTest,consentSend:send,moderationSend:send,now:()=>owner.now})};
  }
  const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Synthetic original-operation review',summary:'Private source',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:owner.actor.subjectId,role:'requester'}]};
  let source;try{source=await owner.authorize(root,'case.teaser.publish',{viewers:[reporter.actor.subjectId,moderator.actor.subjectId]});await owner.cases.submit(owner.actor,source);}
  catch(error){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await owner.db.close();throw error;}
  return {owner,reporter,moderator,other,endpoint,root,source,host,send,
    lose:where=>{loss=where;},requests:()=>businessRequests,
    close:async()=>{memories.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await owner.db.close();}};
}
const reportInput=f=>({kind:'report',caseId:f.root.id,caseVersion:1,targetEventId:f.root.id,category:'false-verification',summary:'Synthetic concern; no real allegation'});

test('original report and append ACKs survive revocation without body, current permission, or duplicate writes',async()=>{
  const f=await fixture();try{
    const r=f.host(f.reporter),m=f.host(f.moderator),outsider=f.host(f.other),preview=await r.flow.prepare(reportInput(f));
    assert.equal(preview.payloadHash,sha(preview.payloadJson));
    assert.notEqual(preview.payloadHash,sha(JSON.stringify({consentId:JSON.parse(preview.intentJson).id,payloadJson:preview.payloadJson})));
    const reference=JSON.parse(JSON.stringify(r.flow.recoveryReference(preview)));assert.ok(!JSON.stringify(reference).includes('Private source'));assert.ok(!Object.hasOwn(reference,'payloadJson'));
    f.lose('after');await assert.rejects(r.flow.execute(preview,preview.confirmation),/ACK lost/);
    const restarted=f.host(f.reporter),accepted=await restarted.flow.recover(reference);
    assert.deepEqual(accepted.receipt,{reportId:preview.reportId,eventId:preview.eventId,version:1});assert.equal(accepted.currentAccessGranted,false);
    await assert.rejects(restarted.flow.prepareExisting({reference,payloadJson:preview.payloadJson}),/confirmed absent/);
    assert.equal((await r.flow.reconcile(preview)).state,'acknowledged');assert.equal(f.requests(),1);
    const append=await r.flow.prepare({kind:'supplement',reportId:preview.reportId,summary:'Synthetic own statement',references:[]});
    f.lose('after');await assert.rejects(r.flow.execute(append,append.confirmation),/ACK lost/);const appendedRef=r.flow.recoveryReference(append);
    const pause=await m.flow.prepare({kind:'pause',reportId:preview.reportId,summary:'Synthetic scoped process hold'});await m.flow.execute(pause,pause.confirmation);
    const query=ref=>({reportId:ref.reportId,eventId:ref.eventId,payloadHash:ref.payloadHash});
    assert.equal((await restarted.client.receipt(query(appendedRef))).receipt.version,2);assert.equal((await m.client.get(preview.reportId)).version,3);
    await f.owner.consents.revoke(f.reporter.actor,JSON.parse(preview.intentJson).id);await f.owner.consents.revoke(f.reporter.actor,JSON.parse(append.intentJson).id);await f.owner.consents.revoke(f.owner.actor,f.source.consentId);
    assert.equal((await m.client.get(preview.reportId)).report,null);assert.ok(!(await m.client.get(preview.reportId)).events.some(event=>event.id===append.eventId));
    await assert.rejects(f.owner.moderation.report(f.reporter.actor,{consentId:JSON.parse(preview.intentJson).id,payloadJson:preview.payloadJson}));
    await assert.rejects(f.owner.moderation.event(f.reporter.actor,preview.reportId,{consentId:JSON.parse(append.intentJson).id,payloadJson:append.payloadJson}));
    // Privileged fixture simulates already removed private bytes; the receipt
    // must work without parsing either old body or reconstructing participants.
    await f.owner.db.query('UPDATE moderation_reports SET payload_text=$2 WHERE id=$1',[preview.reportId,'private bytes no longer retained']);
    await f.owner.db.query('UPDATE moderation_events SET payload_text=$2 WHERE id=$1',[append.eventId,'private bytes no longer retained']);
    f.owner.moderation.loadReport=()=>{throw new Error('receipt must not load report bodies');};
    f.owner.moderation.grant=()=>{throw new Error('receipt must not renew or inspect Consent');};
    assert.equal((await restarted.flow.recover(reference)).state,'acknowledged');assert.equal((await r.flow.reconcile(append)).receipt.version,2);
    assert.equal((await outsider.client.receipt(query(reference))).state,'absent');
    assert.equal((await outsider.client.receipt(query(appendedRef))).state,'absent');
    assert.equal((await restarted.client.receipt({...query(reference),payloadHash:'0'.repeat(64)})).state,'conflict');
    assert.equal((await restarted.client.receipt({...query(reference),reportId:randomUUID()})).state,'conflict');
    assert.equal((await restarted.client.receipt({...query(appendedRef),reportId:randomUUID()})).state,'conflict');
    assert.equal((await restarted.client.receipt({reportId:randomUUID(),eventId:randomUUID(),payloadHash:'0'.repeat(64)})).state,'absent');
    await assert.rejects(async()=>f.owner.moderation.receipt(f.reporter.actor,{...query(reference),payloadJson:preview.payloadJson}),/invalid_moderation_receipt/);
    const onlyBinding=await serviceFixture(['binding'],f.owner.db);await assert.rejects(f.owner.moderation.receipt(onlyBinding.actor,query(reference)));
    assert.equal(f.requests(),3);assert.equal(Number((await f.owner.db.query('SELECT count(*) FROM moderation_reports')).rows[0].count),1);
    assert.equal(Number((await f.owner.db.query('SELECT count(*) FROM moderation_events')).rows[0].count),2);
  }finally{await f.close();}
});

test('only proven absent permits fresh Consent with identical business bytes and IDs',async()=>{
  const f=await fixture();try{
    const r=f.host(f.reporter),original=await r.flow.prepare(reportInput(f)),reference=r.flow.recoveryReference(original);
    f.lose('before');await assert.rejects(r.flow.execute(original,original.confirmation),/before dispatch/);
    await f.owner.consents.revoke(f.reporter.actor,JSON.parse(original.intentJson).id);
    const renewed=await r.flow.prepareExisting({reference,payloadJson:original.payloadJson});
    assert.equal(renewed.eventId,original.eventId);assert.equal(renewed.reportId,original.reportId);assert.equal(renewed.payloadHash,original.payloadHash);assert.equal(renewed.payloadJson,original.payloadJson);
    assert.notEqual(JSON.parse(renewed.intentJson).id,JSON.parse(original.intentJson).id);
    await assert.rejects(r.flow.execute(original,original.confirmation));
    assert.deepEqual(await r.flow.execute(renewed,renewed.confirmation),{reportId:original.reportId,eventId:original.eventId,version:1});
    assert.equal((await r.flow.recover(reference)).state,'acknowledged');
    assert.equal(Number((await f.owner.db.query('SELECT count(*) FROM moderation_reports')).rows[0].count),1);
  }finally{await f.close();}
});

test('local recovery withholds stale-owner replies and rejects forged receipt projections without dispatching another operation',async()=>{
  const endpoint='https://official.example.org',subjectId='GUID'+'A'.repeat(28),otherId='GUID'+'B'.repeat(28),sessions=createSessionMemory({now:()=>2000000000,isCurrent:async()=>true});
  const adopt=id=>sessions.adopt({endpoint,subjectId:id,bindingId:randomUUID(),scopes:['binding','moderation'],expiresAt:2000000500,bindingExpiresAt:2000000900,takeCredential:()=>randomBytes(32).toString('base64url')});adopt(subjectId);
  const payloadJson=JSON.stringify({id:randomUUID(),assistanceId:randomUUID(),category:'other',summary:'Synthetic client fixture'}),consentId=randomUUID();let mode='offline',writes=0,queries=0;
  const client=createModerationClient({endpoint,sessions,send:async(url,{bodyJson})=>{
    if(!url.endsWith('/receipt')){writes++;throw new Error('synthetic uncertain response');}queries++;
    const query=JSON.parse(bodyJson),reportId=new URL(url).pathname.split('/')[4],base={...query,reportId,state:'acknowledged',receipt:{reportId,eventId:query.eventId,version:1},authority:'accepted-operation-only',currentAccessGranted:false,contentReturned:false,independenceVerified:false,capabilityVerified:false};
    if(mode==='offline')throw new Error('synthetic offline');if(mode==='body')return{...base,report:{summary:'unauthorized body'}};
    if(mode==='version')return{...base,receipt:{...base.receipt,version:2}};if(mode==='swap'){adopt(otherId);return base;}return base;
  }});
  try{
    const preview=client.prepare({consentId,payloadJson},{subjectId}),reference=client.recoveryReference(preview);
    await assert.rejects(client.execute(preview,preview.confirmation),/uncertain/);assert.equal(writes,1);
    await assert.rejects(client.reconcile(preview),/offline/);assert.throws(()=>client.prepare({consentId:randomUUID(),payloadJson},{subjectId}),/Reconcile/);
    mode='body';await assert.rejects(client.reconcile(preview));mode='version';await assert.rejects(client.reconcile(preview),/version conflicts/);
    const fresh=createModerationClient({endpoint,sessions,send:()=>{throw new Error('must not blindly retry');}}),restored=fresh.restore({consentId,payloadJson,subjectId});
    await assert.rejects(fresh.execute(restored,restored.confirmation),/confirmation/);
    mode='swap';await assert.rejects(client.reconcile(preview),/authorization changed/);const prior=queries;
    await assert.rejects(client.recover(reference),/owner required/);assert.equal(queries,prior);
    adopt(subjectId);mode='ack';assert.equal((await client.recover(reference)).state,'acknowledged');assert.equal(writes,1);
    const originalLease=await sessions.readAuthorization(endpoint);let leaseWrites=0;
    const leased=createModerationClient({endpoint,sessions,send:()=>{leaseWrites++;throw new Error('must not dispatch on a replacement lease');}});
    const prepared=leased.prepare({consentId:randomUUID(),payloadJson:JSON.stringify({...JSON.parse(payloadJson),id:randomUUID()})},{subjectId,authorization:originalLease});
    adopt(subjectId);await assert.rejects(leased.execute(prepared,prepared.confirmation),/authorization changed/);assert.equal(leaseWrites,0);
  }finally{sessions.close();}
});
