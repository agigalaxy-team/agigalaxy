import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsFileAccessService} from '../src/operations/files/access-service.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {ForumAttachmentsV1Service} from '../src/forum-attachments-v1.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {migrate} from '../src/database.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {fileItem} from '../src/operations-agentos-query-view.mjs';
import {createAttachmentsClient} from '../../galaxy-web/src/chat-attachments-client.mjs';

// Actual PG/API/worker roles, current PG grants, upload/scan/bind/source and
// selected-case checks. Directory, AV, chat transport and bytes are explicit
// local doubles; this leaf is not an HTTP/OIDC or production-storage claim.
test('manual file access overlays both sources without changing storage, author permission or original operation continuity',{timeout:120000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const objects=new Map();let reads=0,erases=0,afterRead=null;
 const store={keyId:'access-fixture-only',put:async({key,bytes})=>objects.set(key,Buffer.from(bytes)),get:async({key})=>{reads++;const bytes=objects.get(key);await afterRead?.();return bytes;},erase:async()=>{erases++;throw Error('This access-only feature must not erase bytes.');}};
 f.files.store=store;
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),forumFiles=new ForumAttachmentsV1Service({forum,store,scanner:f.files.scanner});forum.attachments=forumFiles;
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),admin={kind:'business-operator',operatorId:'access-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'access-reader',role:'reader'};
 for(const actor of [admin,reader])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://manager.example',$1,'文件管理者',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const authority=await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['files.read']}),access=new OperationsFileAccessService({businessAdmin,chatAttachments:f.files,forumAttachments:forumFiles,now:f.now}),authorization={authorize:async()=>admin},governance=new AccountChatGovernanceService({chat:f.chat,businessAdmin});
 const [a,b]=f.people,roomId=await joinAccountConversation(f,a,b),everyone={read:{kind:'everyone'},participate:{kind:'accounts'}};
 async function upload(kind='chat',{scan=true,actor=b}={}){
  const id=randomUUID(),bytes=Buffer.from('LOCAL_ACCESS_BYTES '+id),input={attachmentId:id,name:'本次文件.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)},files=kind==='chat'?f.files:forumFiles;
  if(kind==='chat')Object.assign(input,{roomId,purpose:'temporary-room-attachment',confirmed:true});
  await files.prepare(actor,input);await files.upload(actor,id,Readable.from([bytes]),{contentLength:bytes.length});if(scan)await files.scanPending();return{kind,id,input,bytes,files,actor};
 }
 async function publish(file){const p=await bindForumIds('create-post','account:'+file.actor.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:file.actor.accountId,title:'公开附件来源',body:'PUBLIC_SOURCE_BODY_NEVER_IN_FILE_METADATA',links:[],topic:'technology',audience:everyone,publishedUntil:f.now()+3600,attachments:[{id:file.id,sha256:file.input.sha256}]});await forum.publish(file.actor,{payloadJson:JSON.stringify(p)});return p;}
 const chat=await upload(),pub=await upload('forum'),draft=await upload(),expired=await upload(),late=await upload(),sourceGone=await upload(),forumGone=await upload('forum'),forumLate=await upload('forum',{actor:a}),pending=await upload('chat',{scan:false});
 const post=await publish(pub),gonePost=await publish(forumGone),latePost=await publish(forumLate);
 const message=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'SELECTED_PRIVATE_CASE_TEXT',attachments:[{id:chat.id,sha256:chat.input.sha256}]}),goneMessage=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'撤回消息',attachments:[{id:sourceGone.id,sha256:sourceGone.input.sha256}]});
 const source=await governance.source(a,{roomId,messageIds:[message.messageId]}),report=await governance.report(a,{operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'other',summary:'EXACT_CASE_REPORT_ONLY',materials:[{messageId:message.messageId,revision:1,attachmentIds:[chat.id]}]});
 await migrate(f.db,{roles:['api','worker']});await f.db.exec('SET ROLE galaxy_api');
 const current=file=>access.get(admin,file.kind,file.id),change=async(file,action,extra={})=>{const value=await current(file);return access.change(admin,file.kind,file.id,{operationId:randomUUID(),expectedVersion:value.processingVersion,expectedRevision:value.access.revision,action,reason:'本次具体人工访问决定',...(action==='stop'?{until:f.now()+120}:{}),...extra},authorization);};
 const original=(await f.db.query('SELECT state,expires_at,revoked_at,purge_pending,storage_key FROM chat_attachments WHERE id=$1',[chat.id])).rows[0];
 const visible=await current(chat);assert.equal(visible.access.canStop,true);assert.equal((await access.get(reader,'chat',chat.id)).access.canStop,false);
 await assert.rejects(access.change({...reader,role:'administrator'},'chat',chat.id,{operationId:randomUUID(),expectedVersion:visible.version,expectedRevision:0,action:'stop',until:f.now()+120,reason:'不能借伪角色写入'},{authorize:async()=>({...reader,role:'administrator'})}),{code:'operations_permission_denied'});
 await assert.rejects(access.change(admin,'chat',chat.id,{operationId:randomUUID(),expectedVersion:visible.version,expectedRevision:0,action:'stop',reason:'没有默认期限'},authorization),{code:'invalid_operations_request'});
 const input={operationId:randomUUID(),expectedVersion:visible.version,expectedRevision:0,action:'stop',until:f.now()+120,reason:'仅停止本次文件访问，不删除文件'};
 const stopped=await access.change(admin,'chat',chat.id,input,authorization);assert.equal(stopped.file.state,'available');assert.equal(stopped.file.access.stopped,true);assert.equal(stopped.file.access.operatorDisplayName,'文件管理者');
 assert.equal((await access.change(admin,'chat',chat.id,input,authorization)).replayed,true);
 await assert.rejects(access.change(admin,'chat',chat.id,{...input,reason:'同ID不得改变输入'},authorization),{code:'business_admin_operation_conflict'});
 assert.equal((await access.operation(admin,input.operationId)).state,'recorded');assert.equal((await access.operation(reader,input.operationId)).state,'not-recorded');
 await assert.rejects(access.operation({...admin,endpoint:'https://foreign.example'},input.operationId),{code:'business_admin_denied'});
 assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM operations_file_access_events_v1 WHERE file_id=$1',[chat.id])).rows[0].n,1);
 assert.deepEqual((await f.db.query('SELECT state,expires_at,revoked_at,purge_pending,storage_key FROM chat_attachments WHERE id=$1',[chat.id])).rows[0],original);
 assert.equal((await f.files.get(b,{attachmentId:chat.id})).state,'unavailable');assert.equal((await f.files.queryOwn(b,{roomId})).items.find(item=>item.attachmentId===chat.id).state,'unavailable');
 const history=await f.chat.history(a,roomId,{});assert.equal(history.messages.find(item=>item.messageId===message.messageId).attachments[0].state,'unavailable');
 const before=reads;await assert.rejects(f.files.content(a,{attachmentId:chat.id}),{code:'attachment_content_unavailable'});await assert.rejects(f.files.content(b,{attachmentId:chat.id},{ownExport:true}),{code:'attachment_content_unavailable'});
 const materials=await governance.operatorGet(admin,{reportId:report.reportId});assert.equal(materials.materials[0].attachments[0].contentAvailable,false);
 await assert.rejects(governance.operatorAttachment(admin,{reportId:report.reportId,attachmentId:chat.id},authorization),{code:'attachment_content_unavailable'});assert.equal(reads,before);
 const projected=fileItem(stopped.file);assert.equal(projected.access.stopped,true);for(const hidden of [input.reason,'文件管理者','storage_key','SELECTED_PRIVATE_CASE_TEXT'])assert(!JSON.stringify(projected).includes(hidden));
 const fullReady=(await access.summary(reader)).totals.readyFiles;await change(pub,'stop');assert.equal((await access.summary(reader)).totals.readyFiles,fullReady-1);
 const publicView=await forum.readVersionWithin(f.db,post.postId,post.versionId);assert.equal(publicView.attachments[0].state,'unavailable');
 await assert.rejects(forumFiles.content(null,{attachmentId:pub.id,source:{postId:post.postId,versionId:post.versionId}}),{code:'attachment_content_unavailable'});
 const pubValue=await current(pub);await assert.rejects(access.change(admin,'forum',pub.id,{operationId:randomUUID(),expectedVersion:pubValue.version,expectedRevision:0,action:'restore',reason:'旧覆盖版本'},authorization),{code:'operations_file_access_changed'});
 await change(pub,'restore');assert.deepEqual((await forumFiles.content(null,{attachmentId:pub.id,source:{postId:post.postId,versionId:post.versionId}})).bytes,pub.bytes);
 await change(chat,'restore');assert.deepEqual((await f.files.content(a,{attachmentId:chat.id})).bytes,chat.bytes);assert.deepEqual((await governance.operatorAttachment(admin,{reportId:report.reportId,attachmentId:chat.id},authorization)).bytes,chat.bytes);
 await change(draft,'stop');await assert.rejects(f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'不得绑定停止文件',attachments:[{id:draft.id,sha256:draft.input.sha256}]}),{code:'attachment_content_unavailable'});
 // Pending scans can be stopped, but a true blocked scan is never restored.
 await change(pending,'stop');await f.db.exec('SET ROLE galaxy_evidence_worker');const scanner=f.files.scanner.scan;f.files.scanner.scan=async()=>({state:'blocked',engine:'local-blocked-double'});await f.files.scanPending();f.files.scanner.scan=scanner;await f.db.exec('SET ROLE galaxy_api');
 assert.equal((await current(pending)).access.canRestore,false);await assert.rejects(change(pending,'restore'),{code:'operations_file_access_restore_unavailable'});
 await change(sourceGone,'stop');await f.chat.retract(b,roomId,goneMessage.messageId);assert.equal((await current(sourceGone)).access.restoreBlockedReason,'source-unavailable');await assert.rejects(change(sourceGone,'restore'),{code:'operations_file_access_restore_unavailable'});
 await change(forumGone,'stop');const withdrawal=await bindForumIds('withdraw-post','account:'+b.accountId,{schemaVersion:1,operationId:randomUUID(),postId:gonePost.postId,expectedHeadVersion:1});await forum.withdraw(b,'withdraw-post',{payloadJson:JSON.stringify(withdrawal)});assert.equal((await current(forumGone)).access.canRestore,false);await assert.rejects(change(forumGone,'restore'),{code:'operations_file_access_restore_unavailable'});
 const ownGone=await change(late,'stop');await f.files.revoke(b,{attachmentId:late.id});assert.equal((await current(late)).access.canRestore,false);await assert.rejects(change(late,'restore'),{code:'operations_file_access_restore_unavailable'});
 authority.roles.set(admin.operatorId,'reader');await assert.rejects(access.change(admin,'chat',chat.id,{...input,operationId:randomUUID()},authorization),{code:'operations_permission_denied'});authority.roles.set(admin.operatorId,'administrator');
 await f.db.exec('SET ROLE galaxy_evidence_worker');assert.equal((await f.db.query('SELECT revision,stopped_until FROM operations_file_access_heads_v1 WHERE endpoint=$1 AND kind=$2 AND file_id=$3',[f.endpoint,'chat',chat.id])).rows.length,1);await assert.rejects(f.db.query('SELECT reason FROM operations_file_access_heads_v1'),/permission denied/);await assert.rejects(f.db.query('UPDATE operations_file_access_heads_v1 SET stopped_until=NULL WHERE false'),/permission denied/);await f.db.exec('SET ROLE galaxy_api');
 await assert.rejects(f.db.query("UPDATE operations_file_access_events_v1 SET reason='rewrite' WHERE false"),/permission denied/);
 // The same access gate runs again after object storage returns. The explicit
 // storage double alters only a fixture row within the real active transaction.
 const originalRow=f.files.row.bind(f.files);let transferDb=null;
 f.files.row=(db,...args)=>{transferDb=db;return originalRow(db,...args);};
 afterRead=async()=>{await transferDb.query('UPDATE operations_file_access_heads_v1 SET stopped_until=$4 WHERE endpoint=$1 AND kind=$2 AND file_id=$3',[f.endpoint,'chat',chat.id,new Date((f.now()+60)*1000)]);};
 await assert.rejects(f.files.content(a,{attachmentId:chat.id}),{code:'attachment_content_unavailable'});afterRead=null;f.files.row=originalRow;
 // Time and source permission also get rechecked after bytes; no stale public
 // bytes can be returned when the genuine source expires during storage I/O.
 afterRead=()=>{f.advance(3601);};await assert.rejects(forumFiles.content(null,{attachmentId:forumLate.id,source:{postId:latePost.postId,versionId:latePost.versionId}}),{code:'attachment_content_unavailable'});afterRead=null;
 assert.equal((await current(draft)).access.stopped,false,'a passed explicit deadline ends only the overlay');
 await f.db.query('UPDATE chat_attachments SET expires_at=$2 WHERE id=$1',[expired.id,new Date((f.now()+1)*1000)]);afterRead=()=>f.advance(2);await assert.rejects(f.files.content(b,{attachmentId:expired.id},{ownExport:true}),{code:'attachment_content_unavailable'});afterRead=null;
 assert.equal(erases,0);assert(objects.has('attachments/'+chat.id));assert(objects.has('forum-attachments/'+pub.id));
 const audit=(await f.db.query("SELECT selection,result FROM business_admin_audit_v1 WHERE action LIKE 'file-access-%'")).rows;for(const secret of [input.reason,'expectedVersion','本次文件.txt','PUBLIC_SOURCE_BODY_NEVER_IN_FILE_METADATA','storage_key'])assert(!JSON.stringify(audit).includes(secret));
 const final=await current(chat);assert(final.history.items.some(event=>event.kind==='access-stop'&&event.operatorDisplayName==='文件管理者'));assert(final.history.items.some(event=>event.kind==='access-restore'));
 // Client recovery uses the intrinsic upload state: a stopped preparation is
 // not proof of stored bytes, and a stored stopped receipt must not re-upload.
 const journal={subjectId:'owner',input:{...draft.input,attachmentId:randomUUID()}},snapshot={subjectId:'owner',bindingId:'binding',generation:1,control:{deviceId:'device',epoch:1}};let local=journal;
 const api={endpoint:f.endpoint,snapshot:()=>snapshot,call:async()=>({attachmentId:journal.input.attachmentId,roomId,sha256:journal.input.sha256,size:journal.input.size,state:'unavailable',processingState:'prepared',access:{stopped:true}})};
 const client=createAttachmentsClient({api,getLocal:async()=>local,putLocal:async(_key,value)=>{local=value;}});await client.reconcile(roomId);assert.equal(local,journal);
 api.call=async()=>({attachmentId:journal.input.attachmentId,roomId,sha256:journal.input.sha256,size:journal.input.size,state:'unavailable',processingState:'scan-pending',access:{stopped:true}});await client.reconcile(roomId);assert.equal(local,null);
});
