import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {ForumAttachmentsV1Service} from '../src/forum-attachments-v1.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';
import {OperationsFilesService} from '../src/operations-files.mjs';
import {createApi} from '../src/http.mjs';
import {migrate} from '../src/database.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createOidcTransactionStore} from '../src/oidc-transaction-store.mjs';
import {createOperationsPortal} from '../src/operations-auth.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {adminOrigin,operatorRoles,request,response,acceptCookies} from './operations-management-fixture.mjs';

// Real registered HTTP, local OIDC portal and SQL. Chat transport, scanner,
// object storage and role directory are explicit synthetic fixture contracts.
// The auth store is separate so current-session checks can run inside a file
// SQL transaction. No production storage, credentials or cleanup are exercised.
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const authDb=new PGlite();await migrate(authDb);t.after(()=>authDb.close());
 const callback=adminOrigin+'/v1/operations/callback',issuer=await oidcProviderFixture([callback],{emailVerified:true,roleClaims:{realm_access:{roles:[operatorRoles.reader]}}});t.after(issuer.close);
 const now=()=>Math.floor(Date.now()/1000),roles=new Map(),provider=await createOidcLoginProvider({
  id:'file-operations',name:'Synthetic file operators',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:callback,
  includeOperatorRoles:true,includeAccountProfile:true,allowLoopbackHttp:true,now,
  transactionStore:createOidcTransactionStore({db:authDb,namespace:'file-operations-http',now})
 }),portal=createOperationsPortal({db:authDb,endpoint:f.endpoint,adminOrigin,provider,now,roles:operatorRoles,
  roleDirectory:{async getOperatorRoles({externalSubject}){return [...(roles.get(externalSubject)??[])];}}});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),
  forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),
  forumAttachments=new ForumAttachmentsV1Service({forum,store:f.files.store,scanner:f.files.scanner}),
  managed=new OperationsFilesService({businessAdmin,chatAttachments:f.files,forumAttachments,now:f.now});
 async function login(subject,role){
  roles.set(subject,[operatorRoles[role]]);issuer.setAccount(subject);const jar=new Map(),started=response();
  await portal.login(request(jar),started,new URL(adminOrigin+'/v1/operations/login'));acceptCookies(jar,started);
  const completed=response();await portal.callback(request(jar),completed,await issuer.authorize(started.headers.get('location')));acceptCookies(jar,completed);
  const session=await portal.session(request(jar,{origin:adminOrigin}));assert.equal(session.state,'signed-in');assert.equal(session.operator.role,role);
  const principal=(await authDb.query('SELECT * FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2',[session.operator.id,f.endpoint])).rows[0];
  await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(operator_id) DO NOTHING`,[principal.operator_id,f.endpoint,principal.issuer,principal.external_subject,principal.display_name,new Date(f.now()*1000).toISOString()]);
  return {jar,session,subject};
 }
 const calls=[],logs=[],control={afterInitial:null},server=createApi({bindings:{endpoint:f.endpoint},businessAdmin,operationsFiles:managed,
  operations:{portal:{authorizeOperator:async(req,options)=>{
   calls.push(options);const actor=await portal.authorizeOperator(req,options);
   if(control.afterInitial){const action=control.afterInitial;control.afterInitial=null;await action();}return actor;
  }}},browserOrigins:[adminOrigin],logger:entry=>logs.push(entry),rateLimit:300});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 const call=(path,owner,input,extra={})=>{
  const method=input===undefined?'GET':'POST',headers={...request(owner.jar,{origin:adminOrigin,...(input===undefined?{}:{'content-type':'application/json','x-galaxy-operator-csrf':owner.session.csrfToken})},method).headers,...extra};
  for(const key of Object.keys(headers))if(headers[key]===null)delete headers[key];
  return fetch(base+path,{method,headers,...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(10000)});
 };
 return {...f,authDb,portal,roles,issuer,businessAdmin,managed,calls,logs,control,login,call,base};
}

test('file transit HTTP confines metadata filters and preserves current retry authority',{timeout:90000},async t=>{
 const f=await fixture(t),owner=f.people[0],roomId=await joinAccountConversation(f,owner,f.people[1]),id=randomUUID(),
  bytes=Buffer.from('PRIVATE_FILE_BYTES_NOT_METADATA'),name='PRIVATE_FILE_NAME_ALLOWED_AS_METADATA.txt';
 await f.files.prepare(owner,{attachmentId:id,roomId,name,mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes),purpose:'temporary-room-attachment',confirmed:true});
 await f.files.upload(owner,id,Readable.from([bytes]),{contentLength:bytes.length});
 const scan=f.files.scanner.scan;f.files.scanner.scan=async()=>{throw new ServiceError('attachment_scan_unavailable',503);};
 await f.files.scanPending();f.files.scanner.scan=scan;
 const reader=await f.login('files-http-reader','reader'),admin=await f.login('files-http-admin','administrator'),
  directory='/v1/operations/files',summary=directory+'/summary',detail=directory+'/chat/'+id,retry=detail+'/retry';
 await t.test('reader receives only file metadata and complete-query summary while unknown, repeated and UI-only query keys stop at the boundary',async()=>{
  const list=await f.call(directory+'?kind=chat&state=scan-pending&processing=scan&issue=scan&limit=1',reader);assert.equal(list.status,200);
  const listed=await list.json();assert.equal(listed.metadataOnly,true);assert.equal(listed.items[0].id,id);assert.equal(listed.items[0].name,name);
  const aggregate=await f.call(summary+'?kind=chat&state=scan-pending&processing=scan&issue=scan',reader);assert.equal(aggregate.status,200);
  const totals=await aggregate.json();assert.equal(totals.scope,'configured-business-database');
  assert.deepEqual(totals.policy.relay,{state:'not-configured',enabled:false,ttlSeconds:null,startsAt:null,maxFileBytes:null,maxCacheBytes:null,automaticExpiryCleanupEnabled:false});
  assert.equal(totals.totals.actualStoredBytes,null);assert.equal(totals.totals.cleanupRunning,null);assert.equal(totals.totals.cleanupFailed,null);
  const selected=await f.call(detail,reader);assert.equal(selected.status,200);const file=await selected.json();
  assert.equal(file.id,id);assert.equal(file.name,name);assert.equal(file.contentAvailable,false);assert.equal(file.canRetryScan,false);assert.equal(file.canRetryCleanup,false);
  const source=await f.files.row(f.db,id),metadata=JSON.stringify({listed,totals,file});
  assert.equal(metadata.includes(bytes.toString()),false);assert.equal(metadata.includes(source.storage_key),false);
  for(const key of ['url','downloadUrl','storage_key','content','body','text'])assert.equal(Object.hasOwn(file,key),false);
  const before=f.calls.length;
  for(const path of [directory+'?query=private',directory+'?issue=scan&issue=cleanup',directory+'?limit=1&limit=2',directory+'?trail=previous',
   directory+'?tab=rules',directory+'?state='+'x'.repeat(8193),summary+'?after=chat:'+id,summary+'?limit=1',summary+'?view=list',
   summary+'?kind=chat&kind=forum',detail+'?kind=chat',retry+'?issue=cleanup']){
   const denied=await f.call(path,reader);assert.equal(denied.status,400,path);
  }
  assert.equal(f.calls.length,before,'global exact parameter policy rejects these before management authentication');
  for(const path of [directory+'?issue=made-up',directory+'?state=complete',summary+'?processing=delete',directory+'?after=feedback:'+id])assert.equal((await f.call(path,reader)).status,400,path);
  for(const path of [detail+'/content',directory+'/feedback/'+id,summary+'/anything'])assert.equal((await f.call(path,reader)).status,404,path);
  assert.equal((await fetch(f.base+summary,{headers:{origin:adminOrigin},signal:AbortSignal.timeout(10000)})).status,401);
  assert.equal((await f.call(summary,reader,undefined,{origin:'https://foreign.example.invalid'})).status,403);
 });
 await t.test('scan retry uses the original request authorizer; readers, forged input, lost sessions and unapproved cleanup cannot reschedule a file',async()=>{
  const current=await (await f.call(detail,admin)).json(),input=()=>({operationId:randomUUID(),kind:'scan',expectedVersion:current.version,reason:'PRIVATE_RETRY_REASON'}),
   auditCount=async()=>Number((await f.db.query("SELECT count(*) AS n FROM business_admin_audit_v1 WHERE action='file-retry'")).rows[0].n),
   revision=async()=>Number((await f.files.row(f.db,id)).operations_retry_revision);
  for(const [who,body,extra,status]of [[reader,input(),{},403],[admin,input(),{'x-galaxy-operator-csrf':null},403],
   [admin,input(),{'x-galaxy-operator-csrf':'wrong'},403],[admin,{...input(),operatorId:'forged',role:'administrator'},{},400]]){
   assert.equal((await f.call(retry,who,body,extra)).status,status);
  }
  const removed=await f.login('files-http-logout','administrator'),beforeRevision=await revision();
  f.control.afterInitial=()=>f.portal.logout(request(removed.jar,{origin:adminOrigin,'x-galaxy-operator-csrf':removed.session.csrfToken},'POST'),response());
  const signedOut=await f.call(retry,removed,input());assert.equal(signedOut.status,401);assert.equal((await signedOut.json()).error,'operations_login_required');
  const demoted=await f.login('files-http-demoted','administrator');f.control.afterInitial=()=>{f.roles.set(demoted.subject,[operatorRoles.reader]);};
  assert.equal((await f.call(retry,demoted,input())).status,403);assert.equal(await revision(),beforeRevision);assert.equal(await auditCount(),0);
  const command=input(),before=f.calls.length,accepted=await f.call(retry,admin,command);assert.equal(accepted.status,200);
  const result=await accepted.json();assert.equal(result.state,'scheduled');assert.equal(result.processingComplete,false);assert.equal(result.file.name,name);
  assert.ok(f.calls.length>before+1,'write authority is refreshed beyond HTTP entry');assert.ok(f.calls.slice(before).every(options=>options.write===true));
  const replay=await f.call(retry,admin,command);assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);assert.equal(await auditCount(),1);
  const raw=(await f.db.query("SELECT selection,result FROM business_admin_audit_v1 WHERE action='file-retry'")).rows;
  assert.equal(JSON.stringify(raw).includes(name),false,'the success receipt never stores the current filename');
  await f.files.revoke(owner,{attachmentId:id});const cleanup=await (await f.call(detail,admin)).json();assert.equal(cleanup.canRetryCleanup,false);
  let erases=0;const erase=f.files.store.erase;f.files.store.erase=async(...args)=>{erases++;return erase(...args);};
  const refused=await f.call(retry,admin,{operationId:randomUUID(),kind:'cleanup',expectedVersion:cleanup.version,reason:'不能以待清理状态替代本次批准'});
  assert.equal(refused.status,409);assert.equal((await refused.json()).error,'operations_file_cleanup_authorization_required');assert.equal(erases,0);assert.equal(await auditCount(),1);
 });
 assert.equal(JSON.stringify(f.logs).includes('PRIVATE_'),false);assert.deepEqual(f.issuer.failures,[]);
});

test('file transit audit exposes controlled filters and states without a filename, reason or URL channel',()=>{
 const id=randomUUID(),row={id,sequence:1,operator_id:'synthetic-operator',operator_role:'reader',action:'files-query',account_id:null,operation_id:null,http_request_id:randomUUID(),created_at:new Date(),
  selection:{kind:'chat',state:'scan-pending',processing:'scan',issue:'scan',view:'summary',name:'PRIVATE_FILENAME',query:'PRIVATE_QUERY',storageKey:'PRIVATE_KEY',url:'https://private.example.invalid'},result:{count:null,total:999,name:'PRIVATE_FILENAME'}};
 const view=businessAuditMetadata(row);assert.deepEqual(view.selection,{kind:'chat',state:'scan-pending',processing:'scan',issue:'scan',view:'summary'});assert.deepEqual(view.result,{count:null});
 const dirty=businessAuditMetadata({...row,selection:{kind:'feedback',state:'unapproved-private-state',issue:'PRIVATE_ISSUE',view:'PRIVATE_VIEW'}});assert.deepEqual(dirty.selection,{});
 const retry=businessAuditMetadata({...row,action:'file-retry',selection:{kind:'chat',id,operationId:id,command:{operationId:id,kind:'scan',reason:'PRIVATE_REASON'}},
  result:{operationId:id,state:'scheduled',processingComplete:false,file:{id,kind:'chat',state:'scan-pending',name:'PRIVATE_FILENAME',url:'https://private.example.invalid'}}});
 assert.equal(JSON.stringify({view,dirty,retry}).includes('PRIVATE_'),false);assert.equal(JSON.stringify(retry).includes('https://private.example.invalid'),false);
});
