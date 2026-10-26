import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {CommunityForumV1} from '../src/community/community-forum-v1.mjs';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsFilesService} from "../src/operations/files/service.mjs";
import {ForumAttachmentsV1Service} from "../src/community/forum-attachments-v1.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';

// Authorization, aggregate SQL and CAS use real local PGlite. Metadata-only
// fixture rows describe lifecycle observations, not actual uploaded objects.
// Byte operations below use only the explicit RAM store/scanner fixture.
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),
  forum=new ForumAttachmentsV1Service({forum:new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),store:f.files.store,scanner:f.files.scanner}),
  files=new OperationsFilesService({businessAdmin,chatAttachments:f.files,forumAttachments:forum,now:f.now}),
  admin={kind:'business-operator',operatorId:'file-test-administrator',role:'administrator',endpoint:f.endpoint,httpRequestId:randomUUID()},
  reader={...admin,operatorId:'file-test-reader',role:'reader'};
 for(const operator of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://fixture.invalid',$1,'合成文件维护者',$3,$3)`,[operator.operatorId,f.endpoint,new Date(f.now()*1000)]);
 await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['files.read']});
 return{...f,businessAdmin,forum,operationsFiles:files,admin,reader,authorization:{authorize:async()=>admin}};
}
async function prepared(f,{id=randomUUID(),name='当前文件名.txt',bytes=Buffer.from('Synthetic bounded cache fixture.')}={}){
 const roomId=await joinAccountConversation(f,f.people[0],f.people[1]);
 const input={attachmentId:id,roomId,name,mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes),purpose:'temporary-room-attachment',confirmed:true};
 await f.files.prepare(f.people[0],input);return{input,bytes};
}

test('file metadata summary covers the full authorized selection, counts reservations rather than stored bytes and separates unknown cleanup from scan errors',async t=>{
 const f=await fixture(t),{input,bytes}=await prepared(f,{name:'资料  包.txt'}),chatIds=[input.attachmentId,...Array.from({length:29},()=>randomUUID())],forumIds=[input.attachmentId,...Array.from({length:6},()=>randomUUID())];
 await f.db.query(`INSERT INTO chat_attachments(id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at)
  SELECT next_id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,'attachments/'||next_id::text,encryption_key_id,created_at,prepare_expires_at
  FROM chat_attachments CROSS JOIN unnest($2::uuid[]) AS next_id WHERE id=$1`,[input.attachmentId,chatIds.slice(1)]);
 await f.forum.prepare(f.people[0],{attachmentId:forumIds[0],name:'公开用途另行安排.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)});
 await f.db.query(`INSERT INTO forum_attachments_v1(id,account_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at)
  SELECT next_id,account_id,subject_id,request_hash,name,media_type,byte_size,sha256,'forum-attachments/'||next_id::text,encryption_key_id,created_at,prepare_expires_at
  FROM forum_attachments_v1 CROSS JOIN unnest($2::uuid[]) AS next_id WHERE id=$1`,[forumIds[0],forumIds.slice(1)]);
 const at=new Date(f.now()*1000),past=new Date((f.now()-1)*1000),future=new Date((f.now()+3600)*1000);
 await f.db.query("UPDATE chat_attachments SET name='资料'||chr(13)||chr(10)||'包.txt' WHERE id=$1",[chatIds[0]]);
 await f.db.query("UPDATE chat_attachments SET state='scan-pending',uploaded_at=$2,expires_at=$3,scan_attempts=1,last_error='attachment_scanner_unavailable' WHERE id=$1",[chatIds[1],at,future]);
 await f.db.query("UPDATE chat_attachments SET state='available',uploaded_at=$2,expires_at=$3,purge_pending=true,last_error='attachment_cleanup_failed' WHERE id=$1",[chatIds[2],at,past]);
 await f.db.query("UPDATE chat_attachments SET uploaded_at=$2,last_error='attachment_size_mismatch' WHERE id=$1",[chatIds[3],at]);
 await f.db.query("UPDATE chat_attachments SET state='scanning',uploaded_at=$2,expires_at=$3,scan_attempts=1,lease_id=$4,lease_until=$3 WHERE id=$1",[chatIds[4],at,future,randomUUID()]);
 await f.db.query("UPDATE chat_attachments SET state='erased',name='',purged_at=$2 WHERE id=$1",[chatIds[5],at]);
 await f.db.query("UPDATE chat_attachments SET state='available',expires_at=$2,scan_result=$3 WHERE id=$1",[chatIds[6],future,JSON.stringify({state:'clean',checkedAt:f.now()})]);
 await f.db.query('UPDATE chat_attachments SET revoked_at=$2,purge_pending=true WHERE id=$1',[chatIds[7],at]);
 // A foreign endpoint account does not acquire metadata visibility merely by
 // sharing the same physical DB. These rows are deliberate fixture metadata.
 const foreign=randomUUID(),foreignChat=randomUUID(),foreignForum=randomUUID();
 await f.db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
  VALUES($1,'https://foreign.example.invalid','https://login.example.org','foreign-file-owner','external-account',$2,$2)`,[foreign,at]);
 await f.db.query("INSERT INTO chat_participants_v3(actor_ref,kind,account_id) VALUES($1,'official-account',$2) ON CONFLICT DO NOTHING",['account:'+foreign,foreign]);
 await f.db.query(`INSERT INTO chat_attachments(id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at)
  SELECT $2::uuid,room_id,$3,request_hash,'foreign chat name',media_type,byte_size,sha256,'attachments/'||$2::text,encryption_key_id,created_at,prepare_expires_at FROM chat_attachments WHERE id=$1`,[input.attachmentId,foreignChat,'account:'+foreign]);
 await f.db.query(`INSERT INTO forum_attachments_v1(id,account_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,created_at,prepare_expires_at)
  SELECT $2::uuid,$3,request_hash,'foreign forum name',media_type,byte_size,sha256,'forum-attachments/'||$2::text,encryption_key_id,created_at,prepare_expires_at FROM forum_attachments_v1 WHERE id=$1`,[forumIds[0],foreignForum,foreign]);
 const noBytes=async()=>{throw Error('A metadata read must never fetch or erase bytes.');};f.files.store.get=noBytes;f.files.store.head=noBytes;f.files.store.erase=noBytes;
 const first=await f.operationsFiles.list(f.reader,{limit:25}),summary=await f.operationsFiles.summary(f.reader);
 assert.equal(first.items.length,25);assert(first.nextAfter);assert.equal(summary.totals.records,37);assert.equal(summary.totals.reservedBytes,36*bytes.length);assert.equal(summary.totals.actualStoredBytes,null);
 assert.equal(summary.totals.readyFiles,1);assert.equal(summary.totals.pendingScan,2);assert.equal(summary.totals.scanFailed,1);assert.equal(summary.totals.expired,1);assert.equal(summary.totals.revoked,1);assert.equal(summary.totals.removed,1);
 assert.equal(summary.totals.cleanupPending,1);assert.equal(summary.totals.cleanupResultUnknown,1);assert.equal(summary.totals.cleanupRunning,null);assert.equal(summary.totals.cleanupFailed,null);
 assert.deepEqual(summary.byKind.map(row=>[row.kind,row.records]),[['chat',30],['forum',7]]);
 const next=await f.operationsFiles.list(f.reader,{limit:25,after:first.nextAfter});assert.equal(next.items.length,12);assert.equal(next.nextAfter,null);
 assert.equal(new Set([...first.items,...next.items].map(row=>row.kind+':'+row.id)).size,37);
 assert.equal((await f.operationsFiles.summary(f.reader,{issue:'any'})).totals.records,3);
 assert.equal((await f.operationsFiles.summary(f.reader,{issue:'scan'})).totals.records,1);
 assert.equal((await f.operationsFiles.list(f.reader,{issue:'cleanup'})).items[0].id,chatIds[2]);
 assert.equal((await f.operationsFiles.summary(f.reader,{kind:'forum'})).totals.records,7);
 assert.equal((await f.operationsFiles.summary(f.reader,{state:'expired'})).totals.records,1);
 assert.equal((await f.operationsFiles.summary(f.reader,{processing:'cleanup'})).totals.records,2);
 const preparedView=await f.operationsFiles.get(f.reader,'chat',chatIds[0]),unknown=await f.operationsFiles.get(f.admin,'chat',chatIds[2]),uploadError=await f.operationsFiles.get(f.reader,'chat',chatIds[3]),running=await f.operationsFiles.get(f.reader,'chat',chatIds[4]);
 assert.equal(preparedView.name,'资料  包.txt');assert.equal(preparedView.accounting.actualStoredBytes,null);assert.equal(preparedView.uploadedAt,null);
 assert.equal(unknown.cleanup.state,'result-unknown');assert.equal(unknown.cleanup.failureObserved,null);assert.equal(unknown.cleanup.physicalBlocksReleased,null);assert.equal(unknown.canRetryCleanup,false);
 assert.equal(uploadError.cleanup.state,'not-requested');assert.equal(running.scan.state,'running');assert.equal(running.cleanup.executionObserved,false);
 assert.deepEqual(preparedView.history.items.map(item=>item.kind),['prepared']);assert.equal(preparedView.history.fullProcessingHistoryAvailable,false);
 assert.equal(summary.policy.relay.enabled,false);assert.equal(summary.policy.relay.ttlSeconds,null);assert.equal(summary.policy.existing.chat.retentionDays,30);
 for(const key of ['roomId','messageId','body','url','storage_key','encryption_key_id','scan_result'])assert.equal(Object.hasOwn(preparedView,key),false);
 await assert.rejects(f.operationsFiles.get(f.reader,'chat',foreignChat),{code:'not_found'});await assert.rejects(f.operationsFiles.get(f.reader,'forum',foreignForum),{code:'not_found'});
 const noRuntime=new OperationsFilesService({businessAdmin:f.businessAdmin,now:f.now});assert.equal((await noRuntime.get(f.reader,'chat',chatIds[0])).processingAvailable,false);
 assert.equal((await noRuntime.summary(f.reader)).totals.records,37);
 const audit=await f.db.query("SELECT selection,result FROM business_admin_audit_v1 WHERE action IN ('files-query','file-read')");
 assert.equal(JSON.stringify(audit.rows).includes('资料'),false);assert.equal(JSON.stringify(audit.rows).includes('foreign chat name'),false);
});

test('file scan retry revalidates request authority, exact versions and leases while legacy cleanup cannot replay an unapproved deletion',{timeout:60000},async t=>{
 const f=await fixture(t),{input,bytes}=await prepared(f,{name:'不进入通用审计的名字.txt'});
 await f.files.upload(f.people[0],input.attachmentId,Readable.from([bytes]),{contentLength:bytes.length});
 f.files.scanner.scan=async()=>{throw new ServiceError('attachment_scanner_unavailable',503);};await f.files.scanPending();
 const current=await f.operationsFiles.get(f.admin,'chat',input.attachmentId),make=(file=current)=>({operationId:randomUUID(),kind:'scan',expectedVersion:file.processingVersion,reason:'恢复同一文件的扫描处理。'}),x=make();
 const retry=(body=x,authorization=f.authorization)=>f.operationsFiles.retry(f.admin,'chat',input.attachmentId,body,authorization);
 await assert.rejects(f.operationsFiles.retry(f.reader,'chat',input.attachmentId,x,f.authorization),{code:'business_admin_denied'});
 await assert.rejects(retry(x,{}),{code:'operations_authorization_unavailable'});
 await assert.rejects(retry({...x,role:'administrator'}),{code:'invalid_operations_request'});
 await assert.rejects(retry({...x,expectedVersion:'stale'}),{code:'operations_file_changed'});
 let calls=0;await assert.rejects(retry(x,{authorize:async()=>++calls===4?f.reader:f.admin}),{code:'operations_permission_denied'});
 assert.equal((await f.operationsFiles.get(f.admin,'chat',input.attachmentId)).version,current.version);
 await assert.rejects(retry(x,{authorize:async()=>({...f.admin,operatorId:'different-operator'})}),{code:'business_admin_denied'});
 await assert.rejects(retry(x,{authorize:async()=>({...f.admin,endpoint:'https://other.example.invalid'})}),{code:'business_admin_denied'});
 const originalLease=(await f.db.query('SELECT lease_until FROM chat_attachments WHERE id=$1',[input.attachmentId])).rows[0].lease_until;
 await f.db.query('UPDATE chat_attachments SET lease_id=$2,lease_until=$3 WHERE id=$1',[input.attachmentId,randomUUID(),new Date((f.now()+120)*1000)]);
 const busy=await f.operationsFiles.get(f.admin,'chat',input.attachmentId);assert.equal(busy.activeLease,true);assert.equal(busy.canRetryScan,false);
 await assert.rejects(retry(make(busy)),{code:'operations_file_retry_unavailable'});
 await f.db.query('UPDATE chat_attachments SET lease_id=NULL,lease_until=$2 WHERE id=$1',[input.attachmentId,originalLease]);
 const expiry=current.expiresAt,receipt=await retry();assert.equal(receipt.state,'scheduled');assert.equal(receipt.processingComplete,false);assert.equal(receipt.file.retriesRemaining,2);assert.equal(receipt.file.expiresAt,expiry);
 assert.equal((await retry()).replayed,true);await assert.rejects(retry({...x,reason:'更换意图不可复用同一标识。'}),{code:'business_admin_operation_conflict'});
 const stored=(await f.db.query('SELECT selection,result FROM business_admin_audit_v1 WHERE operation_id=$1',[x.operationId])).rows[0];
 assert.equal(Object.hasOwn(stored.result,'file'),false);assert.equal(JSON.stringify(stored).includes('不进入通用审计'),false);
 let file=receipt.file;for(let i=0;i<2;i++)file=(await retry(make(file))).file;
 assert.equal(file.retriesRemaining,0);assert.equal(file.canRetryScan,false);await assert.rejects(retry(make(file)),{code:'operations_file_retry_limit'});
 const history=await f.operationsFiles.get(f.reader,'chat',input.attachmentId);assert.equal(history.history.items.filter(item=>item.kind==='scan-retry').length,3);
 await f.db.query('UPDATE chat_attachments SET purge_pending=true WHERE id=$1',[input.attachmentId]);
 const pending=await f.operationsFiles.get(f.admin,'chat',input.attachmentId),cleanup={operationId:randomUUID(),kind:'cleanup',expectedVersion:pending.version,reason:'旧排队标记没有本次具体计划授权。'};
 await f.businessAdmin.recordWithin(f.db,f.admin,'file-retry',{operationId:cleanup.operationId,selection:{kind:'chat',id:input.attachmentId,resourceId:input.attachmentId,command:cleanup,operationId:cleanup.operationId},result:{state:'scheduled',file:{name:'旧回执不得作为当前批准'}}});
 await assert.rejects(retry(cleanup),{code:'operations_file_cleanup_authorization_required'});
 assert.equal((await f.operationsFiles.get(f.admin,'chat',input.attachmentId)).version,pending.version);
 // A live lease remains a real blocker independent of scan-error wording.
 await f.db.query("UPDATE chat_attachments SET purge_pending=false,lease_id=$2,lease_until=$3 WHERE id=$1",[input.attachmentId,randomUUID(),new Date((f.now()+120)*1000)]);
 const live=await f.operationsFiles.get(f.admin,'chat',input.attachmentId);assert.equal(live.canRetryScan,false);assert.equal(live.activeLease,true);
});
