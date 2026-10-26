import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsFileCleanupService} from '../src/operations/files/cleanup-service.mjs';
import {ForumAttachmentsV1Service} from "../src/community/forum-attachments-v1.mjs";
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';
import {AttachmentS3Store} from '../src/infrastructure/attachment-s3-store.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';

// SQL/roles/current PG authorization, actual upload/scan/bind/withdraw/retract,
// and cleanup code are real. OIDC directory, chat transport, AV and bytes store
// are explicit local doubles. No production deletion or provider is used.
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);const objects=new Map(),eraseCalls=[],heads=[],failAfterDelete=new Set();
 const store={keyId:'synthetic-only',put:async({key,bytes,sha256})=>objects.set(key,{bytes:Buffer.from(bytes),sha256}),get:async({key})=>objects.get(key)?.bytes,
  head:async({key})=>{heads.push(key);const value=objects.get(key);return value?{size:value.bytes.length,sha256:value.sha256}:null;},
  erase:async({key})=>{eraseCalls.push(key);objects.delete(key);if(failAfterDelete.delete(key))throw new ServiceError('attachment_storage_unavailable',503);return{objectRemoved:true,physicalBlockErasure:'storage-garbage-collection'};}};
 f.files.store=store;
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),forumFiles=new ForumAttachmentsV1Service({forum,store,scanner:f.files.scanner});forum.attachments=forumFiles;
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),admin={kind:'business-operator',operatorId:'cleanup-fixture-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'cleanup-fixture-reader',role:'reader'};
 for(const actor of [admin,reader])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://fixture.invalid',$1,'文件维护者',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const authority=await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['files.read']});
 const cleanup=new OperationsFileCleanupService({businessAdmin,chatAttachments:f.files,forumAttachments:forumFiles,now:f.now}),authorization={authorize:async()=>admin};
 let roomId=null;
 async function upload(kind='chat',actor=f.people[0]){
  const id=randomUUID(),bytes=Buffer.from('Only local attachment bytes '+id),input={attachmentId:id,name:'清理测试.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)};
  const files=kind==='chat'?f.files:forumFiles;if(kind==='chat'){roomId??=await joinAccountConversation(f,f.people[0],f.people[1]);Object.assign(input,{roomId,purpose:'temporary-room-attachment',confirmed:true});}
  await files.prepare(actor,input);await files.upload(actor,id,Readable.from([bytes]),{contentLength:bytes.length});await files.scanPending();return{kind,id,bytes,input,files};
 }
 const everyone={read:{kind:'everyone'},participate:{kind:'accounts'}};
 async function post(actor=f.people[0],extra={}){const x=await bindForumIds('create-post','account:'+actor.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:actor.accountId,title:'实际来源',body:'Source body must not be returned by file plans.',links:[],topic:'technology',audience:everyone,publishedUntil:f.now()+3600,...extra});await forum.publish(actor,{payloadJson:JSON.stringify(x)});return x;}
 async function withdrawPost(actor,p){const x=await bindForumIds('withdraw-post','account:'+actor.accountId,{schemaVersion:1,operationId:randomUUID(),postId:p.postId,expectedHeadVersion:1});await forum.withdraw(actor,'withdraw-post',{payloadJson:JSON.stringify(x)});}
 const create=async items=>cleanup.create(admin,{operationId:randomUUID(),items:items.map(({kind,id,expectedVersion})=>({kind,id,expectedVersion})),reason:'只清理本次列明的文件。'},authorization);
 const approve=async plan=>cleanup.approve(admin,plan.id,{operationId:randomUUID(),expectedRevision:plan.revision},authorization);
 return{...f,objects,eraseCalls,heads,failAfterDelete,forum,forumFiles,businessAdmin,admin,reader,authority,cleanup,authorization,upload,post,withdrawPost,create,approve,getRoomId:()=>roomId,everyone};
}

test('legacy file cleanup separates explicit owner and safety work from a fixed manually approved operational plan',{timeout:90000},async t=>{
 const f=await fixture(t),expired=await f.upload(),forumExpired=await f.upload('forum'),revoked=await f.upload(),retracted=await f.upload();
 await f.files.revoke(f.people[0],{attachmentId:revoked.id});
 const message=await f.chat.send(f.people[0],f.getRoomId(),{clientMessageId:randomUUID(),text:'附件撤回测试',attachments:[{id:retracted.id,sha256:retracted.input.sha256}]});await f.chat.retract(f.people[0],f.getRoomId(),message.messageId);
 const scan=f.files.scanner.scan;f.files.scanner.scan=async()=>({state:'blocked',engine:'explicit-safety-double'});const blocked=await f.upload();f.files.scanner.scan=scan;
 const unfinished=randomUUID();await f.files.prepare(f.people[0],{...expired.input,attachmentId:unfinished});
 f.advance(30*86400+1);
 // Clean scan data plus generic state=blocked is only an expiry observation.
 await f.db.query("UPDATE chat_attachments SET state='blocked' WHERE id=$1",[expired.id]);
 await f.files.purgeExpired({limit:100});await f.forumFiles.purgeExpired({limit:100});
 for(const id of [revoked.id,retracted.id,blocked.id,unfinished])assert((await f.db.query('SELECT purged_at FROM chat_attachments WHERE id=$1',[id])).rows[0].purged_at,'owner/safety paths remain automatic');
 assert.equal((await f.db.query('SELECT purged_at FROM chat_attachments WHERE id=$1',[expired.id])).rows[0].purged_at,null);
 assert.equal((await f.db.query('SELECT purged_at FROM forum_attachments_v1 WHERE id=$1',[forumExpired.id])).rows[0].purged_at,null);
 await migrate(f.db,{roles:['api','worker']});await f.db.exec('SET ROLE galaxy_api');
 const candidates=await f.cleanup.candidates(f.reader,{limit:1});assert.equal(candidates.items.length,1);assert(candidates.nextAfter);
 const next=await f.cleanup.candidates(f.reader,{after:candidates.nextAfter,limit:50}),items=[...candidates.items,...next.items];assert.equal(items.length,2);assert(items.every(item=>item.eligible));assert.deepEqual(new Set(items.map(item=>item.id)),new Set([expired.id,forumExpired.id]));
 await assert.rejects(f.cleanup.create({...f.reader,role:'administrator'},{operationId:randomUUID(),items:[items[0]]},f.authorization),{code:'invalid_operations_request'});
 await assert.rejects(f.cleanup.create({...f.reader,role:'administrator'},{operationId:randomUUID(),items:[{kind:items[0].kind,id:items[0].id,expectedVersion:items[0].expectedVersion}]},{authorize:async()=>({...f.reader,role:'administrator'})}),{code:'operations_permission_denied'});
 const created=await f.create(items),plan=created.plan;assert.equal(plan.state,'awaiting-approval');assert.equal(plan.itemCount,2);assert.equal(plan.createdBy.displayName,'文件维护者');assert.equal(plan.impact.physicalBlocksReleased,null);
 const serialized=JSON.stringify(plan);for(const denied of ['storage_key','encryption_key_id','roomId','messageId','Source body','sha256'])assert(!serialized.includes(denied));
 await assert.rejects(f.db.query("UPDATE operations_file_cleanup_items_v1 SET expected_version='bypass' WHERE plan_id=$1",[plan.id]),/permission denied/);
 await assert.rejects(f.db.query('SELECT public.galaxy_worker_lock_file_cleanup_sources($1,$2,$3,$4)',[f.endpoint,plan.id,items[0].kind,items[0].id]),/permission denied/);
 await f.db.exec('SET ROLE galaxy_evidence_worker');
 await assert.rejects(f.db.query('SELECT public.galaxy_worker_lock_file_cleanup_sources($1,$2,$3,$4)',[f.endpoint,plan.id,items[0].kind,items[0].id]),/file_cleanup_approved_item_required/);
 await assert.rejects(f.db.query("UPDATE operations_file_cleanup_plans_v1 SET approved_by='worker' WHERE id=$1",[plan.id]),/permission denied/);
 await assert.rejects(f.db.query('UPDATE chat_message_refs SET revision=revision WHERE false'),/permission denied/);
 await assert.rejects(f.db.query('UPDATE forum_versions_v1 SET state=state WHERE false'),/permission denied/);
 await f.db.exec('SET ROLE galaxy_api');
 await assert.rejects(f.cleanup.approve(f.reader,plan.id,{operationId:randomUUID(),expectedRevision:plan.revision},{authorize:async()=>f.reader}),{code:'operations_permission_denied'});
 await f.db.exec('RESET ROLE');const before=f.eraseCalls.length;assert.equal((await f.cleanup.processApproved()).processed,0);assert.equal(f.eraseCalls.length,before);
 await f.db.exec('SET ROLE galaxy_api');const approvalInput={operationId:randomUUID(),expectedRevision:plan.revision},approved=await f.cleanup.approve(f.admin,plan.id,approvalInput,f.authorization);assert.equal(approved.plan.state,'queued');
 assert.equal((await f.cleanup.approve(f.admin,plan.id,approvalInput,f.authorization)).replayed,true);
 await assert.rejects(f.cleanup.approve(f.admin,plan.id,{...approvalInput,expectedRevision:plan.revision+1},f.authorization),{code:'business_admin_operation_conflict'});
 assert.equal((await f.cleanup.operation(f.admin,approvalInput.operationId)).state,'recorded');
 await f.db.exec('SET ROLE galaxy_evidence_worker');await assert.rejects(f.db.query("INSERT INTO operations_file_cleanup_plans_v1(id,endpoint,revision,state,created_by,created_at,reason,item_count,declared_bytes) VALUES($1,$2,1,'queued','worker',now(),'',1,1)",[randomUUID(),f.endpoint]),/permission denied/);
 // The ordinary worker pass must not rewrite a newly approved operational
 // selection into a different CAS position just by marking it purge_pending.
 await f.files.purgeExpired({limit:100});await f.forumFiles.purgeExpired({limit:100});
 await f.cleanup.processApproved({limit:2});assert.equal(f.eraseCalls.length,before+2);
 await f.db.exec('SET ROLE galaxy_api');const done=await f.cleanup.plan(f.reader,plan.id);assert.equal(done.state,'completed');assert.equal(done.counts.removed,2);assert(done.items.every(item=>item.objectRemoved===true));assert.equal(done.impact.physicalBlocksReleased,null);
 await f.cleanup.approve(f.admin,plan.id,approvalInput,f.authorization);await f.db.exec('SET ROLE galaxy_evidence_worker');assert.equal((await f.cleanup.processApproved()).processed,0);assert.equal(f.eraseCalls.length,before+2);
 await f.db.exec('RESET ROLE');
});

test('approved cleanup rechecks current references and authority, reconciles a lost delete ACK, and cancels only its fixed plan',{timeout:90000},async t=>{
 const f=await fixture(t),late=await f.upload(),changed=await f.upload(),denied=await f.upload();f.advance(30*86400+1);
 const choices=(await f.cleanup.candidates(f.admin,{limit:50})).items,find=id=>choices.find(item=>item.id===id),plan=(await f.create([find(late.id),find(changed.id)])).plan;
 await f.approve(plan);await f.db.query('UPDATE chat_attachments SET operations_retry_revision=operations_retry_revision+1 WHERE id=$1',[changed.id]);
 const key='attachments/'+late.id;f.failAfterDelete.add(key);await f.cleanup.processApproved({limit:2});
 let state=await f.cleanup.plan(f.admin,plan.id);assert.equal(state.counts['result-unknown'],1);assert.equal(state.counts.skipped,1);assert.equal(f.eraseCalls.filter(value=>value===key).length,1);assert.equal(f.objects.has(key),false);
 assert.equal((await f.db.query('SELECT purged_at FROM chat_attachments WHERE id=$1',[late.id])).rows[0].purged_at,null,'lost ACK remains explicitly unconfirmed');
 f.advance(31);await f.cleanup.processApproved();state=await f.cleanup.plan(f.admin,plan.id);assert.equal(state.counts.removed,1);assert.equal(state.state,'completed');assert.equal(f.eraseCalls.filter(value=>value===key).length,1,'HEAD reconciliation does not issue a second delete');
 assert(f.objects.has('attachments/'+changed.id));
 const deniedPlan=(await f.create([find(denied.id)])).plan;await f.approve(deniedPlan);f.authority.roles.set(f.admin.operatorId,null);const before=f.eraseCalls.length;await f.cleanup.processApproved();assert.equal(f.eraseCalls.length,before);assert(f.objects.has('attachments/'+denied.id));
 f.authority.roles.set(f.admin.operatorId,'administrator');f.advance(31);await f.cleanup.processApproved();assert(!f.objects.has('attachments/'+denied.id));
 const cancelFile=await f.upload();f.advance(30*86400+1);const current=(await f.cleanup.candidates(f.admin,{limit:50})).items.find(item=>item.id===cancelFile.id),cancelPlan=(await f.create([current])).plan;
 const cancelled=await f.cleanup.cancel(f.admin,cancelPlan.id,{operationId:randomUUID(),expectedRevision:cancelPlan.revision},f.authorization);assert.equal(cancelled.plan.state,'cancelled');const afterCancel=f.eraseCalls.length;await f.cleanup.processApproved({limit:20});assert.equal(f.eraseCalls.length,afterCancel);
 // A parent's withdrawal is not the reply attachment owner's deletion.
 const replyFile=await f.upload('forum',f.people[1]),parent=await f.post(f.people[0]);
 const reply=await bindForumIds('create-reply','account:'+f.people[1].accountId,{schemaVersion:1,operationId:randomUUID(),replyId:randomUUID(),expectedRevision:0,accountId:f.people[1].accountId,postId:parent.postId,postVersionId:parent.versionId,replyTo:null,body:'Independent reply source.',publishedUntil:f.now()+3600,audience:f.everyone,attachments:[{id:replyFile.id,sha256:replyFile.input.sha256}]});await f.forum.createReply(f.people[1],{payloadJson:JSON.stringify(reply)});
 await f.withdrawPost(f.people[0],parent);await f.forumFiles.purgeExpired();assert(f.objects.has('forum-attachments/'+replyFile.id));
 // A second source becomes unreferenced after the preceding legacy worker
 // pass. A real new bind can still commit before the next worker claims it.
 const reboundFile=await f.upload('forum',f.people[1]),reboundParent=await f.post(f.people[0]);
 const reboundReply=await bindForumIds('create-reply','account:'+f.people[1].accountId,{schemaVersion:1,operationId:randomUUID(),replyId:randomUUID(),expectedRevision:0,accountId:f.people[1].accountId,postId:reboundParent.postId,postVersionId:reboundParent.versionId,replyTo:null,body:'Independent current source.',publishedUntil:f.now()+3600,audience:f.everyone,attachments:[{id:reboundFile.id,sha256:reboundFile.input.sha256}]});await f.forum.createReply(f.people[1],{payloadJson:JSON.stringify(reboundReply)});await f.withdrawPost(f.people[0],reboundParent);
 const unreferenced=(await f.cleanup.candidates(f.admin,{kind:'forum',limit:50})).items.find(item=>item.id===reboundFile.id);assert(unreferenced?.eligible);assert.equal(unreferenced.reason,'unreferenced');
 const sourcePlan=(await f.create([unreferenced])).plan;await f.approve(sourcePlan);
 await f.post(f.people[1],{attachments:[{id:reboundFile.id,sha256:reboundFile.input.sha256}],publishedUntil:f.now()+7200});
 const beforeChanged=f.eraseCalls.length;await f.cleanup.processApproved();const refreshed=await f.cleanup.plan(f.admin,sourcePlan.id);assert.equal(refreshed.counts.skipped,1);assert.equal(f.eraseCalls.length,beforeChanged);assert(f.objects.has('forum-attachments/'+reboundFile.id));
 const audit=(await f.db.query("SELECT selection,result FROM business_admin_audit_v1 WHERE action LIKE 'file-cleanup-%'")).rows;assert(!JSON.stringify(audit).includes('清理测试.txt'));assert(!JSON.stringify(audit).includes('Independent reply source.'));
});

test('the real S3 attachment adapter accepts the existing forum namespace and keeps key boundaries closed',async t=>{
 const values=new Map(),requests=[];const server=createServer(async(req,res)=>{requests.push(req.method);const key=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname.slice('/bucket/'.length));
  if(req.method==='PUT'){const chunks=[];for await(const chunk of req)chunks.push(chunk);values.set(key,{bytes:Buffer.concat(chunks),sha256:req.headers['x-amz-meta-sha256']});res.writeHead(200).end();}
  else if(req.method==='HEAD'){const row=values.get(key);if(!row){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Length':row.bytes.length,'x-amz-meta-sha256':row.sha256}).end();}
  else if(req.method==='DELETE'){values.delete(key);res.writeHead(204).end();}else res.writeHead(405).end();
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const store=new AttachmentS3Store({endpoint:'http://127.0.0.1:'+server.address().port,bucket:'bucket',credentials:{accessKeyId:'synthetic-only',secretAccessKey:'synthetic-only'},sseKeyId:'synthetic-only',sseKey:Buffer.alloc(32,7)});t.after(()=>store.close());
 const key='forum-attachments/'+randomUUID(),bytes=Buffer.from('Local S3 transport fixture.'),sha256=createHash('sha256').update(bytes).digest('hex');
 await store.put({key,bytes,sha256});assert.deepEqual(await store.head({key,keyId:'synthetic-only'}),{size:bytes.length,sha256});assert.equal((await store.erase({key})).objectRemoved,true);assert.equal(await store.head({key,keyId:'synthetic-only'}),null);
 const count=requests.length;for(const key of ['forum-attachments/../private','forum-attachments/'+randomUUID()+'/extra','https://else.invalid/a','unapproved/'+randomUUID()])await assert.rejects(store.head({key,keyId:'synthetic-only'}),{code:'attachment_storage_key_invalid'});assert.equal(requests.length,count);assert.deepEqual(requests,['PUT','HEAD','DELETE','HEAD']);
});
