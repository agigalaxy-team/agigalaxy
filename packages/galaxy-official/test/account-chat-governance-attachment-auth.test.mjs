import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {createApi} from '../src/http.mjs';
import {migrate} from '../src/database.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createOidcTransactionStore} from '../src/oidc-transaction-store.mjs';
import {createOperationsPortal} from '../src/operations-auth.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {adminOrigin,operatorRoles,request,response,acceptCookies} from './operations-management-fixture.mjs';

// Both stores run real SQL. The authentication store is separate only because
// PGlite serializes transactions: a live portal read must run while the case
// transaction awaits object storage. OIDC uses a fresh loopback issuer; chat,
// object storage, the scanner and the role directory are explicit contracts.
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const authDb=new PGlite();await migrate(authDb);t.after(()=>authDb.close());
 const callback=adminOrigin+'/v1/operations/callback',issuer=await oidcProviderFixture([callback],{
  emailVerified:true,roleClaims:{realm_access:{roles:[operatorRoles.reader]}}
 });t.after(issuer.close);
 const now=()=>Math.floor(Date.now()/1000),roles=new Map(),provider=await createOidcLoginProvider({
  id:'operations-admin',name:'Synthetic attachment reader',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:callback,
  includeOperatorRoles:true,includeAccountProfile:true,allowLoopbackHttp:true,now,
  transactionStore:createOidcTransactionStore({db:authDb,namespace:'chat-case-attachment-auth',now})
 }),portal=createOperationsPortal({db:authDb,endpoint:f.endpoint,adminOrigin,provider,now,roles:operatorRoles,
  roleDirectory:{async getOperatorRoles({externalSubject}){return [...(roles.get(externalSubject)??[])];}}});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),governance=new AccountChatGovernanceService({chat:f.chat,businessAdmin});
 async function login(subject){
  roles.set(subject,[operatorRoles.reader]);issuer.setAccount(subject);const jar=new Map(),started=response();
  await portal.login(request(jar),started,new URL(adminOrigin+'/v1/operations/login'));acceptCookies(jar,started);
  const completed=response();await portal.callback(request(jar),completed,await issuer.authorize(started.headers.get('location')));acceptCookies(jar,completed);
  const session=await portal.session(request(jar,{origin:adminOrigin}));assert.equal(session.state,'signed-in');assert.equal(session.operator.role,'reader');
  const principal=(await authDb.query('SELECT * FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2',[session.operator.id,f.endpoint])).rows[0];
  await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(operator_id) DO NOTHING`,[principal.operator_id,f.endpoint,principal.issuer,principal.external_subject,principal.display_name,new Date(f.now()*1000).toISOString()]);
  return{jar,session,subject};
 }
 const logs=[],authorizationCalls=[],control={replacement:null,endpoint:null},server=createApi({bindings:{endpoint:f.endpoint},businessAdmin,accountChatGovernance:governance,
  operations:{portal:{authorizeOperator:async(req,options)=>{
   authorizationCalls.push(options);
   const fresh=await portal.authorizeOperator(control.replacement?{...req,headers:control.replacement}:req,options);
   return control.endpoint?{...fresh,endpoint:control.endpoint}:fresh;
  }}},browserOrigins:[adminOrigin],logger:entry=>logs.push(entry),rateLimit:250});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 const post=(path,owner,input={},extra={})=>{
  const headers={...request(owner.jar,{origin:adminOrigin,'content-type':'application/json','x-galaxy-operator-csrf':owner.session.csrfToken},'POST').headers,...extra};
  for(const key of Object.keys(headers))if(headers[key]===null)delete headers[key];
  return fetch(base+path,{method:'POST',headers,body:JSON.stringify(input),signal:AbortSignal.timeout(10000)});
 };
 return{...f,authDb,issuer,portal,roles,governance,businessAdmin,logs,authorizationCalls,control,login,post};
}

async function selectedCase(f){
 const [a,b]=f.people,roomId=await joinAccountConversation(f,a,b),bytes=Buffer.from('PRIVATE_CASE_ATTACHMENT_BYTES'),attachmentId=randomUUID(),sha256=f.digest(bytes);
 await f.files.prepare(b,{attachmentId,roomId,name:'PRIVATE_CASE_ATTACHMENT_NAME.txt',mediaType:'text/plain',size:bytes.length,sha256,purpose:'temporary-room-attachment',confirmed:true});
 await f.files.upload(b,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await f.files.scanPending();
 const message=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'PRIVATE_SELECTED_CASE_MESSAGE',attachments:[{id:attachmentId,sha256}]}),source=await f.governance.source(a,{roomId,messageIds:[message.messageId]}),record=await f.governance.report(a,{
  operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'other',summary:'PRIVATE_CASE_REPORT_SUMMARY',materials:[{messageId:message.messageId,revision:1,attachmentIds:[attachmentId]}]
 });
 return{record,bytes,attachmentId,path:'/v1/operations/chat-reports/'+record.reportId+'/attachments/'+attachmentId+'/content'};
}
const auditCount=async f=>Number((await f.db.query("SELECT count(*) AS n FROM business_admin_audit_v1 WHERE action='chat-report-attachment'")).rows[0].n);

test('case attachment HTTP binds reader CSRF and fresh operator authority around storage without expanding material access',{timeout:60000},async t=>{
 const f=await fixture(t),selected=await selectedCase(f),reader=await f.login('case-attachment-reader'),other=await f.login('case-attachment-other-reader'),get=f.files.store.get;
 let reads=0,afterRead=null;
 f.files.store.get=async input=>{reads++;const bytes=await get(input);await afterRead?.();return bytes;};
 async function denied(owner,status,code,{extra={},path=selected.path}={}){
  const before=await auditCount(f),result=await f.post(path,owner,{},extra),requestId=result.headers.get('x-request-id');
  assert.equal(result.status,status);assert.match(result.headers.get('content-type'),/^application\/json/);
  assert.equal(result.headers.get('content-disposition'),null);const text=await result.text();assert.equal(JSON.parse(text).error,code);assert.equal(text.includes(selected.bytes.toString()),false);
  assert.equal(await auditCount(f),before,'a denied read never records successful attachment delivery');
  assert.ok(f.logs.some(entry=>entry.event==='http_rejected'&&entry.requestId===requestId&&entry.status===status));
  assert.equal(f.logs.some(entry=>entry.event==='http_completed'&&entry.requestId===requestId&&entry.status===200),false);
 }
 await t.test('a reader with the current CSRF token reads only the selected clean attachment',async()=>{
  const result=await f.post(selected.path,reader);assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'application/octet-stream');
  assert.match(result.headers.get('cache-control'),/no-store/);assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await result.arrayBuffer()),selected.bytes);
  assert.equal(reads,1);assert.equal(await auditCount(f),1);assert.ok(f.authorizationCalls.length>=4);
  assert.ok(f.authorizationCalls.every(call=>call.write===false&&call.csrf===true));
 });
 await t.test('missing or incorrect CSRF and a foreign origin fail before storage; a reader still cannot write',async()=>{
  const before=reads;
  await denied(reader,403,'operations_access_denied',{extra:{'x-galaxy-operator-csrf':null}});
  await denied(reader,403,'operations_access_denied',{extra:{'x-galaxy-operator-csrf':'incorrect'}});
  await denied(reader,403,'browser_origin_not_enabled',{extra:{origin:'https://foreign.example.invalid'}});
  const result=await f.post('/v1/operations/chat-reports/'+selected.record.reportId+'/event',reader,{operationId:randomUUID(),reportId:selected.record.reportId,expectedVersion:selected.record.version,kind:'review',summary:'A reader may not submit this decision.'});
  assert.equal(result.status,403);assert.equal((await result.json()).error,'operations_access_denied');assert.equal(reads,before);assert.equal(await auditCount(f),1);
 });
 await t.test('a real local session logout during storage returns no file bytes and no success audit',async()=>{
  afterRead=()=>f.portal.logout(request(reader.jar,{origin:adminOrigin,'x-galaxy-operator-csrf':reader.session.csrfToken},'POST'),response());
  try{await denied(reader,401,'operations_login_required');}finally{afterRead=null;}
  assert.equal((await f.portal.session(request(reader.jar,{origin:adminOrigin}))).state,'signed-out');
 });
 await t.test('another freshly verified reader or endpoint cannot replace the initial operator after storage',async()=>{
  const replacement=await f.login('case-attachment-replacement-reader');
  afterRead=()=>{f.control.replacement=request(replacement.jar,{origin:adminOrigin,'x-galaxy-operator-csrf':replacement.session.csrfToken},'POST').headers;};
  try{await denied(other,403,'business_admin_denied');}finally{f.control.replacement=null;afterRead=null;}
  afterRead=()=>{f.control.endpoint='https://another-service.example.invalid';};
  try{await denied(other,403,'business_admin_denied');}finally{f.control.endpoint=null;afterRead=null;}
 });
 await t.test('directory-perceived role removal fails closed; this fixture makes no upstream cache latency claim',async()=>{
  f.control.replacement=null;afterRead=()=>{f.roles.set(other.subject,[]);};
  try{await denied(other,401,'operations_login_required');}finally{afterRead=null;}
  assert.equal((await f.portal.session(request(other.jar,{origin:adminOrigin}))).state,'signed-out');
 });
 await t.test('no fresh verifier, unselected material and source expiry retain their existing refusals',async()=>{
  const owner=await f.login('case-attachment-qualification-reader'),actor=await f.portal.authorizeOperator(request(owner.jar,{origin:adminOrigin,'x-galaxy-operator-csrf':owner.session.csrfToken},'POST'),{write:false,csrf:true});
  await assert.rejects(f.governance.operatorAttachment(actor,{reportId:selected.record.reportId,attachmentId:selected.attachmentId}),{code:'operations_authorization_unavailable'});
  await denied(owner,404,'chat_report_attachment_unavailable',{path:selected.path.replace(selected.attachmentId,randomUUID())});
  afterRead=()=>{f.advance(31*86400);};try{await denied(owner,404,'attachment_content_unavailable');}finally{afterRead=null;}
 });
 for(const secret of ['PRIVATE_CASE_ATTACHMENT_BYTES','PRIVATE_CASE_ATTACHMENT_NAME','PRIVATE_SELECTED_CASE_MESSAGE','PRIVATE_CASE_REPORT_SUMMARY'])assert.equal(JSON.stringify(f.logs).includes(secret),false);
 assert.deepEqual(f.issuer.failures,[]);
});

test('case attachment requires a request-bound verifier even when current stored-role verification is available',async()=>{
 let roleChecks=0,transactions=0;const endpoint='https://chat.example.org',db={transaction:async()=>{transactions++;throw Error('A case transaction must not start without its request verifier.');}},
  businessAdmin=new BusinessAdminService({db,endpoint,operatorAuthorization:async()=>{roleChecks++;return'reader';}}),governance=new AccountChatGovernanceService({chat:{db,access:{endpoint},now:()=>0},businessAdmin}),
  actor={kind:'business-operator',operatorId:'reader-with-current-role',role:'reader',endpoint},input={reportId:randomUUID(),attachmentId:randomUUID()};
 for(const options of [undefined,{}, {authorize:null},{authorize:'not-a-function'}])await assert.rejects(governance.operatorAttachment(actor,input,options),{code:'operations_authorization_unavailable',status:503});
 assert.equal(roleChecks,0,'role verification alone cannot stand in for the specific request session');assert.equal(transactions,0);
});
