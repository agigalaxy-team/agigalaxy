import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {chatMessageOperationsBlockedWithin} from '../src/chat-message-operations-gate.mjs';

async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),governance=new AccountChatGovernanceService({chat:f.chat,businessAdmin}),
  admin={kind:'business-operator',operatorId:'message-operations-admin',role:'administrator',endpoint:f.endpoint,httpRequestId:randomUUID()},
  reader={...admin,operatorId:'message-operations-reader',role:'reader'},other={...admin,operatorId:'message-operations-other-admin'};
 for(const actor of [admin,reader,other])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.invalid',$1,'合成消息处理者',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000).toISOString()]);
 const authorize=async()=>admin;
 return{...f,businessAdmin,governance,admin,reader,other,authorization:{authorize}};
}
async function message(f,actor,roomId,{file=false,text='当前必要选材正文'}={}){
 let attachmentId=null,bytes=null,attachments;
 if(file){attachmentId=randomUUID();bytes=Buffer.from('明确选入的临时消息附件\n');const sha256=f.digest(bytes);
  await f.files.prepare(actor,{attachmentId,roomId,name:'合成案件文件.txt',mediaType:'text/plain',size:bytes.length,sha256,purpose:'temporary-room-attachment',confirmed:true});
  await f.files.upload(actor,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await f.files.scanPending();attachments=[{id:attachmentId,sha256}];}
 return{...await f.chat.send(actor,roomId,{clientMessageId:randomUUID(),text,...(attachments?{attachments}:{})}),attachmentId,bytes,text};
}
async function report(f,actor,roomId,selected){
 const source=await f.governance.source(actor,{roomId,messageIds:selected.map(item=>item.messageId)});
 return f.governance.report(actor,{operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'other',summary:'仅本次必要材料供独立运营处理。',
  materials:selected.map(item=>({messageId:item.messageId,revision:item.revision,attachmentIds:item.attachmentId?[item.attachmentId]:[]}))});
}
const material=(detail,messageId)=>detail.materials.find(item=>item.messageId===messageId);
const body=(detail,item,action,extra={})=>({operationId:randomUUID(),expectedVersion:detail.version,expectedRevision:material(detail,item.messageId).moderation.revision,messageRevision:item.revision,action,summary:'人工对本案所选消息作明确处理。',...extra});
const act=(f,detail,item,input,authorization=f.authorization)=>f.governance.operatorMessageVisibility(f.admin,{reportId:detail.reportId,messageId:item.messageId},input,authorization);
const commandCount=async f=>Number((await f.db.query("SELECT count(*) AS n FROM account_chat_governance_events_v1 WHERE kind LIKE 'message-%'")).rows[0].n);

test('manual message blocks and reviews preserve selected evidence, independent case contributions, ordinary read gates and exact command replay',{timeout:60000},async t=>{
 const f=await fixture(t),[a,b,c]=f.people,roomId=await joinAccountConversation(f,a,b),unselected=await message(f,b,roomId,{text:'仍可读取的较早独立消息'}),selected=await message(f,b,roomId,{file:true}),
  first=await report(f,a,roomId,[selected]),second=await report(f,a,roomId,[selected]);
 let one=await f.governance.operatorGet(f.admin,{reportId:first.reportId}),two=await f.governance.operatorGet(f.admin,{reportId:second.reportId});
 const read=await f.governance.operatorGet(f.reader,{reportId:first.reportId});assert.equal(material(read,selected.messageId).moderation.canHide,false);assert.equal(material(read,selected.messageId).text,selected.text);
 assert.equal(material(one,selected.messageId).authorAccountId,b.accountId);assert.equal(material(one,selected.messageId).moderation.revision,0);
 const hideOne=body(one,selected,'hide');one=await act(f,one,selected,hideOne);
 assert.equal(one.state,'reviewing');assert.equal(material(one,selected.messageId).moderation.ownHidden,true);assert.equal(material(one,selected.messageId).state,'available');
 assert.equal(material(one,selected.messageId).text,selected.text);assert.equal(material(one,selected.messageId).attachments[0].contentAvailable,true);
 assert.equal(material(one,selected.messageId).moderation.initialDecision.sourceRevision,selected.revision);
 assert.equal((await f.db.query('SELECT state,revision,purge_pending FROM chat_message_refs WHERE message_id=$1',[selected.messageId])).rows[0].state,'accepted');
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM chat_message_preferences WHERE message_id=$1',[selected.messageId])).rows[0].n),0,'a moderation block is not personal hiding');
 assert.equal((await f.chat.history(a,roomId)).messages.some(item=>item.messageId===selected.messageId),false);
 assert.equal((await f.chat.history(b,roomId)).messages.some(item=>item.messageId===selected.messageId),false,'the author has no ordinary content bypass');
 assert.equal((await f.chat.history(a,roomId,{keyword:selected.text})).messages.length,0);
 const context=await f.chat.messageContext(a,roomId,selected.messageId);assert.equal(context.target,null);assert.equal(context.targetState,'unavailable');
 const directory=await f.chat.directory(a);assert.equal(directory.rooms[0].latestMessage.messageId,unselected.messageId);assert.equal(directory.rooms[0].unreadHumanCount,1);
 assert.equal((await f.chat.run(a,false,db=>f.chat.readBookmarkWithin(db,a,{kind:'chat-message',roomId,messageId:selected.messageId}))).state,'temporarily-unavailable');
 await assert.rejects(f.chat.run(a,false,db=>f.chat.readSelectedWithin(db,a,{messageId:selected.messageId,revision:selected.revision})),{code:'chat_message_version_unavailable'});
 assert.equal((await f.chat.exportOwned(b)).messages.some(item=>item.messageId===selected.messageId),false);
 await assert.rejects(f.files.content(a,{attachmentId:selected.attachmentId}),{code:'attachment_message_unavailable'});
 assert.deepEqual((await f.governance.operatorAttachment(f.reader,{reportId:one.reportId,attachmentId:selected.attachmentId},{authorize:async()=>f.reader})).bytes,selected.bytes,'case-selected evidence retains its own existing qualification');
 await assert.rejects(f.chat.history(c,roomId),{code:'chat_access_denied'});
 await assert.rejects(f.chat.send(a,roomId,{clientMessageId:randomUUID(),text:'不能借回复引用重新展示被屏蔽原文',replyTo:selected.messageId}),{code:'chat_reply_unavailable'});
 await assert.rejects(act(f,one,unselected,{...body(one,selected,'hide'),messageRevision:unselected.revision}),{code:'chat_report_message_not_selected'});
 await assert.rejects(act(f,one,selected,body(one,selected,'keep',{expectedVersion:one.version-1})),{code:'chat_report_version_changed'});
 await assert.rejects(act(f,one,selected,body(one,selected,'keep',{expectedRevision:0})),{code:'chat_report_message_version_changed'});
 assert.equal((await f.governance.get(b,{reportId:one.reportId})).canAppeal,true,'message moderation uses the existing case appeal route');
 one=await f.governance.event(b,{operationId:randomUUID(),reportId:one.reportId,expectedVersion:one.version,kind:'appeal',summary:'请求复核本案单条消息屏蔽。'});
 assert.equal(one.state,'appealed');one=await f.governance.operatorGet(f.admin,{reportId:one.reportId});
 two=await f.governance.operatorGet(f.admin,{reportId:two.reportId});two=await act(f,two,selected,body(two,selected,'hide'));
 const initial=material(two,selected.messageId).moderation.initialDecision.eventId;two=await act(f,two,selected,body(two,selected,'keep'));
 assert.equal(material(two,selected.messageId).moderation.initialDecision.eventId,initial);assert.equal(two.events.at(-1).decision.message.action,'keep');
 one=await act(f,one,selected,body(one,selected,'restore'));
 assert.equal(material(one,selected.messageId).moderation.ownHidden,false);assert.equal(material(one,selected.messageId).moderation.hidden,true,'another case contribution stays active');
 assert.equal((await f.chat.history(a,roomId)).messages.some(item=>item.messageId===selected.messageId),false);
 await f.chat.hide(a,roomId,selected.messageId,{hidden:true});two=await act(f,two,selected,body(two,selected,'restore'));
 assert.equal(material(two,selected.messageId).moderation.hidden,false);assert.equal((await f.chat.history(a,roomId)).messages.some(item=>item.messageId===selected.messageId),false,'restoration preserves personal hide');
 assert.equal((await f.chat.history(b,roomId)).messages.some(item=>item.messageId===selected.messageId),true);
 await f.chat.hide(a,roomId,selected.messageId,{hidden:false});assert.equal((await f.chat.history(a,roomId)).messages.some(item=>item.messageId===selected.messageId),true);
 assert.deepEqual((await f.files.content(a,{attachmentId:selected.attachmentId})).bytes,selected.bytes);
 const before=await commandCount(f),replay=await act(f,one,selected,hideOne);assert.equal(replay.messageOperation.replayed,true);assert.equal(await commandCount(f),before);
 assert.equal(material(replay,selected.messageId).moderation.hidden,false,'late replay confirms the old command and cannot apply it again');
 await assert.rejects(act(f,one,selected,{...hideOne,summary:'同ID不能替换原操作'}),{code:'chat_report_operation_conflict'});
 assert.equal(await chatMessageOperationsBlockedWithin(f.db,{messageId:selected.messageId}),false);
});

test('author edits cannot bypass message-level blocks and restoration never substitutes new, withdrawn or expired source revisions',{timeout:60000},async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),edited=await message(f,b,roomId,{text:'被选入的第一版本'}),withdrawn=await message(f,b,roomId,{text:'撤回后不复活'}),expiring=await message(f,b,roomId,{text:'到期后不复活'});
 let first=await report(f,a,roomId,[edited]),second=await report(f,a,roomId,[withdrawn]),third=await report(f,a,roomId,[expiring]);
 first=await f.governance.operatorGet(f.admin,{reportId:first.reportId});second=await f.governance.operatorGet(f.admin,{reportId:second.reportId});third=await f.governance.operatorGet(f.admin,{reportId:third.reportId});
 first=await act(f,first,edited,body(first,edited,'hide'));second=await act(f,second,withdrawn,body(second,withdrawn,'hide'));third=await act(f,third,expiring,body(third,expiring,'hide'));
 await f.chat.edit(b,roomId,edited.messageId,{operationId:randomUUID(),expectedRevision:1,text:'编辑后的当前版本也不能绕过屏蔽'});
 assert.equal(await chatMessageOperationsBlockedWithin(f.db,{messageId:edited.messageId}),true);assert.equal((await f.chat.history(a,roomId)).messages.some(item=>item.messageId===edited.messageId),false);
 first=await f.governance.operatorGet(f.admin,{reportId:first.reportId});const old=material(first,edited.messageId);
 assert.equal(old.state,'unavailable');assert.equal(old.text,null);assert.equal(old.authorAccountId,null);assert.equal(old.authorDisplayName,null);assert.equal(old.authorUid,null);assert.equal(old.moderation.canRestore,false);assert.equal(old.moderation.hidden,true);
 let reads=0;const archiveRead=f.transport.read;f.transport.read=async input=>{reads++;return archiveRead(input);};
 await assert.rejects(act(f,first,edited,body(first,edited,'restore')),{code:'chat_report_source_changed'});
 await assert.rejects(act(f,first,edited,body(first,edited,'restore',{messageRevision:2})),{code:'chat_report_message_not_selected'});assert.equal(reads,0,'a moderation command does not fetch the unselected replacement body');
 await f.chat.retract(b,roomId,withdrawn.messageId);second=await f.governance.operatorGet(f.admin,{reportId:second.reportId});
 await assert.rejects(act(f,second,withdrawn,body(second,withdrawn,'restore')),{code:'chat_report_source_unavailable'});
 assert.equal((await f.db.query('SELECT state FROM chat_message_refs WHERE message_id=$1',[withdrawn.messageId])).rows[0].state,'retracted');
 f.advance(91*86400);third=await f.governance.operatorGet(f.admin,{reportId:third.reportId});
 await assert.rejects(act(f,third,expiring,body(third,expiring,'restore')),{code:'chat_report_source_unavailable'});assert.equal(material(third,expiring.messageId).moderation.canRestore,false);
 assert.equal(await commandCount(f),3,'only the three explicitly authorized original hides were recorded');
});

test('message commands require current independent administrator authority and roll back when the request verifier changes',{timeout:60000},async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),selected=await message(f,b,roomId),record=await report(f,a,roomId,[selected]),
  detail=await f.governance.operatorGet(f.admin,{reportId:record.reportId}),input=body(detail,selected,'hide'),target={reportId:record.reportId,messageId:selected.messageId};
 await assert.rejects(f.governance.operatorMessageVisibility(f.reader,target,input,{authorize:async()=>f.reader}),{code:'business_admin_denied'});
 await assert.rejects(act(f,detail,selected,input,{}),{code:'operations_authorization_unavailable'});
 await assert.rejects(act(f,detail,selected,{...input,operatorId:f.admin.operatorId}),{code:'invalid_chat_report_request'});
 let calls=0;await assert.rejects(act(f,detail,selected,input,{authorize:async()=>++calls===1?f.admin:{...f.admin,role:'reader'}}),{code:'business_admin_denied'});
 calls=0;await assert.rejects(act(f,detail,selected,input,{authorize:async()=>++calls===1?f.admin:f.other}),{code:'business_admin_denied'});
 await assert.rejects(act(f,detail,selected,input,{authorize:async()=>({...f.admin,endpoint:'https://another.example.invalid'})}),{code:'business_admin_denied'});
 const implicated={...f.admin,operatorId:'actual-selected-message-author'};
 await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://login.example.org','synthetic-1','本案实际发送者',$3,$3)`,[implicated.operatorId,f.endpoint,new Date(f.now()*1000).toISOString()]);
 await assert.rejects(f.governance.operatorMessageVisibility(implicated,target,input,{authorize:async()=>implicated}),{code:'chat_report_moderation_denied'});
 assert.equal(await commandCount(f),0);assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM operations_chat_message_visibility_v1')).rows[0].n),0);
 assert.equal((await f.governance.operatorGet(f.admin,{reportId:detail.reportId})).version,detail.version);
 const updated=await act(f,detail,selected,input);assert.equal(material(updated,selected.messageId).moderation.hidden,true);
});

test('withdrawn report permits only restoration of its own still-qualified message block without reopening or releasing another case',{timeout:60000},async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),selected=await message(f,b,roomId),
  first=await report(f,a,roomId,[selected]),second=await report(f,a,roomId,[selected]);
 let one=await f.governance.operatorGet(f.admin,{reportId:first.reportId}),two=await f.governance.operatorGet(f.admin,{reportId:second.reportId});
 one=await act(f,one,selected,body(one,selected,'hide'));two=await act(f,two,selected,body(two,selected,'hide'));
 one=await f.governance.event(a,{operationId:randomUUID(),reportId:one.reportId,expectedVersion:one.version,kind:'withdraw-report',summary:'撤回举报不代表撤销运营处置。'});
 const closedAt=one.closedAt;one=await f.governance.operatorGet(f.admin,{reportId:one.reportId});
 assert.equal(one.state,'withdrawn');assert(closedAt);assert.equal(material(one,selected.messageId).moderation.canRestore,true);
 assert.equal(material(one,selected.messageId).moderation.canHide,false);assert.equal(material(one,selected.messageId).moderation.canKeep,false);
 assert.equal(material(await f.governance.operatorGet(f.reader,{reportId:one.reportId}),selected.messageId).moderation.canRestore,false);
 await assert.rejects(act(f,one,selected,body(one,selected,'hide')),{code:'chat_report_state'});
 await assert.rejects(act(f,one,selected,body(one,selected,'keep')),{code:'chat_report_state'});
 await assert.rejects(act(f,one,selected,body(one,selected,'restore',{expectedVersion:one.version-1})),{code:'chat_report_version_changed'});
 await assert.rejects(act(f,one,selected,body(one,selected,'restore',{expectedRevision:0})),{code:'chat_report_message_version_changed'});
 await assert.rejects(act(f,one,selected,body(one,selected,'restore',{messageRevision:selected.revision+1})),{code:'chat_report_message_not_selected'});
 const restore=body(one,selected,'restore');one=await act(f,one,selected,restore);
 assert.equal(one.state,'withdrawn');assert.equal(one.closedAt,closedAt);assert.equal(material(one,selected.messageId).moderation.ownHidden,false);
 assert.equal(material(one,selected.messageId).moderation.hidden,true);assert.equal(material(one,selected.messageId).moderation.canRestore,false);
 assert.equal((await f.chat.history(a,roomId)).messages.some(item=>item.messageId===selected.messageId),false);
 const count=await commandCount(f),replayed=await act(f,one,selected,restore);
 assert.equal(replayed.messageOperation.replayed,true);assert.equal(await commandCount(f),count);assert.equal(replayed.state,'withdrawn');
 two=await act(f,two,selected,body(two,selected,'restore'));
 assert.equal(material(two,selected.messageId).moderation.hidden,false);
 assert.equal((await f.chat.history(a,roomId)).messages.some(item=>item.messageId===selected.messageId),true);
});
