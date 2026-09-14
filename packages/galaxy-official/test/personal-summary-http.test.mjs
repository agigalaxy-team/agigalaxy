import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createPersonalSummaryClient,createNotificationInboxClient} from '../src/personal-summary-client.mjs';
import {invite} from './chat-workflow.mjs';
test('current authenticated HTTP entry reaches private summaries and the independent inbox',async()=>{
 const f=await serviceFixture(['binding','notifications']),peer=await serviceFixture(['binding','notifications'],f.db,{migrateDatabase:false});
 const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 try{
  // Explicit transport/account fixtures isolate M14 entry wiring. They are not
  // evidence for OIDC, message delivery or a real room populated with users.
  f.chat.requireAccountWithin=async()=>{};f.chat.consumeInviteWithin=async()=>{};f.chat.markInviteRespondedWithin=async()=>{};
  f.chat.transport={available:true,project:async()=>{},send:async x=>({archiveId:x.messageId})};
  const roomId=randomUUID();await f.chat.create(f.actor,{roomId,operationId:randomUUID(),title:'HTTP notification fixture'});await invite(f.chat,f.actor,roomId,peer.actor);
  const sent=await f.chat.send(f.actor,roomId,{clientMessageId:randomUUID(),text:'Private shared message fixture'});
  const origin='http://127.0.0.1:'+api.address().port;
  const callFor=credential=>async(path,input)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential},body:JSON.stringify(input)});
   const body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),{status:response.status});return body;};
  const call=callFor(peer.credential),client=createPersonalSummaryClient({call}),notifications=createNotificationInboxClient({call});
  const pref=await client.savePreference({expectedRevision:0,endpoint:f.bindings.endpoint,enabled:true});
  const x={versionId:randomUUID(),summaryId:randomUUID(),roomId,preferenceRevision:pref.revision,baseRevision:0,content:{generator:{kind:'manual'},
   coverage:{fromSequence:'0',throughSequence:'1',complete:false},fragments:[{id:randomUUID(),kind:'derived',text:'A selected personal summary',sourceRefs:[{messageId:sent.messageId,revision:1}]}],keyMessageRefs:[]}};
  const stored=await client.put(x);assert.equal(stored.audience,'owner-only');assert.equal(stored.sharedToRoom,false);
  const other=createPersonalSummaryClient({call:callFor(f.credential)});assert.equal((await other.get({summaryId:x.summaryId})).current,null);
  await assert.rejects(client.put({...x,subjectId:f.actor.subjectId}),/invalid_personal_summary/);
  assert.equal((await client.sources({roomId,refs:[{messageId:sent.messageId,revision:1}]})).items[0].available,true);
  const item=(await notifications.query()).items.find(i=>i.id==='room-message:'+sent.messageId);assert(item);assert.equal(item.read,false);
  const claim={id:item.id,deliveryClientId:randomUUID(),claimId:randomUUID()};assert.equal((await notifications.claim(claim)).claimed,true);
  assert.equal((await notifications.presented(claim)).presented,true);assert.equal((await notifications.query()).items.find(i=>i.id===item.id).read,false);
  await notifications.markRead({id:item.id,reader:'human'});assert.equal((await notifications.query()).items.find(i=>i.id===item.id).read,true);
 }finally{await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
