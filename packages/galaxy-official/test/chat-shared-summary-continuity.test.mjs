import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import {digest} from '../src/shared/digest.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {ChatSharedSummaryService} from '../src/chat-shared-summaries.mjs';
import {createChatSharedSummaryClient,sharedSummaryRequestHash,prepareRoomSummaryShare} from '../src/chat-shared-summary-client.mjs';
import {chatFixture,invite} from './chat-workflow.mjs';

async function fixture(){
 const bodies=new Map();let sends=0,reads=0,erases=0,sendUnknown=false,eraseAck=true;
 const transport={available:true,project:async()=>{},send:async input=>{sends++;bodies.set(input.messageId,{archiveId:input.messageId,text:input.text,revision:1});if(sendUnknown)throw new ServiceError('chat_delivery_unknown',504);return{archiveId:input.messageId};},
  read:async input=>{reads++;return input.ids.flatMap(id=>bodies.has(id)?[bodies.get(id)]:[]);},erase:async input=>{erases++;if(eraseAck===undefined)return{};if(!eraseAck)return{archiveDeleted:false};bodies.delete(input.messageId);return{archiveDeleted:true};}};
 const f=await chatFixture({transport}),shared=new ChatSharedSummaryService({db:f.db,access:f.chat.access,chat:f.chat,now:f.now}),[a,b,c]=f.people,roomId=randomUUID();
 await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic ordinary sharing continuity'});await invite(f.chat,a,roomId,b);
 const request=()=>({shareId:randomUUID(),roomId,expectedMemberRevision:2,audience:'room-authorized-members',content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:false},fragments:[{id:randomUUID(),kind:'personal-note',text:'Selected private note',sourceRefs:[]}],keyMessageRefs:[]}});
 return{...f,shared,a,b,c,roomId,request,bodies,counts:()=>({sends,reads,erases}),unknown:value=>{sendUnknown=value;},eraseAck:value=>{eraseAck=value;}};
}

test('an owned exact shared-version receipt survives leaving without restoring source access or resending',async()=>{
 const f=await fixture();try{const request=f.request(),query={roomId:f.roomId,shareId:request.shareId,requestHash:digest(canonicalize(request))};
  const published=await f.shared.publish(f.b,request);await f.chat.leave(f.b,f.roomId);
  assert.throws(()=>f.shared.get(f.b,query),/invalid_shared_summary_request/);
  await assert.rejects(f.shared.get(f.b,{roomId:f.roomId,shareId:request.shareId}),/chat_access_denied/);
  const before=f.counts(),receipt=await f.shared.receipt(f.b,query);
  assert.equal(receipt.state,'published');assert.equal(receipt.acceptedByRoom,true);assert.equal(receipt.messageId,published.messageId);assert.equal(receipt.currentAccessGranted,false);assert.equal(receipt.othersReadStatus,'not-asserted');assert.equal(Object.hasOwn(receipt,'readByOthers'),false);
  assert.equal(Object.hasOwn(receipt,'content'),false);assert.equal(Object.hasOwn(receipt,'sourceFacts'),false);assert.equal(JSON.stringify(receipt).includes(request.content.fragments[0].text),false);assert.deepEqual(f.counts(),before);
  assert.equal((await f.shared.receipt(f.c,query)).state,'absent');assert.equal((await f.shared.receipt(f.c,{...query,requestHash:'0'.repeat(64)})).state,'absent');
  assert.equal((await f.shared.receipt(f.b,{...query,requestHash:'0'.repeat(64)})).state,'conflict');assert.equal((await f.shared.receipt(f.b,{...query,roomId:randomUUID()})).state,'conflict');
  assert.equal((await f.shared.receipt(f.b,{...query,shareId:randomUUID()})).state,'absent');
 }finally{await f.close();}
});

test('source withdrawal, lost room permission and expiry retain only the original owned operation evidence',async()=>{
 const f=await fixture();try{const source=await f.chat.send(f.a,f.roomId,{clientMessageId:randomUUID(),text:'Independent source body'}),request=f.request(),ref={messageId:source.messageId,revision:1};
  request.content.fragments[0]={...request.content.fragments[0],kind:'derived',sourceRefs:[ref]};request.content.keyMessageRefs=[ref];
  const query={roomId:f.roomId,shareId:request.shareId,requestHash:await sharedSummaryRequestHash(request)};
  await f.shared.publish(f.b,request);await f.chat.retract(f.a,f.roomId,source.messageId);await f.shared.purgeInvalidSources();
  assert.equal((await f.shared.get(f.b,{roomId:f.roomId,shareId:request.shareId})).content.fragments.length,0);
  await assert.rejects(f.shared.retract(f.a,{roomId:f.roomId,shareId:request.shareId}),/shared_summary_author_required/);
  await f.chat.leave(f.b,f.roomId);await assert.rejects(f.shared.retract(f.b,{roomId:f.roomId,shareId:request.shareId}),/chat_access_denied/);
  const before=f.counts(),receipt=await f.shared.receipt(f.b,query);assert.equal(receipt.state,'published');assert.equal(receipt.contentReturned,false);assert.equal(receipt.othersReadStatus,'not-asserted');assert.deepEqual(f.counts(),before);
  await f.db.query('UPDATE room_shared_summaries SET created_at=$2,expires_at=$3 WHERE share_id=$1',[request.shareId,new Date((f.now()-10)*1000).toISOString(),new Date((f.now()-1)*1000).toISOString()]);
  const stored=(await f.db.query('SELECT state,expires_at FROM room_shared_summaries WHERE share_id=$1',[request.shareId])).rows[0];assert.equal(stored.state,'published');
  const expired=await f.shared.receipt(f.b,query);assert.equal(expired.state,'expired');assert.equal(expired.acceptedByRoom,false);assert.equal(expired.historicalAcceptanceRecorded,true);assert.equal(expired.noticeCleanupState,'not-requested');
  assert.deepEqual(f.counts(),before);assert.deepEqual((await f.db.query('SELECT state,expires_at FROM room_shared_summaries WHERE share_id=$1',[request.shareId])).rows[0],stored,'Read-only receipt does not extend TTL or claim maintenance already erased the archive');
 }finally{await f.close();}
});

test('share preparation binds the selected original request and the client rejects body or conflicting acceptance projections',async()=>{
 const f=await fixture();try{const request=f.request(),summaryId=randomUUID(),local={get:async()=>({summaryId,roomId:f.roomId,localRevision:4,content:structuredClone(request.content)})};
  const prepared=await prepareRoomSummaryShare({local,summaryId,expectedLocalRevision:4,fragmentIds:request.content.fragments.map(x=>x.id),keyMessageRefs:[],room:{roomId:f.roomId,memberRevision:2},shareId:request.shareId});
  assert.equal(prepared.requestHash,digest(canonicalize(prepared.request)));assert.deepEqual(prepared.request,request);
  await f.shared.publish(f.b,request);const query={roomId:f.roomId,shareId:request.shareId,requestHash:prepared.requestHash},good=await f.shared.receipt(f.b,query);
  let response=good;const calls=[],client=createChatSharedSummaryClient({call:async(path,input)=>{calls.push({path,input});return response;}});
  assert.deepEqual(await client.receipt(query),good);assert.equal(calls[0].path,'/v2/chat/shared-summaries/receipt');
  response={...good,content:request.content};await assert.rejects(client.receipt(query),/Unrecognized key/);
  response={...good,acceptedByRoom:false};await assert.rejects(client.receipt(query),/Room acceptance must match/);
  response={...good,requestHash:'0'.repeat(64)};await assert.rejects(client.receipt(query),/shared_summary_receipt_mismatch/);
  response={...good,state:'absent',acceptedByRoom:false};await assert.rejects(client.receipt(query),/cannot disclose operation metadata/);
 }finally{await f.close();}
});

test('pending publication and partial retraction do not become a delivered or physically deleted receipt',async()=>{
 const f=await fixture();try{const request=f.request(),query={roomId:f.roomId,shareId:request.shareId,requestHash:digest(canonicalize(request))};
  f.unknown(true);await assert.rejects(f.shared.publish(f.b,request),/chat_delivery_unknown/);
  const pending=await f.shared.receipt(f.b,query);assert.equal(pending.state,'pending');assert.equal(pending.acceptedByRoom,false);assert.equal(pending.messageState,'pending');
  f.unknown(false);await f.shared.publish(f.b,request);f.eraseAck(false);
  const result=await f.shared.retract(f.b,{roomId:f.roomId,shareId:request.shareId});assert.equal(result.retracted,true);assert.equal(result.noticeArchiveDeleted,false);assert.equal(result.noticeCleanupPending,true);
  await f.chat.leave(f.b,f.roomId);const before=f.counts(),receipt=await f.shared.receipt(f.b,query);
  assert.equal(receipt.state,'retracted');assert.equal(receipt.messageState,'retracted');assert.equal(receipt.noticeCleanupState,'pending');assert.equal(receipt.acceptedByRoom,false);assert.deepEqual(f.counts(),before,'Receipt never invokes the external transport');
  assert.equal((await f.db.query('SELECT purge_pending FROM chat_message_refs WHERE message_id=$1',[receipt.messageId])).rows[0].purge_pending,true);
  f.eraseAck(true);const retried=await f.shared.retract(f.b,{roomId:f.roomId,shareId:request.shareId});assert.equal(retried.noticeArchiveDeleted,true);assert.equal(retried.noticeCleanupPending,false);
  assert.equal((await f.shared.receipt(f.b,query)).noticeCleanupState,'recorded-complete');assert.equal(f.bodies.has(receipt.messageId),false);
 }finally{await f.close();}
});

for(const acknowledgement of [false,undefined])test(`archive cleanup keeps the original target pending after ${acknowledgement===false?'negative':'missing'} erase acknowledgement`,async()=>{
 const f=await fixture();try{const message=await f.chat.send(f.b,f.roomId,{clientMessageId:randomUUID(),text:'Owned notice cleanup fixture'});f.eraseAck(acknowledgement);
  const result=await f.chat.retract(f.b,f.roomId,message.messageId);assert.equal(result.retracted,true);assert.equal(result.archiveDeleted,false);assert.equal(result.purgePending,true);
  assert.equal((await f.db.query('SELECT purge_pending FROM chat_message_refs WHERE message_id=$1',[message.messageId])).rows[0].purge_pending,true);assert.equal(f.bodies.has(message.messageId),true);
  f.eraseAck(true);await f.chat.purgeOne(message.messageId);assert.equal((await f.db.query('SELECT purge_pending FROM chat_message_refs WHERE message_id=$1',[message.messageId])).rows[0].purge_pending,false);assert.equal(f.bodies.has(message.messageId),false);
 }finally{await f.close();}
});
