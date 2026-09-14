import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ServiceError} from '../src/shared/service-error.mjs';
import {chatFixture,invite,verifyGovernance} from './chat-workflow.mjs';
import {ChatService} from '../src/chat.mjs';
import {CommunityAccountRegistry} from '../src/community-accounts.mjs';
import {subjectResourceUsage,defaultResourceBudgetPolicy} from '../src/infrastructure/resource-budgets.mjs';

test('persistent ordinary-room governance has no implicit creator ownership',async()=>verifyGovernance());
test('chat requires real verified account adapter at registration and cannot trust a caller claim',async()=>{
 const f=await chatFixture();try{const input={roomId:randomUUID(),operationId:randomUUID(),title:'Account condition'},actor=f.people[0];
  const registry=new CommunityAccountRegistry(f.chat.access,[]);
  const missing=new ChatService({db:f.db,access:f.chat.access,now:f.now});await assert.rejects(missing.create(actor,input),/account_adapter_unavailable/);
  const actual=new ChatService({db:f.db,access:f.chat.access,now:f.now,requireAccountWithin:(db,a)=>registry.resolveWithin(db,a),markInviteRespondedWithin:async()=>{}});
  await assert.rejects(actual.create({...actor,accountVerified:true},input),/account_verification_required/);
  assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM chat_rooms')).rows[0].n),0);
  await f.chat.create(actor,input);const decisionId=randomUUID();await f.chat.proposeDecision(actor,input.roomId,{decisionId,expectedRevision:1,action:'invite',targetSubjectId:f.people[1].subjectId});
  assert.equal((await actual.acceptInvite(f.people[1],input.roomId,{decisionId,accept:false})).state,'rejected','Declining does not force external registration');
 }finally{await f.close();}
});
test('message intents survive unknown delivery, expiry does not change and cursors remain distinct',async()=>{
 const calls=[];let lose=true;
 // Explicit transport contract double: verifies PostgreSQL orchestration only.
 // Real Prosody storage/delivery has a separate required integration test.
 const transport={available:true,project:async()=>{},send:async x=>{calls.push(x);if(lose){lose=false;throw new ServiceError('chat_delivery_unknown',504);}return{archiveId:x.messageId};},
  read:async x=>x.ids.map(id=>({archiveId:id,text:'body provided by transport fixture'})),edit:async()=>{},erase:async()=>{}};
 const f=await chatFixture({transport});try{const{chat,people:[a,b]}=f,roomId=randomUUID();await chat.create(a,{roomId,operationId:randomUUID(),title:'No task'});await invite(chat,a,roomId,b);
  const input={clientMessageId:randomUUID(),text:'a normal message'};await assert.rejects(chat.send(a,roomId,input),/delivery_unknown/);
  const pending=await chat.messageStatus(a,roomId,input);assert.equal(pending.state,'pending');
  const sent=await chat.send(a,roomId,input);assert.equal(sent.acceptedByRoom,true);assert.equal(sent.readByOthers,false);assert.equal(calls[0].messageId,calls[1].messageId);
  assert.equal(Number((await f.db.query('SELECT content_bytes FROM chat_message_refs WHERE message_id=$1',[sent.messageId])).rows[0].content_bytes),Buffer.byteLength(input.text));
  const usage=await subjectResourceUsage(f.db,a.subjectId,f.now());chat.access.resourceBudgetPolicy={...defaultResourceBudgetPolicy,maxPayloadBytesPerSubject:Number(usage.payloadBytes)};
  const callCount=calls.length;await assert.rejects(chat.send(a,roomId,{clientMessageId:randomUUID(),text:'new budgeted body'}),/storage_quota_exceeded/);assert.equal(calls.length,callCount,'Budget rejects before transport');
  chat.access.resourceBudgetPolicy=null;
  await assert.rejects(chat.send(a,roomId,{...input,text:'changed'}),/message_conflict/);
  const decisionId=randomUUID(),r=await chat.get(a,roomId);await chat.proposeDecision(a,roomId,{decisionId,expectedRevision:r.revision,action:'retention',retentionDays:7});await chat.voteDecision(b,roomId,{decisionId,choice:'approve'});
  assert.equal(new Date((await chat.messageStatus(a,roomId,input)).expiresAt).getTime(),new Date(sent.expiresAt).getTime());
  const next=await chat.send(a,roomId,{clientMessageId:randomUUID(),text:'new policy'});assert.equal(Date.parse(next.expiresAt)-Date.parse(next.sentAt),7*86400000);
  const history=await chat.history(b,roomId,{limit:1});assert.equal(history.messages.length,1);assert.ok(history.next);
  const deletionId=randomUUID();await f.db.query(`INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision)
   VALUES($1,$2,$3,'fixture-public-key','{}','fixture-hash','fixture-signature','requested',1)`,[deletionId,a.subjectId,a.bindingId]);
  assert.equal((await chat.history(b,roomId)).messages.length,0,'Pending author deletion hides other-user projection');
  assert.equal((await chat.history(a,roomId)).messages.length,2,'Owner can inspect retained data before deletion');
  await f.db.query("UPDATE deletion_requests SET state='cancelled' WHERE id=$1",[deletionId]);
  assert.equal((await chat.history(b,roomId)).messages.length,2,'Cancellation restores existing permission without new publication');
  const grantId=randomUUID();await chat.grantAgent(a,roomId,{grantId,bindingId:a.bindingId,mode:'read',expiresAt:f.now()+3600});
  await chat.cursor(a,roomId,{kind:'agent',sequence:history.messages[0].sequence,agentGrantId:grantId});
  const cursorRows=(await f.db.query('SELECT cursor_kind FROM chat_cursors WHERE room_id=$1',[roomId])).rows;assert.deepEqual(cursorRows.map(x=>x.cursor_kind),['agent']);
  await assert.rejects(chat.send(a,roomId,{clientMessageId:randomUUID(),text:'unapproved auto reply',agentGrantId:grantId}),/agent_not_authorized/);
  const edit={operationId:randomUUID(),expectedRevision:1,text:'修改后的正文'.repeat(500)};
  let editCalls=0,loseEdit=true;transport.edit=async()=>{editCalls++;if(loseEdit){loseEdit=false;throw new ServiceError('chat_delivery_unknown',504);}return{revision:2};};
  const beforeEdit=await subjectResourceUsage(f.db,a.subjectId,f.now());chat.access.resourceBudgetPolicy={...defaultResourceBudgetPolicy,maxPayloadBytesPerSubject:Number(beforeEdit.payloadBytes)};
  await assert.rejects(chat.edit(a,roomId,sent.messageId,edit),/storage_quota_exceeded/);assert.equal(editCalls,0,'Edit reserves all growth before external body changes');chat.access.resourceBudgetPolicy=null;
  await assert.rejects(chat.edit(a,roomId,sent.messageId,edit),/delivery_unknown/);
  assert.equal((await f.db.query('SELECT state FROM chat_message_operations WHERE operation_id=$1',[edit.operationId])).rows[0].state,'pending');
  assert.equal(Number((await f.db.query('SELECT content_bytes FROM chat_message_refs WHERE message_id=$1',[sent.messageId])).rows[0].content_bytes),Buffer.byteLength(edit.text));
  await assert.rejects(chat.edit(a,roomId,sent.messageId,{...edit,operationId:randomUUID()}),/pending_reconcile_first/);
  assert.deepEqual(await chat.edit(a,roomId,sent.messageId,edit),await chat.edit(a,roomId,sent.messageId,edit));
  transport.erase=async()=>{throw new ServiceError('chat_transport_unavailable',503);};assert.equal((await chat.retract(a,roomId,sent.messageId)).purgePending,true);
  const after=await chat.history(b,roomId);assert.equal(after.messages[0].text,null);assert.equal(after.messages[0].state,'retracted');
  assert.ok(Number((await f.db.query('SELECT content_bytes FROM chat_message_refs WHERE message_id=$1',[sent.messageId])).rows[0].content_bytes)>0,'Failed physical erase retains quota reservation');
  transport.erase=async()=>{};await chat.purgeOne(sent.messageId);assert.equal(Number((await f.db.query('SELECT content_bytes FROM chat_message_refs WHERE message_id=$1',[sent.messageId])).rows[0].content_bytes),0);
  await chat.hide(b,roomId,next.messageId);const empty=await chat.history(b,roomId,{after:history.next,limit:1});assert.equal(empty.messages.length,0);
  await f.db.query('UPDATE chat_message_refs SET sent_at=$2 WHERE message_id=$1',[next.messageId,new Date((f.now()-86401)*1000).toISOString()]);
  await assert.rejects(chat.edit(a,roomId,next.messageId,{operationId:randomUUID(),expectedRevision:1,text:'late'}),/edit_window_closed_use_correction/);
  await f.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[next.messageId,new Date((f.now()-1)*1000).toISOString()]);
  assert.equal((await chat.messageStatus(a,roomId,{clientMessageId:next.clientMessageId})).state,'expired');
  await assert.rejects(chat.edit(a,roomId,next.messageId,{operationId:randomUUID(),expectedRevision:1,text:'expired'}),/message_unavailable/);
 }finally{await f.close();}
});
