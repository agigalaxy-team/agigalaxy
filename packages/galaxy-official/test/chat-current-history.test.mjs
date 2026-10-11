import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chatFixture,invite} from './chat-workflow.mjs';

test('current conversation opens newest authorized messages and pages backward without marking either cursor',async()=>{
 const stored=new Map(),transport={available:true,project:async()=>{},send:async input=>{stored.set(input.messageId,input);return{archiveId:input.messageId};},
  read:async input=>input.ids.map(id=>({archiveId:id,text:stored.get(id).text})),erase:async()=>({archiveDeleted:true})};
 const f=await chatFixture({transport});try{
  const [a,b,c]=f.people,roomId=randomUUID(),otherRoom=randomUUID();
  await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Current conversation'});
  await f.chat.create(a,{roomId:otherRoom,operationId:randomUUID(),title:'Independent sequence gaps'});
  await invite(f.chat,a,roomId,b);
  const sent=[];
  for(let n=0;n<6;n++){
   sent.push(await f.chat.send(a,roomId,{clientMessageId:randomUUID(),text:'Message '+n}));
   await f.chat.send(a,otherRoom,{clientMessageId:randomUUID(),text:'Other room '+n});
  }
  await assert.rejects(f.chat.history(c,roomId,{latest:true,limit:2}),/chat_access_denied/);
  const current=await f.chat.history(b,roomId,{latest:true,limit:2});
  assert.deepEqual(current.messages.map(item=>item.text),['Message 4','Message 5']);
  assert.equal(current.next,null);assert.equal(current.previous,current.messages[0].sequence);
  assert.equal(current.after,String(BigInt(current.messages[0].sequence)-1n));
  assert.equal(current.scannedThrough,current.messages.at(-1).sequence);
  const earlier=await f.chat.history(b,roomId,{latest:true,before:current.previous,limit:2});
  assert.deepEqual(earlier.messages.map(item=>item.text),['Message 2','Message 3']);
  const oldest=await f.chat.history(b,roomId,{latest:true,before:earlier.previous,limit:2});
  assert.deepEqual(oldest.messages.map(item=>item.text),['Message 0','Message 1']);assert.equal(oldest.previous,null);
  assert.equal((await f.db.query('SELECT * FROM chat_cursors WHERE room_id=$1',[roomId])).rows.length,0);
  assert.deepEqual((await f.chat.history(b,roomId,{after:current.after,limit:2})).messages.map(item=>item.messageId),current.messages.map(item=>item.messageId));
  await f.chat.hide(b,roomId,sent[5].messageId);
  assert.deepEqual((await f.chat.history(b,roomId,{latest:true,limit:2})).messages.map(item=>item.text),['Message 4']);
  await f.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[sent[4].messageId,new Date((f.now()-1)*1000).toISOString()]);
  const unavailable=await f.chat.history(b,roomId,{latest:true,limit:2});assert.deepEqual(unavailable.messages,[]);assert.equal(unavailable.previous,current.previous);
  await assert.rejects(f.chat.history(b,roomId,{latest:true,after:'1'}),/invalid_chat_request/);
  await assert.rejects(f.chat.history(b,roomId,{before:current.previous}),/invalid_chat_request/);
 }finally{await f.close();}
});
