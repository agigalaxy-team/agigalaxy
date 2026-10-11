import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import {digest} from '../src/shared/digest.mjs';
import {chatSendSchema} from '../src/shared/chat-schema.mjs';
import {chatFixture,invite} from './chat-workflow.mjs';

test('an exact original ordinary-message receipt survives a lost reply and departure without reading or sending',async()=>{
 let sends=0,reads=0;const f=await chatFixture({transport:{available:true,project:async()=>{},send:async input=>{sends++;return{archiveId:input.messageId};},read:async()=>{reads++;return[];}}});
 try{const[a,b,c]=f.people,roomId=randomUUID();await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic ordinary message receipt'});await invite(f.chat,a,roomId,b);
  const input={clientMessageId:randomUUID(),text:'Original private ordinary message'},query={clientMessageId:input.clientMessageId,requestHash:digest(canonicalize(chatSendSchema.parse(input)))};
  await assert.rejects((async()=>{await f.chat.send(b,roomId,input);throw new Error('lost_reply_after_commit');})(),/lost_reply_after_commit/);
  await f.chat.leave(b,roomId);await assert.rejects(f.chat.messageStatus(b,roomId,{clientMessageId:input.clientMessageId}),/chat_access_denied/);
  const before={sends,reads},receipt=await f.chat.messageStatus(b,roomId,query);assert.equal(receipt.state,'accepted');assert.equal(receipt.acceptedByRoom,true);assert.equal(receipt.currentAccessGranted,false);assert.equal(receipt.contentReturned,false);assert.equal(receipt.othersReadStatus,'not-asserted');
  assert.equal(JSON.stringify(receipt).includes(input.text),false);assert.deepEqual({sends,reads},before);
  assert.equal((await f.chat.messageStatus(c,roomId,query)).state,'absent');assert.equal((await f.chat.messageStatus(b,roomId,{...query,requestHash:'0'.repeat(64)})).state,'conflict');
  assert.equal((await f.chat.messageStatus(b,roomId,{...query,clientMessageId:randomUUID()})).state,'absent');
 }finally{await f.close();}
});

test('an unknown external transport result remains pending in an exact receipt after departure',async()=>{
 let sends=0;const f=await chatFixture({transport:{available:true,project:async()=>{},send:async()=>{sends++;throw new Error('synthetic_unacknowledged_transport');}}});
 try{const[a,b]=f.people,roomId=randomUUID();await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic unknown room send'});await invite(f.chat,a,roomId,b);
  const input={clientMessageId:randomUUID(),text:'Unknown transport acceptance'},query={clientMessageId:input.clientMessageId,requestHash:digest(canonicalize(chatSendSchema.parse(input)))};
  await assert.rejects(f.chat.send(b,roomId,input),/synthetic_unacknowledged_transport/);await f.chat.leave(b,roomId);
  const receipt=await f.chat.messageStatus(b,roomId,query);assert.equal(receipt.state,'pending');assert.equal(receipt.acceptedByRoom,false);assert.equal(receipt.historicalAcceptanceRecorded,false);assert.equal(sends,1);
 }finally{await f.close();}
});
