import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createAssistanceFlow } from "../src/clients/flows/assistance.mjs";
import { createAssistanceClient } from "../src/clients/assistance.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createConnectionClient } from "../src/clients/connection.mjs";
import { createLocalAssistanceStore } from "../src/clients/local/assistance-store.mjs";

async function fixture(t) {
  const scopes=['binding','consent','case-teaser','assistance'],f=await serviceFixture(scopes);
  const directory=await mkdtemp(join(tmpdir(),'galaxy-assistance-recovery-')),endpoint=f.access.endpoint;
  await writeFile(join(directory,'galaxy-id.json'),JSON.stringify(f.genesis));
  await writeFile(join(directory,'galaxy-local-state.json'),JSON.stringify({integration:{},cases:[{id:'preserved-local-case'}]}));
  const api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+600,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  t.after(async()=>{sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();await rm(directory,{recursive:true,force:true});});
  let fail=null,writes=0;const signed=[];
  const transport=async(url,input,method='POST')=>{
    const path=new URL(url).pathname,eventWrite=method==='POST'&&(path==='/v1/assistance'||/^\/v1\/assistance\/[^/]+\/events$/.test(path));
    if(eventWrite&&fail==='before'){fail=null;throw new Error('Dropped before event');}
    const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(input.credential?{Authorization:`Bearer ${input.credential}`}:{})},
      ...(method==='POST'?{body:input.bodyJson}:{}),signal:input.signal});
    const result=await response.json();if(!response.ok)throw new Error(result.error??'API rejected');
    if(eventWrite){writes++;if(fail==='after'){fail=null;throw new Error('Lost acknowledgement');}}
    return result;
  };
  const journal=()=>createLocalAssistanceStore({dataDirectory:directory,endpoint});
  const flow=()=>createAssistanceFlow({endpoint,sessions,now:()=>f.now,journal:journal(),consentSend:transport,assistanceSend:transport,
    assistanceRead:(url,input)=>transport(url,input,'GET'),signIntent:async(payload,type)=>{signed.push(JSON.parse(payload));return f.signForTest(payload,type);}});
  const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Recovery case',summary:'Selected teaser',
    source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
  await f.cases.submit(f.actor,await f.authorize(root));
  const request=()=>({caseId:root.id,title:'Recovery request',problem:'Compiler fails',attemptedApproaches:['Checked options'],scope:'Suggest a patch',
    visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:f.now+300});
  return {f,directory,endpoint,sessions,transport,journal,flow,request,signed,fail:value=>{fail=value;},writes:()=>writes};
}

async function requestDraft(h,values={}) {
  const store=h.journal(),row=await store.createDraft(),request=h.request();
  return store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'review',visibility:'Private',
    values:{caseId:request.caseId,title:request.title,problem:request.problem,attempts:request.attemptedApproaches.join(';'),scope:request.scope,hours:'1',...values}}});
}

test('editable request preview returns to the same draft and one explicit publication freezes and recovers its exact updated scope',async t=>{
  const h=await fixture(t),flow=h.flow();let row=await requestDraft(h);
  const first=await flow.prepareDraft({draftId:row.id,draftRevision:row.revision});
  assert.equal((await h.journal().getDraft(row.id)).status,'editing');assert.equal((await flow.list()).items.length,0);
  assert.equal(h.signed.length,0);assert.equal(h.writes(),0);flow.cancel(first);
  const approaches=['Checked options; this stays one approach','Read logs\nand retained their context'];
  row=await h.journal().saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,attemptedApproaches:approaches,values:{...row.content.values,scope:'Only inspect the selected export'}}});
  const final=await flow.prepareDraft({draftId:row.id,draftRevision:row.revision});
  assert.equal(first.assistanceId,final.assistanceId);assert.notEqual(first.payloadJson,final.payloadJson);
  assert.equal(JSON.parse(final.payloadJson).scope,'Only inspect the selected export');assert.equal(JSON.parse(final.intentJson).visibility,'Private');assert.deepEqual(JSON.parse(final.intentJson).viewers,[]);
  assert.equal(JSON.parse(final.payloadJson).collaboration,'open-assistance');assert.equal('budget' in JSON.parse(final.payloadJson),false);assert.equal('qualification' in JSON.parse(final.payloadJson),false);
  await assert.rejects(flow.execute(first,first.confirmation),/confirmation/);assert.equal(h.signed.length,0);
  h.fail('after');await assert.rejects(flow.execute(final,final.confirmation),/Lost acknowledgement/);
  assert.equal(h.signed.length,1);assert.equal(h.writes(),1);assert.equal((await h.journal().getDraft(row.id)).status,'prepared');
  const original=await h.journal().get(final.eventId);assert.equal(original.payloadJson,final.payloadJson);assert.equal(original.status,'unknown');
  const resumed=h.flow();assert.equal((await resumed.reconcile(final.eventId)).state,'acknowledged');
  const actual=(await h.f.assistance.get(h.f.actor,final.assistanceId)).request;assert.equal(h.writes(),1);assert.equal(h.signed.length,1);assert.equal(actual.scope,'Only inspect the selected export');assert.deepEqual(actual.attemptedApproaches,approaches);
  await assert.rejects(resumed.prepareRetry(final.eventId),/acknowledged/);
});

test('editable preview rejects concurrent revision, owner and lease changes before signing or freezing another operation',async t=>{
  const h=await fixture(t),flow=h.flow();let row=await requestDraft(h);
  const stale=await flow.prepareDraft({draftId:row.id,draftRevision:row.revision});
  row=await h.journal().saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,values:{...row.content.values,scope:'A concurrent edit'}}});
  await assert.rejects(flow.execute(stale,stale.confirmation),/draft changed/);
  assert.equal(h.signed.length,0);assert.equal(h.writes(),0);assert.equal((await flow.list()).items.length,0);assert.equal((await h.journal().getDraft(row.id)).status,'editing');
  await assert.rejects(h.journal().previewRequestDraft({subjectId:'GUID'+'A'.repeat(28),id:row.id,expectedRevision:row.revision,now:h.f.now}),/identity unavailable/);
  const preview=await flow.prepareDraft({draftId:row.id,draftRevision:row.revision});h.sessions.close();
  await assert.rejects(flow.execute(preview,preview.confirmation),/authorization changed/);
  assert.equal(h.signed.length,0);assert.equal(h.writes(),0);assert.equal((await flow.list()).items.length,0);assert.equal((await h.journal().getDraft(row.id)).status,'editing');
});

test('a frozen historical compensation request retains its original bytes and same receipt after an unknown delivery',async t=>{
  const h=await fixture(t),flow=h.flow(),request={...h.request(),collaboration:'basic-bounty',budget:{mode:'fixed',amount:'12.50',unit:'external-unit'}};
  const preview=await flow.prepare({request});h.fail('after');await assert.rejects(flow.execute(preview,preview.confirmation),/Lost acknowledgement/);
  const resumed=h.flow();assert.equal((await resumed.reconcile(preview.eventId)).state,'acknowledged');
  const record=await h.journal().get(preview.eventId);assert.equal(record.payloadJson,preview.payloadJson);assert.deepEqual(JSON.parse(record.payloadJson).budget,request.budget);
  assert.deepEqual((await h.f.assistance.get(h.f.actor,preview.assistanceId)).request.budget,request.budget);assert.equal(h.writes(),1);
  await assert.rejects(resumed.prepareDraft({draftId:preview.eventId,draftRevision:1}));assert.equal(h.writes(),1);
});

test('Assistance request and event retries survive restart, preserve bytes, and recover a lost acknowledgement',async t=>{
  const h=await fixture(t);let flow=h.flow();const preview=await flow.prepare({request:h.request()});
  h.fail('after');await assert.rejects(flow.execute(preview,preview.confirmation),/Lost acknowledgement/);
  assert.equal((await h.journal().get(preview.eventId)).status,'unknown');
  await assert.rejects(h.journal().forget(preview.eventId),/Reconcile/);
  flow=h.flow();assert.equal((await flow.list()).items.length,1);
  const receipt=await flow.reconcile(preview.eventId);assert.equal(receipt.state,'acknowledged');assert.equal(receipt.version,1);
  await assert.rejects(flow.prepareRetry(preview.eventId),/acknowledged/);assert.equal(h.writes(),1);

  const event=await flow.prepare({assistanceId:preview.assistanceId,event:{kind:'cancel',reason:'No assistance needed'}});
  h.fail('before');await assert.rejects(flow.execute(event,event.confirmation),/Dropped/);
  flow=h.flow();const retry=await flow.prepareRetry(event.eventId);
  assert.equal(retry.payloadJson,event.payloadJson);assert.equal(retry.intentJson,event.intentJson);
  await flow.execute(retry,retry.confirmation);assert.equal((await flow.reconcile(event.eventId)).version,2);
  assert.equal((await h.f.assistance.get(h.f.actor,preview.assistanceId)).state,'canceled');
  assert.equal((await h.f.db.query('SELECT id FROM assistance_events WHERE assistance_id=$1',[preview.assistanceId])).rows.length,2);
  assert.equal(h.writes(),2);

  const other=await serviceFixture(['binding','consent','assistance'],h.f.db);
  await assert.rejects(other.assistance.receipt(other.actor,{assistanceId:preview.assistanceId,eventId:preview.eventId,payloadHash:receipt.payloadHash}),/not_found/);
  assert.equal((await h.f.assistance.receipt(h.f.actor,{assistanceId:preview.assistanceId,eventId:preview.eventId,payloadHash:'0'.repeat(64)})).state,'conflict');
  await h.f.consents.revoke(h.f.actor,JSON.parse(preview.intentJson).id);
  await assert.rejects(h.f.assistance.get(h.f.actor,preview.assistanceId));
  assert.equal((await flow.reconcile(preview.eventId)).state,'acknowledged','owner receipt is historical even after disclosure revocation');
  await flow.forget(preview.eventId);await flow.forget(event.eventId);assert.equal((await flow.list()).items.length,0);
});

test('Assistance recovery renews Consent on a new binding and refuses expired or superseded payloads',async t=>{
  const h=await fixture(t);let flow=h.flow();const preview=await flow.prepare({request:h.request()});
  h.fail('before');await assert.rejects(flow.execute(preview,preview.confirmation));
  const connection=createConnectionClient({endpoint:h.endpoint,trustedKeys:h.f.bindings.trustedKeys,now:()=>h.f.now,send:h.transport,
    sign:h.f.signForTest,assertCurrent:async()=>true});
  const connect=connection.prepare({subjectId:h.f.genesis.id,genesisProof:h.f.genesis.genesisProof,installationId:randomUUID(),scopes:h.f.actor.scopes});
  h.sessions.adopt(await connection.execute(connect,connect.confirmation));flow=h.flow();
  const renewed=await flow.prepareRetry(preview.eventId);
  assert.equal(renewed.payloadJson,preview.payloadJson);assert.notEqual(JSON.parse(renewed.intentJson).bindingId,JSON.parse(preview.intentJson).bindingId);
  // A previous in-flight write can win between the receipt read and a new attempt.
  await h.f.assistance.create(h.f.actor,{consentId:JSON.parse(preview.intentJson).id,payloadJson:preview.payloadJson});
  await assert.rejects(flow.execute(renewed,renewed.confirmation),/conflict/);
  assert.equal((await flow.reconcile(preview.eventId)).state,'acknowledged');

  const pending=await flow.prepare({assistanceId:preview.assistanceId,event:{kind:'cancel',reason:'Original cancel'}});
  const winner=await flow.prepare({assistanceId:preview.assistanceId,event:{kind:'cancel',reason:'Separate explicit action'}});
  await flow.execute(winner,winner.confirmation);
  await assert.rejects(flow.prepareRetry(pending.eventId),/version changed/);
  const expiring=await flow.prepare({request:{...h.request(),enrollmentExpiresAt:h.f.now+1}});
  const later=createAssistanceFlow({endpoint:h.endpoint,sessions:h.sessions,now:()=>h.f.now+2,journal:h.journal(),consentSend:h.transport,assistanceSend:h.transport,signIntent:h.f.signForTest});
  await assert.rejects(later.prepareRetry(expiring.eventId),/deadline expired/);
  const stored=await readFile(join(h.directory,'galaxy-local-state.json'),'utf8');
  assert.equal(stored.includes(h.f.credential),false);assert.equal(stored.includes('PRIVATE KEY'),false);
  assert.deepEqual(JSON.parse(stored).cases,[{id:'preserved-local-case'}]);
});

test('Assistance draft store persists partial fields, detects concurrent edits and freezes the exact request',async t=>{
  const h=await fixture(t),store=h.journal();let row=await store.createDraft();
  const content={...row.content,values:{...row.content.values,title:'Saved title'},index:2};
  row=await store.saveDraft({id:row.id,expectedRevision:row.revision,content});
  assert.deepEqual((await h.journal().getDraft(row.id)).content,content);
  await assert.rejects(store.saveDraft({id:row.id,expectedRevision:1,content}),/draft changed/);
  await assert.rejects(store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...content,rawContext:'not a draft field'}}));
  const elsewhere=createLocalAssistanceStore({dataDirectory:h.directory,endpoint:'https://other.example'});
  assert.equal((await elsewhere.listDrafts()).items.length,0);
  const preview=await h.flow().prepare({draftId:row.id,draftRevision:row.revision,request:{...h.request(),id:row.id}});
  assert.equal((await h.journal().getDraft(row.id)).status,'prepared');
  await assert.rejects(store.saveDraft({id:row.id,expectedRevision:row.revision+1,content}),/draft changed/);
  await assert.rejects(store.forgetDraft(row.id),/saved operation/);
  const retry=await h.flow().prepareRetry(preview.eventId);assert.equal(retry.payloadJson,preview.payloadJson);
  await h.flow().forget(preview.eventId);assert.equal((await store.listDrafts()).items.length,0);
  const closed=createLocalAssistanceStore({dataDirectory:h.directory,endpoint:h.endpoint,assertOpen:()=>false});
  await assert.rejects(closed.createDraft(),/identity unavailable/);
});

test('Assistance client rejects a mismatched acknowledgement lookup',async t=>{
  const h=await fixture(t),client=createAssistanceClient({endpoint:h.endpoint,sessions:h.sessions,send:async()=>({state:'acknowledged',eventId:randomUUID()})});
  await assert.rejects(client.receipt({eventId:randomUUID(),assistanceId:randomUUID(),payloadHash:'a'.repeat(64)}),/Invalid Assistance receipt/);
});

test('durable selection, scope and cancellation drafts preserve human choice through real multi-party API events',async t=>{
  const h=await fixture(t),store=h.journal();let flow=h.flow();
  const preview=await flow.prepare({request:h.request()});await flow.execute(preview,preview.confirmation);
  const id=preview.assistanceId,p=await serviceFixture(['binding','consent','assistance'],h.f.db);
  async function provider(kind,fields={}){
    const current=await h.f.assistance.get(h.f.actor,id),event={kind,id:randomUUID(),expectedVersion:current.version,...fields};
    await p.assistance.submit(p.actor,id,await p.authorize({assistanceId:id,event},'assistance.publish',{objectId:event.id,viewers:[h.f.actor.subjectId]}));
    return event;
  }
  const offer=await provider('offer',{proposal:'Inspect compiler',scope:'Selected diagnostics'});
  const shortlist=await store.createEventDraft({record:await h.f.assistance.get(h.f.actor,id),eventKind:'shortlist',target:{offerIds:[offer.id]}});
  // Another requester's explicit event makes the saved version stale.
  const invite=await flow.prepare({assistanceId:id,event:{kind:'invite',participantId:p.actor.subjectId,note:'Consider this request'}});
  await flow.execute(invite,invite.confirmation);
  await assert.rejects(flow.prepare({draftId:shortlist.id,draftRevision:shortlist.revision,assistanceId:id,event:{kind:'shortlist'}}),/version or draft changed/);
  let row=await store.rebaseDraft({id:shortlist.id,expectedRevision:shortlist.revision,record:await h.f.assistance.get(h.f.actor,id)});
  const submit=async draft=>{
    const preview=await flow.prepare({draftId:draft.id,draftRevision:draft.revision,assistanceId:id,event:{kind:draft.content.eventKind}});
    assert.equal(preview.eventId,draft.id);await flow.execute(preview,preview.confirmation);return preview;
  };
  await submit(row);
  row=await store.createEventDraft({record:await h.f.assistance.get(h.f.actor,id),eventKind:'select',target:{offerId:offer.id}});
  await submit(row);assert.equal((await h.f.assistance.get(h.f.actor,id)).state,'awaiting-confirmation');
  await provider('confirm');
  row=await store.createEventDraft({record:await h.f.assistance.get(h.f.actor,id),eventKind:'change-scope'});
  row=await store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,values:{scope:'Selected diagnostics and patch proposal'},index:1}});
  flow=h.flow();row=await h.journal().getDraft(row.id);
  row=await store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,values:{...row.content.values,reason:'Requester proposed extension'},step:'review',index:0}});
  await submit(row);assert.equal((await h.f.assistance.get(h.f.actor,id)).agreedScope,'Selected diagnostics');
  await provider('confirm-scope');assert.equal((await h.f.assistance.get(h.f.actor,id)).agreedScope,'Selected diagnostics and patch proposal');
  row=await store.createEventDraft({record:await h.f.assistance.get(h.f.actor,id),eventKind:'cancel'});
  row=await store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,values:{reason:'User ended collaboration'},step:'review'}});
  const cancel=await flow.prepare({draftId:row.id,draftRevision:row.revision,assistanceId:id,event:{kind:'cancel'}});
  h.fail('after');await assert.rejects(flow.execute(cancel,cancel.confirmation),/Lost acknowledgement/);
  flow=h.flow();assert.equal((await flow.reconcile(cancel.eventId)).state,'acknowledged');
  const current=await h.f.assistance.get(h.f.actor,id);assert.equal(current.state,'canceled');assert.equal(current.paymentExecuted,false);assert.equal(current.contextAccessGranted,false);
  assert.equal((await h.f.db.query('SELECT id FROM assistance_events WHERE id=$1',[cancel.eventId])).rows.length,1);
});
