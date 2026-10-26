import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsFeedbackService} from "../src/operations/feedback/service.mjs";
import {AccountFeedbackDataService} from '../src/operations/feedback/owner-data.mjs';
import {FeedbackAttachmentsV1Service} from "../src/community/feedback-attachments-v1.mjs";
import {migrate} from "../src/infrastructure/database.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';
import {createOfficialAccountPortal} from "../src/accounts/official-account.mjs";
import {createApi} from '../src/http.mjs';

// SQL, exact API/worker roles and cookie/CSRF processing are real. AV and byte
// storage are explicit local doubles; this suite never touches production.
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);const objects=new Map(),eraseCalls=[],headCalls=[],loseAck=new Set(),logs=[];
 const store={keyId:'feedback-owner-fixture',put:async({key,bytes,sha256})=>objects.set(key,{bytes:Buffer.from(bytes),sha256}),get:async({key})=>objects.get(key)?.bytes,
  head:async({key})=>{headCalls.push(key);const row=objects.get(key);return row?{size:row.bytes.length,sha256:row.sha256}:null;},
  erase:async({key})=>{eraseCalls.push(key);objects.delete(key);if(loseAck.delete(key))throw new ServiceError('attachment_storage_unavailable',503);return {objectRemoved:true};}};
 const files=new FeedbackAttachmentsV1Service({db:f.db,endpoint:f.endpoint,accounts:f.accounts,now:f.now,store,scanner:{scan:async()=>({state:'clean',engine:'explicit-fixture'})}}),
  businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),feedback=new OperationsFeedbackService({businessAdmin,accounts:f.accounts,feedbackAttachments:files,now:f.now}),
  ownerData=new AccountFeedbackDataService({db:f.db,endpoint:f.endpoint,accounts:f.accounts,feedbackAttachments:files,now:f.now,logger:entry=>logs.push(entry)}),
  admin={kind:'business-operator',operatorId:'feedback-data-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'feedback-data-reader',role:'reader'};
 for(const actor of [admin,reader])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://fixture.invalid',$1,'反馈管理者',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['feedback.read','feedback.attachments.read']});
 async function attachment(actor,operationId,name='本人材料.txt'){
  const bytes=Buffer.from('OWN_FEEDBACK_BYTES '+randomUUID()),id=randomUUID(),input={operationId,attachmentId:id,name,mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)};
  await files.prepare(actor,input);await files.upload(actor,id,Readable.from([bytes]),{contentLength:bytes.length});
  const role=(await f.db.query('SELECT current_user AS name')).rows[0].name;
  if(role==='galaxy_api'){await f.db.exec('SET ROLE galaxy_evidence_worker');try{await files.scanPending();}finally{await f.db.exec('SET ROLE galaxy_api');}}else await files.scanPending();
  return{id,bytes,input,key:'feedback-attachments/'+id};
 }
 async function submit(actor,{body='OWN_FEEDBACK_TEXT',fileCount=0}={}){const operationId=randomUUID(),attachments=[];for(let i=0;i<fileCount;i++)attachments.push(await attachment(actor,operationId));
  const input={operationId,body,category:'problem',module:'account',...(attachments.length?{attachments:attachments.map(file=>({id:file.id,sha256:file.input.sha256}))}:{})};
  return{input,attachments,receipt:await feedback.submit(actor,input)};
 }
 return{...f,objects,eraseCalls,headCalls,loseAck,logs,store,files,businessAdmin,feedback,ownerData,admin,reader,attachment,submit};
}

test('account feedback data uses real owner sessions, fixed export selection and irreversible owner tombstones under the real roles',{timeout:90000},async t=>{
 const f=await fixture(t),[owner,other]=f.people,website='https://website.example.org',provider={describe:()=>({issuer:'https://login.example.org',clientId:'feedback-data-fixture',redirectUri:f.endpoint+'/v1/account/callback'})},
  portal=createOfficialAccountPortal({provider,db:f.db,endpoint:f.endpoint,websiteOrigin:website,associationProviders:[provider],now:f.now}),token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
 await f.db.query(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at)
  VALUES($1,$2,$3,$4,'https://login.example.org','synthetic-0','fixture@example.invalid',true,$5,$6,$7)`,[portal.configurationHash,f.digest(token),f.digest('synthetic-login'),owner.accountId,csrf,f.now(),f.now()+3600]);
 await migrate(f.db,{roles:['api','worker']});await f.db.exec('SET ROLE galaxy_api');
 const first=await f.submit(owner,{fileCount:1}),foreign=await f.submit(other,{body:'FOREIGN_FEEDBACK_TEXT'});f.advance(61);const _second=await f.submit(owner,{body:'SECOND_OWN_FEEDBACK'});
 await f.feedback.event(f.admin,first.receipt.feedbackId,{operationId:randomUUID(),expectedRevision:1,state:'processing',note:'PRIVATE_OPERATOR_NOTE'});
 const server=createApi({bindings:{endpoint:f.endpoint},officialAccounts:portal,accountFeedbackData:f.ownerData,operationsFeedback:f.feedback,feedbackAttachments:f.files,browserOrigins:[website],logger:entry=>f.logs.push(entry),rateLimit:250});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,prefix='/v1/account/data/feedback',headers={Origin:website,Cookie:'__Host-galaxy-account='+token,'Content-Type':'application/json','X-Galaxy-Account-ID':owner.accountId,'X-Galaxy-Account-CSRF':csrf},
  post=(path,body,extra={})=>fetch(base+prefix+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)}),get=path=>fetch(base+prefix+path,{headers});
 for(const extra of [{'X-Galaxy-Account-CSRF':'bad'},{Cookie:''},{'X-Galaxy-Account-ID':other.accountId},{Authorization:'Bearer forbidden'}]){const response=await post('/export',{operationId:randomUUID()},extra);assert.ok([401,403,409].includes(response.status));await response.arrayBuffer();}
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM account_feedback_data_operations_v1')).rows[0].n,0);
 const exportId=randomUUID(),exportResponse=await post('/export',{operationId:exportId});assert.equal(exportResponse.status,201);const exported=await exportResponse.json();assert.equal(exported.feedbackCount,2);assert.equal(exported.attachmentCount,1);
 const firstPage=await (await get('/exports/'+exportId+'?limit=1')).json();assert.equal(firstPage.items.length,1);assert(firstPage.nextAfter);const next=await(await get('/exports/'+exportId+'?limit=1&after='+firstPage.nextAfter)).json();assert.equal(next.items.length,1);assert.equal(next.nextAfter,null);
 const safeExport=JSON.stringify([firstPage,next]);for(const hidden of ['PRIVATE_OPERATOR_NOTE','FOREIGN_FEEDBACK_TEXT','processing','storage_key','encryption_key_id'])assert(!safeExport.includes(hidden));
 const file=first.attachments[0],download='/exports/'+exportId+'/attachments/'+file.id+'/content',downloaded=await post(download,{});assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),file.bytes);
 let checks=0;await assert.rejects(f.ownerData.attachmentContent(owner,exportId,file.id,{authorize:async()=>++checks===1?owner:other}),{code:'official_account_changed'});assert.equal(checks,2);
 assert.equal((await f.ownerData.operation(other,exportId)).state,'not-recorded');await assert.rejects(f.ownerData.exportPage(other,exportId),{code:'not_found'});
 await assert.rejects(f.ownerData.export({...owner,kind:'linked-id',accountAuthorized:true},{operationId:randomUUID()}),{code:'official_account_login_required'});
 assert.equal((await get('/exports/'+exportId+'?limit=1&limit=2')).status,400);assert.equal((await post('/delete',{operationId:randomUUID(),accountId:other.accountId})).status,400);
 const deleteId=randomUUID(),deletedResponse=await post('/delete',{operationId:deleteId});assert.equal(deletedResponse.status,201);const deleted=await deletedResponse.json();assert.equal(deleted.metadataDeleted,true);assert.equal(deleted.phase,'pending');assert.equal(deleted.attachments.removed,0);assert.equal(f.eraseCalls.length,0);
 const deletedRow=(await f.db.query('SELECT title,body,submission_operation_id,owner_deleted_at FROM operations_feedback_v1 WHERE id=$1',[first.receipt.feedbackId])).rows[0];assert.equal(deletedRow.title,null);assert.equal(deletedRow.body,null);assert(deletedRow.owner_deleted_at);assert.equal(deletedRow.submission_operation_id,first.input.operationId);
 assert.deepEqual((await f.feedback.list(f.reader,{days:'all'})).items.map(row=>row.id),[foreign.receipt.feedbackId]);await assert.rejects(f.feedback.get(f.reader,first.receipt.feedbackId),{code:'not_found'});
 assert.equal((await post(download,{})).status,404);await assert.rejects(f.feedback.attachmentContent(f.reader,first.receipt.feedbackId,file.id),{code:'not_found'});
 const replay=await f.feedback.submit(owner,first.input);assert.equal(replay.replayed,true);assert.equal(replay.deleted,true);assert.equal(replay.feedbackId,first.receipt.feedbackId,'a lost original acknowledgement cannot resurrect deleted material');
 const afterDelete=await f.ownerData.exportPage(owner,exportId);assert.equal(afterDelete.items.length,2);assert(afterDelete.items.every(row=>row.state==='deleted'&&row.body===null&&row.attachments.length===0));
 await assert.rejects(f.db.query('UPDATE operations_feedback_v1 SET body=$2 WHERE id=$1',[first.receipt.feedbackId,'recreate']),/permission denied/);
 await assert.rejects(f.db.query('SELECT public.galaxy_account_erase_feedback_data($1,$2,$3)',[f.endpoint,owner.accountId,exportId]),/account_feedback_delete_intent_required/);
 f.advance(61);const later=await f.submit(owner,{body:'LATER_FEEDBACK_KEPT'});assert.equal((await f.ownerData.delete(owner,{operationId:deleteId})).replayed,true);assert.equal((await f.feedback.get(f.reader,later.receipt.feedbackId)).feedback.body,'LATER_FEEDBACK_KEPT');
 const newExport=await f.ownerData.export(owner,{operationId:randomUUID()}),newPage=await f.ownerData.exportPage(owner,newExport.operationId);assert.equal(newExport.feedbackCount,1);assert.deepEqual(newPage.items.map(row=>row.id),[later.receipt.feedbackId]);
 await f.db.exec('SET ROLE galaxy_evidence_worker');
 await assert.rejects(f.db.query('SELECT public.galaxy_account_erase_feedback_data($1,$2,$3)',[f.endpoint,owner.accountId,deleteId]),/permission denied/);
 await assert.rejects(f.db.query("UPDATE account_feedback_data_operations_v1 SET account_id=$2 WHERE operation_id=$1",[deleteId,other.accountId]),/permission denied/);
 await assert.rejects(f.db.query('UPDATE operations_feedback_v1 SET owner_deleted_at=now() WHERE false'),/permission denied/);
 assert.equal((await f.ownerData.processOwnerDeletions({limit:1})).processed,1);assert.equal(f.eraseCalls.length,1);assert(!f.objects.has(file.key));
 await f.db.exec('SET ROLE galaxy_api');const done=await f.ownerData.operation(owner,deleteId);assert.equal(done.phase,'completed');assert.equal(done.attachments.objectRemoved,true);assert.equal(done.attachments.physicalBlocksReleased,null);
 await f.db.exec('RESET ROLE');assert.equal((await f.db.query('SELECT note FROM operations_feedback_events_v1 WHERE feedback_id=$1 AND note IS NOT NULL',[first.receipt.feedbackId])).rows[0].note,'PRIVATE_OPERATOR_NOTE');
 await portal.revokeSessions({accountId:owner.accountId});assert.equal((await get('/operations/'+deleteId)).status,401);assert(!JSON.stringify(f.logs).includes('OWN_FEEDBACK_TEXT'));assert(!JSON.stringify(f.logs).includes('本人材料.txt'));
});

test('owner feedback attachment erasure reconciles unknown ACKs and never deletes a changed or foreign source',{timeout:90000},async t=>{
 const f=await fixture(t),[owner,other]=f.people,first=await f.submit(owner,{fileCount:2}),foreign=await f.submit(other,{body:'FOREIGN_KEPT',fileCount:1});
 const firstExport=await f.ownerData.export(owner,{operationId:randomUUID()});f.advance(30*86400+1);
 assert((await f.ownerData.exportPage(owner,firstExport.operationId)).items[0].attachments.every(file=>file.availability==='unavailable'));
 await assert.rejects(f.ownerData.attachmentContent(owner,firstExport.operationId,first.attachments[0].id,{authorize:async()=>owner}),{code:'feedback_attachment_content_unavailable'});
 const operationId=randomUUID();await f.ownerData.delete(owner,{operationId});f.loseAck.add(first.attachments[0].key);
 await migrate(f.db,{roles:['api','worker']});await f.db.exec('SET ROLE galaxy_evidence_worker');await f.ownerData.processOwnerDeletions({limit:2});
 await f.db.exec('SET ROLE galaxy_api');const unknown=await f.ownerData.operation(owner,operationId);assert.equal(unknown.attachments.resultUnknown,1);assert.equal(unknown.attachments.removed,1);assert.equal(unknown.attachments.objectRemoved,null);assert.equal(f.eraseCalls.length,2);
 f.advance(31);await f.db.exec('SET ROLE galaxy_evidence_worker');await f.ownerData.processOwnerDeletions();assert.equal(f.eraseCalls.length,2,'HEAD after a lost ACK does not issue another delete');await f.db.exec('SET ROLE galaxy_api');assert.equal((await f.ownerData.operation(owner,operationId)).phase,'completed');
 await f.db.exec('RESET ROLE');const changed=await f.submit(owner,{fileCount:1}),changedOperation=randomUUID();await f.ownerData.delete(owner,{operationId:changedOperation});
 const changedFile=changed.attachments[0],before=f.eraseCalls.length;
 await f.db.query('UPDATE feedback_attachments_v1 SET feedback_id=$2,submission_operation_id=$3,account_id=$4 WHERE id=$1',[changedFile.id,foreign.receipt.feedbackId,foreign.input.operationId,other.accountId]);
 await f.db.exec('SET ROLE galaxy_evidence_worker');await f.ownerData.processOwnerDeletions();assert.equal(f.eraseCalls.length,before);assert(f.objects.has(changedFile.key));assert(f.objects.has(foreign.attachments[0].key));
 await f.db.exec('RESET ROLE');await f.db.query('UPDATE feedback_attachments_v1 SET feedback_id=$2,submission_operation_id=$3,account_id=$4 WHERE id=$1',[changedFile.id,changed.receipt.feedbackId,changed.input.operationId,owner.accountId]);
 f.advance(31);await f.db.exec('SET ROLE galaxy_evidence_worker');await f.ownerData.processOwnerDeletions();assert.equal(f.eraseCalls.length,before+1);assert(f.objects.has(foreign.attachments[0].key));
 await f.db.exec('SET ROLE galaxy_api');assert.equal((await f.ownerData.operation(owner,changedOperation)).phase,'completed');assert.equal((await f.ownerData.operation(other,changedOperation)).state,'not-recorded');
 await f.db.exec('RESET ROLE');
});
