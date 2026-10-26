import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsFeedbackService} from '../src/operations-feedback.mjs';
import {FeedbackAttachmentsV1Service} from '../src/feedback-attachments-v1.mjs';
import {ForumAttachmentsV1Service} from '../src/forum-attachments-v1.mjs';
import {AttachmentS3Store} from '../src/infrastructure/attachment-s3-store.mjs';
import {defaultAttachmentPolicy} from '../src/shared/chat-attachments-schema.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {createOfficialAccountPortal} from '../src/official-account.mjs';
import {createApi} from '../src/http.mjs';
import {migrate} from '../src/database.mjs';

async function fixture(t,{policy=defaultAttachmentPolicy,feedbackPolicy}={}){
 const f=await accountChatFixture();t.after(f.close);const objects=new Map(),roles=new Map(),store={keyId:'synthetic-feedback-only',
  async put({key,bytes}){objects.set(key,Buffer.from(bytes));},async get({key}){return objects.get(key);},async erase(){throw Error('No automatic erase is authorized in this fixture');}},
  scanner={scan:async()=>({state:'clean',engine:'explicit-scanner-contract',guaranteedSafe:false})},
  files=new FeedbackAttachmentsV1Service({db:f.db,endpoint:f.endpoint,accounts:f.accounts,now:f.now,store,scanner,policy,feedbackPolicy}),
  businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now,operatorAuthorization:async actor=>roles.get(actor.operatorId)}),
  feedback=new OperationsFeedbackService({businessAdmin,accounts:f.accounts,feedbackAttachments:files,now:f.now}),
  admin={kind:'business-operator',operatorId:'feedback-file-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'feedback-file-reader',role:'reader'};
 for(const actor of [admin,reader]){roles.set(actor.operatorId,actor.role);await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.org',$1,'合成附件检查人员',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);}
 const prepare=async(actor,operationId,bytes=Buffer.from('PRIVATE_FILE_BYTES'),name='PRIVATE_FILE_NAME.txt')=>{
  const input={operationId,attachmentId:randomUUID(),name,mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)};
  return {input,bytes,receipt:await files.prepare(actor,input)};
 };
 const upload=(actor,file,bytes=file.bytes)=>files.upload(actor,file.input.attachmentId,Readable.from([bytes]),{contentLength:bytes.length,contentType:'application/octet-stream'});
 const reference=file=>({id:file.input.attachmentId,sha256:file.input.sha256});
 return {...f,objects,roles,store,scanner,files,businessAdmin,feedback,admin,reader,prepare,upload,reference};
}

test('private feedback files use exact account/draft ownership, real SQL binding and current feedback read permission',{timeout:60000},async t=>{
 const f=await fixture(t),[owner,other]=f.people,operationId=randomUUID();await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const file=await f.prepare(owner,operationId),target={operationId,attachmentId:file.input.attachmentId};
 assert.equal((await f.files.get(owner,target)).state,'prepared');
 await assert.rejects(f.files.get(other,target),{code:'feedback_attachment_unavailable'});
 await assert.rejects(f.files.get(owner,{...target,operationId:randomUUID()}),{code:'feedback_attachment_unavailable'});
 await assert.rejects(f.files.prepare({...owner,kind:'subject'},file.input),{code:'official_account_login_required'});
 await assert.rejects(f.upload(other,file),{code:'feedback_attachment_unavailable'});
 assert.equal((await f.upload(owner,file)).state,'scan-pending');
 const submission={operationId,body:'PRIVATE_FEEDBACK_BODY',attachments:[f.reference(file)]};
 await assert.rejects(f.feedback.submit(owner,submission),{code:'feedback_attachment_not_ready'});
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_feedback_v1')).rows[0].n,0,'failed attachment binding rolls back the feedback head');
 await f.db.exec('RESET ROLE');await migrate(f.db,{roles:['worker']});await f.db.exec('SET ROLE galaxy_evidence_worker');
 f.scanner.scan=async()=>{throw new ServiceError('attachment_scanner_signatures_stale',503);};
 assert.equal((await f.files.scanPending()).scanned,0);assert.equal((await f.files.row(f.db,file.input.attachmentId)).state,'scan-pending');
 f.advance(61);f.scanner.scan=async()=>({state:'clean',engine:'explicit-scanner-contract',guaranteedSafe:false});assert.equal((await f.files.scanPending()).scanned,1);
 await f.db.exec('RESET ROLE');await f.db.exec('SET ROLE galaxy_api');
 const receipt=await f.feedback.submit(owner,submission),detail=await f.feedback.get(f.reader,receipt.feedbackId);
 assert.equal(detail.feedback.attachmentCount,1);assert.equal(detail.feedback.attachments[0].availability,'available');assert.equal(detail.feedback.attachments[0].url,null);
 assert.equal((await f.feedback.list(f.reader)).items[0].attachmentCount,1);
 const content=await f.feedback.attachmentContent(f.reader,receipt.feedbackId,file.input.attachmentId);assert.deepEqual(content.bytes,file.bytes);
 await assert.rejects(f.files.get(owner,target),{code:'feedback_attachment_unavailable'});
 await assert.rejects(f.files.revoke(owner,target),{code:'feedback_attachment_draft_closed'});
 await assert.rejects(f.feedback.attachmentContent(f.reader,randomUUID(),file.input.attachmentId),{code:'not_found'});
 let checks=0;await assert.rejects(f.feedback.attachmentContent(f.reader,receipt.feedbackId,file.input.attachmentId,{authorize:async()=>{
  checks++;if(checks===2)throw new ServiceError('business_admin_denied',403);return f.reader;
 }}),{code:'business_admin_denied'});assert.equal(checks,2,'permission is checked again after storage read');
 const originalGet=f.store.get;f.store.get=async input=>{const bytes=await originalGet(input);f.advance(31*86400);return bytes;};
 await assert.rejects(f.feedback.attachmentContent(f.reader,receipt.feedbackId,file.input.attachmentId),{code:'feedback_attachment_content_unavailable'});
 assert.equal((await f.feedback.get(f.reader,receipt.feedbackId)).feedback.attachments[0].state,'expired');
 assert.equal((await f.feedback.submit(owner,submission)).replayed,true,'lost acknowledgement is recoverable after file expiry');
 assert.equal(typeof f.files.purgeExpired,'undefined');assert.equal(f.files.specification().automaticPhysicalCleanup,false);assert.equal(f.objects.size,1,'expiry does not silently erase a business file');
 const audit=JSON.stringify((await f.db.query('SELECT selection,result FROM business_admin_audit_v1')).rows);
 for(const secret of ['PRIVATE_FILE_BYTES','PRIVATE_FILE_NAME','PRIVATE_FEEDBACK_BODY','feedback-attachments/','https://signed'])assert.equal(audit.includes(secret),false);
 await f.db.exec('RESET ROLE');
});

test('feedback attachment byte validation, quarantine, expiry and same-operation binding fail closed',{timeout:60000},async t=>{
 const f=await fixture(t,{feedbackPolicy:{draftRetentionDays:1,submittedRetentionDays:2}}),[owner,other]=f.people,
  operationId=randomUUID(),bad=await f.prepare(owner,operationId,Buffer.from('expected'));
 await assert.rejects(f.upload(owner,bad,Buffer.from('bad')),{code:'attachment_size_mismatch'});
 assert.equal((await f.files.get(owner,{operationId,attachmentId:bad.input.attachmentId})).state,'prepared','a length mismatch before accepting a stream does not create file content');
 await assert.rejects(f.files.upload(owner,bad.input.attachmentId,Readable.from([Buffer.from('changed!')]),{contentLength:bad.bytes.length,contentType:'application/octet-stream'}),{code:'attachment_digest_mismatch'});
 assert.equal((await f.files.get(owner,{operationId,attachmentId:bad.input.attachmentId})).state,'blocked');
 const blocked=await f.prepare(owner,operationId);await f.upload(owner,blocked);f.scanner.scan=async()=>({state:'blocked',engine:'explicit-contract',reason:'scanner-detection'});await f.files.scanPending();
 await assert.rejects(f.feedback.submit(owner,{operationId,body:'隔离文件不能提交',attachments:[f.reference(blocked)]}),{code:'feedback_attachment_not_ready'});
 const otherFile=await f.prepare(other,randomUUID()),wrongDraft=await f.prepare(owner,randomUUID());
 for(const file of [otherFile,wrongDraft]){await f.upload(file===otherFile?other:owner,file);}
 f.scanner.scan=async()=>({state:'clean',engine:'explicit-contract'});await f.files.scanPending({limit:2});
 for(const file of [otherFile,wrongDraft])await assert.rejects(f.feedback.submit(owner,{operationId,body:'不能借用其他文件',attachments:[f.reference(file)]}),{code:'feedback_attachment_unavailable'});
 const valid=await f.prepare(owner,operationId);await f.upload(owner,valid);await f.files.scanPending();
 await assert.rejects(f.feedback.submit(owner,{operationId,body:'摘要必须吻合',attachments:[{id:valid.input.attachmentId,sha256:'0'.repeat(64)}]}),{code:'feedback_attachment_not_ready'});
 f.advance(86401);await assert.rejects(f.feedback.submit(owner,{operationId,body:'过期后不能绑定',attachments:[f.reference(valid)]}),{code:'feedback_attachment_not_ready'});
 const noStorage=new FeedbackAttachmentsV1Service({db:f.db,endpoint:f.endpoint,accounts:f.accounts,now:f.now});
 assert.equal(noStorage.specification().supported,false);assert.equal(noStorage.specification().storageRuntimeVerified,false);
 await assert.rejects(noStorage.prepare(owner,{...valid.input,operationId:randomUUID(),attachmentId:randomUUID()}),{code:'attachment_service_unavailable'});
 const textOnly=new OperationsFeedbackService({businessAdmin:f.businessAdmin,accounts:f.accounts,now:f.now}),plain={operationId:randomUUID(),body:'没有附件仍可提交'};
 assert.equal((await textOnly.submit(owner,plain)).replayed,false);assert.equal((await textOnly.submit(owner,{...plain,attachments:[]})).replayed,true);
 const id=randomUUID();assert.equal(AttachmentS3Store.prototype.key('feedback-attachments/'+id),'feedback-attachments/'+id);
 for(const key of ['feedback-attachments/../'+id,'public/'+id,'forum-attachments/'+id])assert.throws(()=>AttachmentS3Store.prototype.key(key),{code:'attachment_storage_key_invalid'});
});

test('feedback reservations and upload leases participate in the existing shared account/global quotas',{timeout:60000},async t=>{
 const policy={...defaultAttachmentPolicy,maxFileBytes:90,maxSubjectBytes:100,maxGlobalBytes:120},f=await fixture(t,{policy}),[owner,other]=f.people;
 f.files.policy=policy;f.chat.attachments.policy=policy;
 const roomId=await joinAccountConversation(f,owner,other),reservation=await f.prepare(owner,randomUUID(),Buffer.alloc(60,65));
 const forum=new ForumAttachmentsV1Service({db:f.db,accounts:f.accounts,now:f.now,store:f.store,scanner:f.scanner,policy}),prepare={attachmentId:randomUUID(),name:'quota.txt',mediaType:'text/plain',size:50,sha256:f.digest(Buffer.alloc(50,66))};
 await assert.rejects(forum.prepare(owner,prepare),{code:'attachment_storage_quota_exceeded'});
 await assert.rejects(f.chat.attachments.prepare(owner,{...prepare,roomId,purpose:'temporary-room-attachment',confirmed:true}),{code:'attachment_storage_quota_exceeded'});
 await assert.rejects(f.prepare(other,randomUUID(),Buffer.alloc(61,67)),{code:'attachment_storage_quota_exceeded'});
 await f.files.revoke(owner,{operationId:reservation.input.operationId,attachmentId:reservation.input.attachmentId});
 assert.equal(f.objects.size,0);await assert.rejects(f.prepare(owner,randomUUID(),Buffer.alloc(50,68)),{code:'attachment_storage_quota_exceeded'},'reserved bytes stay counted until an authorized physical cleanup');
 const leases=[],operationId=randomUUID();for(let index=0;index<4;index++)leases.push(await f.prepare(owner,operationId,Buffer.from('a'),'lease-'+index+'.txt'));
 await f.db.query("UPDATE feedback_attachments_v1 SET state='uploading',lease_until=$2 WHERE id=ANY($1::uuid[])",[leases.map(value=>value.input.attachmentId),new Date((f.now()+120)*1000)]);
 const chatInput={...prepare,attachmentId:randomUUID(),size:1,sha256:f.digest(Buffer.from('b')),roomId,purpose:'temporary-room-attachment',confirmed:true};await f.chat.attachments.prepare(owner,chatInput);
 await assert.rejects(f.chat.attachments.upload(owner,chatInput.attachmentId,Readable.from([Buffer.from('b')]),{contentLength:1}),{code:'attachment_upload_capacity'});
 const forumInput={attachmentId:randomUUID(),name:'lease.txt',mediaType:'text/plain',size:1,sha256:f.digest(Buffer.from('c'))};await forum.prepare(owner,forumInput);
 await assert.rejects(forum.upload(owner,forumInput.attachmentId,Readable.from([Buffer.from('c')]),{contentLength:1}),{code:'attachment_upload_capacity'});
 const feedbackLease=await f.prepare(other,randomUUID(),Buffer.from('d'));await assert.rejects(f.upload(other,feedbackLease),{code:'attachment_upload_capacity'});
});

test('feedback attachment HTTP is account/CSRF bound, exposes no owner downloads, and returns private operator bytes',{timeout:60000},async t=>{
 const f=await fixture(t),website='https://galaxy.example.org',adminOrigin='https://admin.example.org',provider={describe:()=>({issuer:'https://login.example.org',clientId:'feedback-attachment-fixture',redirectUri:f.endpoint+'/v1/account/callback'})},
  portal=createOfficialAccountPortal({provider,db:f.db,endpoint:f.endpoint,websiteOrigin:website,associationProviders:[provider],now:f.now}),token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),owner=f.people[0],logs=[];
 await f.db.query(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at)
  VALUES($1,$2,$3,$4,'https://login.example.org','synthetic-0','feedback@example.invalid',true,$5,$6,$7)`,[portal.configurationHash,f.digest(token),f.digest('attachment-login'),owner.accountId,csrf,f.now(),f.now()+3600]);
 const authorizeOperator=async(request,{write,csrf:needsCsrf})=>{
  if(request.headers.origin!==adminOrigin||(write||needsCsrf)&&request.headers['x-galaxy-operator-csrf']!=='synthetic-operator-csrf')throw new ServiceError('business_admin_denied',403);
  assert.equal(write,false,'file content remains a read role operation');assert.equal(needsCsrf,true);return f.reader;
 };
 const server=createApi({bindings:{endpoint:f.endpoint},officialAccounts:portal,operations:{portal:{authorizeOperator}},businessAdmin:f.businessAdmin,operationsFeedback:f.feedback,feedbackAttachments:f.files,
  browserOrigins:[website,adminOrigin],logger:entry=>logs.push(entry),rateLimit:250});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,headers={Origin:website,Cookie:'__Host-galaxy-account='+token,'Content-Type':'application/json','X-Galaxy-Account-ID':owner.accountId,'X-Galaxy-Account-CSRF':csrf},prefix='/v1/account/feedback/attachments/',operationId=randomUUID(),bytes=Buffer.from('HTTP_PRIVATE_FILE_BYTES'),input={operationId,attachmentId:randomUUID(),name:'HTTP_PRIVATE_FILE_NAME.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)},
  post=(path,value,extra={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
 const config=await post(prefix+'config',{});assert.equal(config.status,200);assert.equal((await config.json()).supported,true);
 for(const extra of [{Cookie:''},{'X-Galaxy-Account-CSRF':'bad'},{'X-Galaxy-Account-ID':f.people[1].accountId},{Authorization:'Bearer forbidden'}]){const denied=await post(prefix+'prepare',input,extra);assert.ok([401,403,409].includes(denied.status));await denied.arrayBuffer();}
 assert.equal((await post(prefix+'prepare',input)).status,200);
 const path=prefix+input.attachmentId+'/upload',preflight=await fetch(base+path,{method:'OPTIONS',headers:{Origin:website,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type,x-galaxy-account-id,x-galaxy-account-csrf'}});
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
 const uploaded=await fetch(base+path,{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:bytes});assert.equal(uploaded.status,200);assert.equal((await uploaded.json()).state,'scan-pending');await f.files.scanPending();
 const accepted=await post('/v1/account/feedback',{operationId,body:'HTTP_PRIVATE_FEEDBACK_BODY',attachments:[{id:input.attachmentId,sha256:input.sha256}]});assert.equal(accepted.status,201);const receipt=await accepted.json();
 assert.equal((await fetch(base+prefix+input.attachmentId+'/content',{method:'POST',headers,body:'{}'})).status,404);
 assert.equal((await fetch(base+'/v1/account/feedback/'+receipt.feedbackId,{headers})).status,404);
 const download='/v1/operations/feedback/'+receipt.feedbackId+'/attachments/'+input.attachmentId+'/content';
 const missing=await post(download,{}, {Origin:adminOrigin});assert.equal(missing.status,403);await missing.arrayBuffer();
 const result=await post(download,{}, {Origin:adminOrigin,'X-Galaxy-Operator-CSRF':'synthetic-operator-csrf'});assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'application/octet-stream');
 assert.match(result.headers.get('cache-control'),/no-store/);assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes);
 assert.equal((await fetch(base+download,{headers:{Origin:adminOrigin}})).status,404);
 for(const secret of ['HTTP_PRIVATE_FILE_BYTES','HTTP_PRIVATE_FILE_NAME','HTTP_PRIVATE_FEEDBACK_BODY'])assert.equal(JSON.stringify(logs).includes(secret),false);
});
