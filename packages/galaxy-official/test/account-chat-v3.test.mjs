import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {chatFixture} from './chat-workflow.mjs';
import {chatActorRef} from '../src/chat-actors.mjs';
import {chatHttpActor} from '../src/adapters/http/chat-http.mjs';

test('account-only chat preserves invitations, group consent, messages, files and current source access without creating identities',async t=>{
 const f=await accountChatFixture();t.after(f.close);const[a,b,c]=f.people,roomId=await joinAccountConversation(f,a,b);
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM subjects')).rows[0].n),0);
 assert.equal((await f.chat.people(a,{query:'乙'})).items.length,0,'private account is not globally searchable');
 assert.equal((await f.chat.people(a,{accountId:b.accountId})).items[0].actorRef,chatActorRef(b),'a known exact recipient can be invited');
 assert.equal((await f.publicWrites.status(a)).quotas.find(item=>item.category==='invitation').used,1,'real account invitation quota is retained');
 await assert.rejects(f.chat.history(c,roomId),/chat_access_denied/);
 const original={clientMessageId:randomUUID(),text:'一起讨论的原文'},sent=await f.chat.send(a,roomId,original);
 assert.equal((await f.chat.send(a,roomId,original)).messageId,sent.messageId);
 const history=await f.chat.history(b,roomId);assert.equal(history.messages[0].text,original.text);assert.equal(history.messages[0].actor.kind,'official-account');
 await f.chat.cursor(b,roomId,{kind:'human',sequence:history.messages[0].sequence,visibleMessageIds:[sent.messageId]});
 assert.equal((await f.db.query('SELECT message_id FROM chat_human_message_reads WHERE room_id=$1 AND subject_id=$2',[roomId,chatActorRef(b)])).rows[0].message_id,sent.messageId);
 assert.equal((await f.chat.directory(a,{query:'乙'})).rooms[0].roomId,roomId,'member-name search is restricted to the current participant’s rooms');
 assert.equal((await f.chat.directory(c,{query:'乙'})).rooms.length,0);
 const reply=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'原文回应',replyTo:sent.messageId});
 assert.equal((await f.chat.messageContext(a,roomId,reply.messageId)).target.replyTo,sent.messageId);
 const reference={kind:'chat-message',roomId,messageId:sent.messageId};
 assert.equal((await f.chat.readBookmarkWithin(f.db,b,reference)).state,'available');
 await f.chat.hide(b,roomId,sent.messageId);assert.equal((await f.chat.readBookmarkWithin(f.db,b,reference)).state,'unavailable');
 const current=await f.chat.get(a,roomId),decisionId=randomUUID();
 await f.chat.proposeDecision(a,roomId,{decisionId,expectedRevision:current.revision,action:'invite',targetSubjectId:chatActorRef(c)});
 await assert.rejects(f.chat.acceptInvite(c,roomId,{decisionId}),/chat_decision_unavailable/);
 await f.chat.voteDecision(b,roomId,{decisionId,choice:'approve'});await f.chat.acceptInvite(c,roomId,{decisionId});
 assert.equal((await f.chat.get(c,roomId)).members.length,3);
 const bytes=Buffer.from('选定的临时文件\n'),file={attachmentId:randomUUID(),roomId,name:'讨论材料.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes),purpose:'temporary-room-attachment',confirmed:true};
 await f.files.prepare(a,file);await f.files.upload(a,file.attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await f.files.scanPending();
 await assert.rejects(f.files.content(b,{attachmentId:file.attachmentId}),error=>error.code==='attachment_unavailable');
 const fileMessage=await f.chat.send(a,roomId,{clientMessageId:randomUUID(),text:'',attachments:[{id:file.attachmentId,sha256:file.sha256}]});
 assert.deepEqual((await f.files.content(b,{attachmentId:file.attachmentId})).bytes,bytes);
 assert.equal((await f.chat.readBookmarkWithin(f.db,b,{kind:'chat-message',roomId,messageId:fileMessage.messageId})).state,'available');
 await f.chat.retract(a,roomId,fileMessage.messageId);await assert.rejects(f.files.content(b,{attachmentId:file.attachmentId}),/attachment_message_unavailable/);
 await f.chat.leave(b,roomId);await assert.rejects(f.chat.history(b,roomId),/chat_access_denied/);
 assert.equal((await f.chat.readBookmarkWithin(f.db,b,reference)).state,'unavailable');
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM subjects')).rows[0].n),0);
});

test('an account association never grants the account an ID room, and unlinked IDs cannot send new content',async t=>{
 const legacy=await chatFixture(),f=await accountChatFixture({identityFixture:legacy});t.after(f.close);const actor=legacy.people[0],account=f.people[0],linkId=randomUUID(),stamp=new Date(f.now()*1000).toISOString();
 // Synthetic already-accepted association rows exercise current registry state;
 // the OIDC callback and device signature protocol have separate tests.
 await f.db.query(`INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature,created_at)
  VALUES($1,$2,$3,$4,'synthetic','https://login.example.org','synthetic-0','synthetic-chat','{}',$5,'synthetic-accepted-fixture',$6)`,[linkId,actor.subjectId,actor.bindingId,f.endpoint,'0'.repeat(64),stamp]);
 await f.db.query('INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4)',[linkId,account.accountId,actor.subjectId,stamp]);
 const roomId=randomUUID();await f.chat.create(actor,{roomId,operationId:randomUUID(),title:'真实 ID 归属的原对话'});
 const input={clientMessageId:randomUUID(),text:'原有 ID 的消息'},sent=await f.chat.send(actor,roomId,input);
 await assert.rejects(f.chat.get(account,roomId),/chat_access_denied/);
 await f.db.query('UPDATE external_identity_links SET revoked_at=$2 WHERE id=$1',[linkId,stamp]);
 await assert.rejects(f.chat.send(actor,roomId,{clientMessageId:randomUUID(),text:'关联已失效后的新消息'}),/account_verification_required/);
 assert.equal((await f.chat.messageStatus(actor,roomId,{clientMessageId:input.clientMessageId})).state,'accepted');
 assert.equal((await f.chat.retract(actor,roomId,sent.messageId)).retracted,true);
 assert.equal((await f.chat.leave(actor,roomId)).left,true);
});

test('chat HTTP never downgrades a supplied invalid ID credential into the ambient account cookie',async()=>{
 let cookieCalls=0;const access={authenticate:async()=>{throw Object.assign(Error('access_denied'),{code:'access_denied'});}},officialAccounts={actionActor:async()=>{cookieCalls++;return{kind:'official-account',accountId:randomUUID()};}};
 await assert.rejects(chatHttpActor({request:{headers:{authorization:'Bearer invalid'}},access,officialAccounts,requestId:randomUUID(),write:true}),/access_denied/);
 assert.equal(cookieCalls,0);
 const value=await chatHttpActor({request:{headers:{}},access,officialAccounts,requestId:randomUUID(),write:true});
 assert.equal(value.kind,'official-account');assert.equal(cookieCalls,1);
});
