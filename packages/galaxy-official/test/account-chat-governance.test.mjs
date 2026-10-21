import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {dispatchAccountChatGovernance} from '../src/adapters/http/account-chat-governance-http.mjs';

async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now});
 const governance=new AccountChatGovernanceService({chat:f.chat,businessAdmin});
 const operator={kind:'business-operator',operatorId:'https://operations.example.org|independent-handler',role:'administrator',endpoint:f.endpoint,httpRequestId:randomUUID()};
 const reader={...operator,operatorId:'https://operations.example.org|reader',role:'reader'};
 for(const [actor,issuer,subject]of [[operator,'https://operations.example.org','independent-handler'],[reader,'https://operations.example.org','reader']])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,'合成处理者',$5,$5)`,[actor.operatorId,f.endpoint,issuer,subject,new Date(f.now()*1000).toISOString()]);
 return{...f,governance,businessAdmin,operator,reader};
}
async function report(f,actor,roomId,{materials=[],summary='只对明确选中的问题提出举报。'}={}){
 const source=await f.governance.source(actor,{roomId,messageIds:materials.map(item=>item.messageId)});
 const input={operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'harassment',summary,materials};
 return{input,result:await f.governance.report(actor,input)};
}
async function uploaded(f,actor,roomId,text='明确选中的必要附件\n'){
 const bytes=Buffer.from(text),attachmentId=randomUUID(),sha256=f.digest(bytes);
 await f.files.prepare(actor,{attachmentId,roomId,name:'随案材料.txt',mediaType:'text/plain',size:bytes.length,sha256,purpose:'temporary-room-attachment',confirmed:true});
 await f.files.upload(actor,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await f.files.scanPending();
 const message=await f.chat.send(actor,roomId,{clientMessageId:randomUUID(),text:'只选择这条消息',attachments:[{id:attachmentId,sha256}]});
 return{bytes,attachmentId,message};
}
const event=(record,kind,extra={})=>({operationId:randomUUID(),reportId:record.reportId,expectedVersion:record.version,kind,summary:'明确的处理说明。',...extra});

test('Cookie account reports selected messages/files without a local ID or room-history grant to operators',async t=>{
 const f=await fixture(t),[a,b,c]=f.people,roomId=await joinAccountConversation(f,a,b),selected=await uploaded(f,b,roomId);
 const unrelated=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'这条原文没有被选择，处理者不应取得。'});
 const {input,result}=await report(f,a,roomId,{materials:[{messageId:selected.message.messageId,revision:1,attachmentIds:[selected.attachmentId]}]});
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM subjects')).rows[0].n),0);
 assert.equal(result.roomHistoryGranted,false);assert.equal(result.materials.length,1);assert.equal(result.materials[0].text,'只选择这条消息');
 assert.equal((await f.governance.report(a,input)).reportId,result.reportId,'same exact operation is idempotent');
 await assert.rejects(f.governance.report(a,{...input,summary:'同 operationId 的替代说明'}),/chat_report_operation_conflict/);
 await assert.rejects(f.governance.report(a,{...input,operationId:randomUUID(),materials:[{...input.materials[0],text:'客户端伪造原文'}]}),/invalid_chat_report_request/);
 const detail=await f.governance.operatorGet(f.operator,{reportId:result.reportId});
 assert.equal(detail.canModerate,true);assert.equal(detail.materials.length,1);assert.ok(!JSON.stringify(detail).includes('这条原文没有被选择'));
 assert.equal(detail.materials.some(item=>item.messageId===unrelated.messageId),false);
 assert.deepEqual((await f.governance.operatorAttachment(f.operator,{reportId:result.reportId,attachmentId:selected.attachmentId})).bytes,selected.bytes);
 const other=await uploaded(f,b,roomId,'另一个未选择附件');
 await assert.rejects(f.governance.operatorAttachment(f.operator,{reportId:result.reportId,attachmentId:other.attachmentId}),/chat_report_attachment_unavailable/);
 await assert.rejects(f.chat.history(c,roomId),/chat_access_denied/);
 await assert.rejects(f.governance.get(c,{reportId:result.reportId}),/chat_report_unavailable/);
 const affected=await f.governance.get(b,{reportId:result.reportId});
 assert.equal(affected.events[0].summary,null);assert.deepEqual(affected.materials,[],'being a room party does not grant the other party’s complaint material');
 const receipt=await f.governance.receipt(a,{operationId:input.operationId});assert.equal(receipt.state,'recorded');
 assert.equal((await f.governance.receipt(c,{operationId:input.operationId})).state,'absent');
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM chat_memberships WHERE room_id=$1 AND subject_id=$2',[roomId,f.operator.operatorId])).rows[0].n),0);
});

test('source version/readability is rechecked, and selected material does not survive withdrawal or source expiry',async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),sent=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'最初的消息'});
 const source=await f.governance.source(a,{roomId,messageIds:[sent.messageId]});
 await f.chat.edit(b,roomId,sent.messageId,{operationId:randomUUID(),expectedRevision:1,text:'已修改的消息'});
 await assert.rejects(f.governance.report(a,{operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'other',summary:'举报时不能悄悄换成新版本。',materials:[{messageId:sent.messageId,revision:1,attachmentIds:[]}]}),/chat_report_source_changed/);
 const {result}=await report(f,a,roomId,{materials:[{messageId:sent.messageId,revision:2,attachmentIds:[]}]});
 assert.equal((await f.governance.operatorGet(f.reader,{reportId:result.reportId})).materials[0].text,'已修改的消息');
 await f.chat.retract(b,roomId,sent.messageId);
 const unavailable=(await f.governance.operatorGet(f.operator,{reportId:result.reportId})).materials[0];
 assert.equal(unavailable.state,'unavailable');assert.equal(unavailable.text,null);
 const file=await uploaded(f,b,roomId),caseWithFile=(await report(f,a,roomId,{materials:[{messageId:file.message.messageId,revision:1,attachmentIds:[file.attachmentId]}]})).result;
 const get=f.files.store.get;f.files.store.get=async input=>{const bytes=await get(input);f.advance(31*86400);return bytes;};
 await assert.rejects(f.governance.operatorAttachment(f.operator,{reportId:caseWithFile.reportId,attachmentId:file.attachmentId}),/attachment_content_unavailable|chat_report_attachment_unavailable/);
});

test('a selected message author cannot handle their own case by leaving the room before it is reported',async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),message=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'退出前的实际消息'});
 await f.chat.leave(b,roomId);
 const {result}=await report(f,a,roomId,{materials:[{messageId:message.messageId,revision:1,attachmentIds:[]}]});
 const formerAuthor={...f.operator,operatorId:'synthetic-former-author'};
 await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://login.example.org','synthetic-1','合成前成员',$3,$3)`,[formerAuthor.operatorId,f.endpoint,new Date(f.now()*1000).toISOString()]);
 const view=await f.governance.operatorGet(formerAuthor,{reportId:result.reportId});assert.equal(view.canModerate,false);assert.deepEqual(view.materials,[]);
 await assert.rejects(f.governance.operatorEvent(formerAuthor,event(result,'review')),/chat_report_moderation_denied/);
 const unknown={...f.operator,operatorId:'no-current-principal-mapping'};
 await assert.rejects(f.governance.operatorGet(unknown,{reportId:result.reportId}),/business_admin_denied/);
});

test('a separate management realm does not match a business account by equal subject or directory email',async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),message=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'只选择这条随案消息。'});
 const {result}=await report(f,a,roomId,{materials:[{messageId:message.messageId,revision:1,attachmentIds:[]}]});
 const sharedEmail='same-mailbox@example.invalid',businessIssuer='https://login.example.org',managementIssuer=businessIssuer+'/realms/galaxy-operations',subject='synthetic-0';
 // The directory deliberately returns the same synthetic mailbox for both
 // identities. The domain must never consult it to manufacture a relation.
 let emailLookups=0;
 f.businessAdmin.identityDirectory={
  async get({issuer,externalSubject}){emailLookups++;return{issuer,externalSubject,email:sharedEmail,emailVerified:true,enabled:true};},
  async findByEmail(){emailLookups++;return[{issuer:businessIssuer,externalSubject:subject,email:sharedEmail,emailVerified:true,enabled:true}];}
 };
 const management={...f.operator,operatorId:'synthetic-separate-management-realm'};
 await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,$3,$4,'独立管理身份',$5,$5)`,[management.operatorId,f.endpoint,managementIssuer,subject,new Date(f.now()*1000).toISOString()]);
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM community_accounts WHERE endpoint=$1 AND issuer=$2',[f.endpoint,managementIssuer])).rows[0].n),0);
 const view=await f.governance.operatorGet(management,{reportId:result.reportId});
 assert.equal(view.canModerate,true,'a verified management identity needs no normal Galaxy account');
 assert.equal(view.materials[0].text,'只选择这条随案消息。');
 assert.equal((await f.governance.operatorEvent(management,event(view,'review'))).state,'reviewing');
 assert.equal(emailLookups,0,'no email search or cross-realm subject match is an account relationship');
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM community_account_links')).rows[0].n),0,'no relation is silently created');
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM subjects')).rows[0].n),0);
});

test('operations role, independent handling and expiring room restrictions use the actual chat gate',async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),{result}=await report(f,a,roomId);
 const implicated={...f.operator,operatorId:'https://login.example.org|synthetic-0'};
 await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://login.example.org','synthetic-0','合成当事人',$3,$3)`,[implicated.operatorId,f.endpoint,new Date(f.now()*1000).toISOString()]);
 assert.equal((await f.governance.operatorGet(implicated,{reportId:result.reportId})).canModerate,false);
 await assert.rejects(f.governance.operatorEvent(implicated,event(result,'review')),/chat_report_moderation_denied/);
 await assert.rejects(async()=>f.governance.operatorEvent(f.reader,event(result,'review')),/business_admin_denied/);
 let current=await f.governance.operatorEvent(f.operator,event(result,'pause',{targetVersion:result.currentTarget.version,scopes:['sending-paused','invitations-paused'],until:f.now()+3600,rule:'禁止骚扰'}));
 await assert.rejects(f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'暂停期间不能发送'}),/target_operation_restricted/);
 await assert.rejects(async()=>f.governance.event(a,event(current,'resume')),/chat_report_moderation_denied/);
 const related=await f.governance.get(b,{reportId:current.reportId});assert.equal(related.events.at(-1).summary,'明确的处理说明。');assert.equal(related.events[0].summary,null);
 current=await f.governance.event(b,event(current,'appeal',{summary:'对这一限制提出申诉。'}));
 current=await f.governance.operatorEvent(f.operator,event(current,'resume'));
 await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'解除后实际能够发送'});
 current=await f.governance.operatorEvent(f.operator,event(current,'resolve',{targetVersion:current.currentTarget.version,verdict:'dismissed',rule:'现有说明不足以采取限制',restriction:null}));
 current=await f.governance.event(a,event(current,'appeal',{summary:'补充说明后请求重新处理。'}));
 current=await f.governance.event(a,event(current,'supplement',{summary:'追加本人的说明，不必给运营整个房间。'}));
 const final=await f.governance.event(a,event(current,'withdraw-report',{summary:'撤回举报。'}));assert.equal(final.state,'withdrawn');
 const audit=(await f.db.query("SELECT action,operator_id,result FROM business_admin_audit_v1 WHERE action='chat-report-event' ORDER BY sequence")).rows;
 assert.equal(audit.length,3);assert.ok(audit.every(row=>row.operator_id===f.operator.operatorId));
 f.advance(181*86400);await f.governance.purgeExpired();const retained=await f.governance.get(a,{reportId:final.reportId});
 assert.equal(retained.materialsExpired,true);assert.ok(retained.events.every(item=>item.summary===null));
});

test('report HTTP obtains Cookie/operator authority on the server, not from the submitted JSON',async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b);let sent,cookieCalls=0,operatorCalls=0;
 const officialAccounts={actionActor:async(_request,{write})=>{cookieCalls++;assert.equal(write,true);return a;}};
 const request=input=>Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]),{method:'POST',headers:{'content-type':'application/json'}});
 const input={operationId:randomUUID(),roomId,roomVersion:(await f.chat.get(a,roomId)).revision,category:'other',summary:'从真实账户提出举报。',materials:[]};
 const common={accountChatGovernance:f.governance,officialAccounts,requestId:randomUUID(),response:{},send:(_status,value)=>{sent=value;}};
 assert.equal(await dispatchAccountChatGovernance({...common,request:request(input),url:new URL('/v1/account/chat-reports/report',f.endpoint)}),true);
 assert.equal(cookieCalls,1);assert.equal(sent.reporterAccountId,a.accountId);
 const forged=request({...input,operator:{role:'administrator'}});await assert.rejects(dispatchAccountChatGovernance({...common,request:forged,url:new URL('/v1/account/chat-reports/report',f.endpoint)}),/invalid_chat_report_request/);
 const bearer=request(input);bearer.headers.authorization='Bearer invalid';await assert.rejects(dispatchAccountChatGovernance({...common,request:bearer,url:new URL('/v1/account/chat-reports/report',f.endpoint)}),/chat_report_account_required/);
 assert.equal(cookieCalls,2,'supplied ID credentials cannot fall back into the account cookie');
 const route=new URL('/v1/operations/chat-reports/'+sent.reportId+'/event',f.endpoint),write=request(event(sent,'review'));
 await assert.rejects(dispatchAccountChatGovernance({...common,request:write,url:route,authorizeOperator:async(_request,context)=>{operatorCalls++;assert.equal(context.write,true);return f.reader;}}),/business_admin_denied/);
 assert.equal(operatorCalls,1);
});
