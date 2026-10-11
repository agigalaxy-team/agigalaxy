import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ProsodyChatTransport} from '../src/infrastructure/prosody-chat.mjs';
import {chatFixture,invite} from './chat-workflow.mjs';

test('real stable Prosody persists, corrects and erases Galaxy messages through private MUC/MAM',{timeout:60000},async()=>{
 assert.equal(process.env.GALAXY_TEST_CHAT_ISOLATED,'1','Explicit isolated Prosody profile required');
 const transport=new ProsodyChatTransport({service:process.env.GALAXY_TEST_CHAT_SERVICE??'xmpp://127.0.0.1:5347',domain:'gateway.galaxy.internal',roomsDomain:'rooms.galaxy.internal',
  secret:(await readFile(process.env.GALAXY_TEST_CHAT_SECRET_FILE,'utf8')).trim()});
 await transport.start();const f=await chatFixture({transport});const rooms=[];
 try{const{chat,people:[a,b,c]}=f,roomId=randomUUID();rooms.push(roomId);await chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic real transport'});await invite(chat,a,roomId,b);
  const input={clientMessageId:randomUUID(),text:'original transport content'},first=await chat.send(a,roomId,input);assert.equal(first.acceptedByRoom,true);
  assert.equal((await chat.send(a,roomId,input)).messageId,first.messageId);const h=await chat.history(b,roomId);assert.equal(h.messages[0].text,input.text);assert.equal(h.messages.length,1);
  const projected=await chat.get(b,roomId),metadataInput={roomId,subjectId:b.subjectId,ids:[first.archiveId],roomRevision:projected.revision};
  const rawMetadata=await transport.command('read',{...metadataInput,metadataOnly:true});
  assert.deepEqual(rawMetadata.messages,[{archiveId:first.archiveId,revision:1}],'The current isolated component returns no body in a metadata-only reply');
  assert.deepEqual(await transport.readMetadata(metadataInput),rawMetadata.messages);
  await assert.rejects(chat.history(c,roomId),/access_denied/);
  const edit={operationId:randomUUID(),expectedRevision:1,text:'corrected transport content'};await chat.edit(a,roomId,first.messageId,edit);await chat.edit(a,roomId,first.messageId,edit);
  assert.equal((await chat.history(b,roomId)).messages[0].text,edit.text);
  const own=await chat.exportOwned(a);assert.equal(own.messages[0].text,edit.text);assert.equal((await chat.exportOwned(b)).messages.length,0);
  await transport.stop();await transport.start();assert.equal((await chat.history(b,roomId)).messages[0].text,edit.text);
  await chat.retract(a,roomId,first.messageId);assert.equal((await chat.history(b,roomId)).messages[0].text,null);
  assert.equal((await transport.exportOwn({roomId,subjectId:a.subjectId,ids:[first.archiveId]})).length,0,'Original body physically removed from MAM');
  await assert.rejects(transport.send({roomId,subjectId:a.subjectId,messageId:first.messageId,text:input.text,payloadHash:'delayed',sentAt:new Date(first.sentAt).toISOString(),expiresAt:new Date(first.expiresAt).toISOString(),roomRevision:(await chat.get(a,roomId)).revision}),/erased/);
  const second=await chat.send(a,roomId,{clientMessageId:randomUUID(),text:'member-only content'});await chat.leave(b,roomId);await assert.rejects(chat.history(b,roomId),/access_denied/);
  const erased=await chat.eraseSubject(a.subjectId);assert.equal(erased.complete,true);assert.equal((await transport.exportOwn({roomId,subjectId:a.subjectId,ids:[second.archiveId]})).length,0);
  console.log(JSON.stringify({event:'chat_real_prosody_verified',transport:'Prosody MUC delivery/MAM archive API',bodyPersistence:true,edit:true,physicalErase:true,metadataDatabase:'PGlite',website:false}));
 }finally{await f.close();await transport.stop();}
});
