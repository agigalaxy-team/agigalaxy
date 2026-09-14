import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {once} from 'node:events';
import canonicalize from 'canonicalize';
import {chatFixture,invite} from './chat-workflow.mjs';
import {ChatAttachmentsService} from '../src/chat-attachments.mjs';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
export function attachmentContractFixture(){
 const objects=new Map();let scannerUnavailable=false;
 return {objects,
  store:{keyId:'synthetic-only',async put({key,bytes}){objects.set(key,Buffer.from(bytes));},async get({key}){return objects.get(key)??null;},async head({key}){return objects.has(key)?{size:objects.get(key).length}:null;},async erase({key}){objects.delete(key);}},
  scanner:{async scan(bytes){if(scannerUnavailable)throw new ServiceError('attachment_scanner_unavailable',503);return {state:bytes.includes(Buffer.from('EICAR-STANDARD'))?'blocked':'clean',engine:'explicit-contract-fixture',guaranteedSafe:false};}},
  outage:value=>{scannerUnavailable=value;}};
}
export async function verifyAttachments({database=null,runtimeDb=null,workerDb=null,store,scanner,transport,migrateDatabase=true}={}){
 const messages=new Map(),contract=attachmentContractFixture();
 transport??={available:true,project:async()=>{},send:async x=>{messages.set(x.messageId,{archiveId:x.messageId,text:x.text,revision:1});return {archiveId:x.messageId};},read:async x=>x.ids.map(id=>messages.get(id)).filter(Boolean),erase:async x=>{messages.delete(x.archiveId??x.messageId);}};
 const f=await chatFixture({database,runtimeDb,transport,migrateDatabase}),[a,b,c]=f.people,files=new ChatAttachmentsService({chat:f.chat,store:store??contract.store,scanner:scanner??contract.scanner});
 f.chat.attachments=files;
 const jobs=workerDb?new ChatAttachmentsService({chat:{db:workerDb,now:f.now},store:files.store,scanner:files.scanner}):files;
 const server=createApi({bindings:{endpoint:f.chat.access.endpoint},access:f.chat.access,chat:f.chat,attachments:files,rateLimit:1000,browserOrigins:['https://galaxy.example.org']});
 server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
 async function post(actor,path,input,method='POST'){const res=await fetch(url+path,{method,headers:{Authorization:'Bearer '+f.credentials.get(actor.subjectId),'Content-Type':method==='PUT'?'application/octet-stream':'application/json'},body:method==='PUT'?input:JSON.stringify(input)});return res;}
 const roomId=randomUUID(),bytes=Buffer.from('Synthetic ordinary room attachment, not a Task.\n');
 const input=(data=bytes)=>({attachmentId:randomUUID(),roomId,name:'example.txt',mediaType:'text/plain',size:data.length,sha256:digest(data),purpose:'temporary-room-attachment',confirmed:true});
 const root='/v2/chat/attachments/';
 try{
  await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic attachments'});await invite(f.chat,a,roomId,b);
  const first=input();assert.equal((await post(c,root+'prepare',first)).status,403);
  const prepare=await post(a,root+'prepare',first);assert.equal(prepare.status,200,await prepare.clone().text());assert.equal((await prepare.json()).state,'prepared');
  await assert.rejects(files.prepare(a,{...first,name:'changed.txt'}),/operation_conflict/);
  assert.equal((await post(b,root+'read',{attachmentId:first.attachmentId})).status,404,'Unsent bytes/metadata are private to uploader');
  const upload=await post(a,root+first.attachmentId+'/upload',bytes,'PUT');assert.equal(upload.status,200,await upload.clone().text());const uploaded=await upload.json();assert.equal(uploaded.state,'scan-pending');
  const msg={clientMessageId:randomUUID(),text:'A file with an ordinary message',attachments:[{id:first.attachmentId,sha256:first.sha256}]};
  await assert.rejects(f.chat.send(a,roomId,msg),/reference_unavailable/);
  if(!scanner){contract.outage(true);await jobs.scanPending();assert.equal((await files.get(a,{attachmentId:first.attachmentId})).state,'scan-pending');contract.outage(false);await f.db.query('UPDATE chat_attachments SET lease_until=NULL WHERE id=$1',[first.attachmentId]);}
  await jobs.scanPending();assert.equal((await files.get(a,{attachmentId:first.attachmentId})).state,'available');
  assert.equal((await post(b,root+first.attachmentId+'/content',{})).status,404);
  const sent=await f.chat.send(a,roomId,msg);assert.equal(sent.acceptedByRoom,true);assert.equal((await f.chat.send(a,roomId,msg)).messageId,sent.messageId);
  const history=await f.chat.history(b,roomId);assert.equal(history.messages[0].attachments[0].sha256,first.sha256);
  const download=await post(b,root+first.attachmentId+'/content',{});assert.equal(download.status,200);assert.equal(download.headers.get('x-galaxy-content-sha256'),first.sha256);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  assert.equal((await post(c,root+first.attachmentId+'/content',{})).status,403);
  const old={clientMessageId:randomUUID(),text:'legacy plain message'};const legacy=await f.chat.send(a,roomId,old);
  assert.equal((await f.db.query('SELECT payload_hash FROM chat_message_refs WHERE message_id=$1',[legacy.messageId])).rows[0].payload_hash,digest(canonicalize({...old,replyTo:null})),'Legacy hash remains byte compatible');
  const deletionId=randomUUID();await f.db.query("INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision) VALUES($1,$2,$3,'synthetic','{}','synthetic','synthetic','requested',1)",[deletionId,a.subjectId,a.bindingId]);
  assert.equal((await post(b,root+first.attachmentId+'/content',{})).status,404);await jobs.purgeExpired();
  assert.ok(await files.store.head({key:'attachments/'+first.attachmentId,keyId:files.store.keyId}),'Pending deletion is reversible and never physically erases early');
  await f.db.query("UPDATE deletion_requests SET state='cancelled' WHERE id=$1",[deletionId]);assert.equal((await post(b,root+first.attachmentId+'/content',{})).status,200);
  const immutableExpiry=(await files.get(a,{attachmentId:first.attachmentId})).expiresAt;assert.equal(new Date(immutableExpiry).getTime(),new Date(uploaded.expiresAt).getTime());
  await f.chat.leave(b,roomId);assert.equal((await post(b,root+first.attachmentId+'/content',{})).status,403);await invite(f.chat,a,roomId,b);
  await f.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[sent.messageId,new Date((f.now()-1)*1000).toISOString()]);
  assert.equal((await post(b,root+first.attachmentId+'/content',{})).status,404);await jobs.purgeExpired();
  assert.equal((await post(a,root+first.attachmentId+'/export-content',{})).status,200,'Own retained file has independent 30 day TTL after message expiry');
  await files.revoke(a,{attachmentId:first.attachmentId});assert.equal((await post(a,root+first.attachmentId+'/export-content',{})).status,404);
  await jobs.purgeExpired();assert.equal((await files.get(a,{attachmentId:first.attachmentId})).objectRemoved,true);
  const retry=input();await files.prepare(a,retry);
  await assert.rejects(files.upload(a,retry.attachmentId,Readable.from([bytes.subarray(0,4)]),{contentLength:bytes.length}),/size_mismatch/);
  const expiry=(await files.get(a,{attachmentId:retry.attachmentId})).expiresAt;assert.equal((await files.get(a,{attachmentId:retry.attachmentId})).state,'prepared');
  await files.upload(a,retry.attachmentId,Readable.from([bytes]),{contentLength:bytes.length});assert.equal(new Date((await files.get(a,{attachmentId:retry.attachmentId})).expiresAt).getTime(),new Date(expiry).getTime());
  await jobs.scanPending();
  const badBytes=Buffer.from('X5O!P%@AP[4'+String.fromCharCode(92)+'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),bad=input(badBytes);bad.name='synthetic-antivirus-test.txt';
  await files.prepare(a,bad);await files.upload(a,bad.attachmentId,Readable.from([badBytes]),{contentLength:badBytes.length});await jobs.scanPending();
  assert.equal((await files.get(a,{attachmentId:bad.attachmentId})).state,'blocked');await jobs.purgeExpired();assert.equal((await files.get(a,{attachmentId:bad.attachmentId})).objectRemoved,true);
  const truncated=input();await files.prepare(a,truncated);await assert.rejects(files.upload(a,truncated.attachmentId,Readable.from([Buffer.alloc(bytes.length)]),{contentLength:bytes.length}),/digest_mismatch/);await jobs.purgeExpired();
  await f.db.query('UPDATE chat_attachments SET expires_at=$2 WHERE id=$1',[retry.attachmentId,new Date((f.now()-1)*1000).toISOString()]);
  await jobs.purgeExpired();assert.equal((await files.get(a,{attachmentId:retry.attachmentId})).objectRemoved,true);
  const preflight=await fetch(url+root+randomUUID()+'/upload',{method:'OPTIONS',headers:{Origin:'https://galaxy.example.org','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization,content-type'}});
  assert.equal(preflight.status,204);
  return {http:true,bindings:'real-signed-fixture',accountRegistry:'explicit-isolated-contract',legacyMessageHash:true,currentRoomACL:true,pendingDeletionReversible:true,fixedTTL:true,workerScope:!!workerDb,storage:store?'real-adapter':'contract-fixture',scanner:scanner?'real-daemon':'contract-fixture'};
 }finally{
  await files.eraseSubject(a.subjectId).catch(()=>{});await files.eraseSubject(b.subjectId).catch(()=>{});
  await f.chat.eraseSubject(a.subjectId).catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();
 }
}
