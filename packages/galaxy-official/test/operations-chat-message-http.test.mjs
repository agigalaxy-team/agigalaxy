import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OperationsPermissionsService} from '../src/operations/permissions/index.mjs';
import {PGlite} from '@electric-sql/pglite';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {AccountChatGovernanceService} from "../src/chat/reports/service.mjs";
import {chatMessageOperationsBlockedWithin} from "../src/chat/chat-message-operations-gate.mjs";
import {createApi} from '../src/http.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {createOidcLoginProvider} from "../src/identity/authentication/oidc-login.mjs";
import {createOidcTransactionStore} from "../src/identity/authentication/oidc-transaction-store.mjs";
import {createOperationsPortal} from "../src/operations/permissions/auth.mjs";
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {adminOrigin,operatorRoles,request,response,acceptCookies} from './operations-management-fixture.mjs';

// Real API, OIDC portal and SQL; no production sessions or private messages.
// The separate auth database allows request revalidation during a case SQL
// transaction without PGlite serializing that read behind the open transaction.
// Replacement is injected after the action-bound authorization, so the extra
// pre-body admission check cannot silently select a different command actor.
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const authDb=new PGlite();await migrate(authDb);t.after(()=>authDb.close());
 const callback=adminOrigin+'/v1/operations/callback',issuer=await oidcProviderFixture([callback],{emailVerified:true,roleClaims:{realm_access:{roles:[operatorRoles.reader]}}});t.after(issuer.close);
 const now=()=>Math.floor(Date.now()/1000),roles=new Map(),provider=await createOidcLoginProvider({
  id:'operations-admin',name:'Synthetic case operators',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:callback,
  includeOperatorRoles:true,includeAccountProfile:true,allowLoopbackHttp:true,now,
  transactionStore:createOidcTransactionStore({db:authDb,namespace:'message-visibility-http',now})
 });
 const fixtureAdmin={kind:'business-operator',operatorId:'local-http-permission-maintainer',role:'administrator',endpoint:f.endpoint};
 for(const db of [f.db,authDb])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://fixture.invalid',$1,'权限夹具管理员',$3,$3)",[fixtureAdmin.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissionOptions=db=>({db,endpoint:f.endpoint,now:f.now,operatorAuthorization:async(actor,{db:tx}={})=>{
  if(actor.operatorId===fixtureAdmin.operatorId)return'administrator';
  const row=(await tx.query('SELECT external_subject FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2',[actor.operatorId,f.endpoint])).rows[0];
  return row&&roles.get(row.external_subject)?.some(role=>Object.values(operatorRoles).includes(role))?'reader':null;
 }});
 const permissions=new OperationsPermissionsService(permissionOptions(f.db)),portalPermissions=new OperationsPermissionsService(permissionOptions(authDb)),roleIds=new Map();
 for(const authority of [permissions,portalPermissions]){
  const ids={};for(const [role,codes]of [['reader',['chat-reports.read', 'audit.read']],['administrator',['chat-reports.read', 'chat-messages.hide', 'audit.read']]])ids[role]=(await authority.saveRole(fixtureAdmin,{operationId:randomUUID(),expectedVersion:0,
   name:'本文件有限合同 '+role,description:'Synthetic HTTP authority',enabled:true,permissions:codes},{authorize:async()=>fixtureAdmin})).role.id;
  roleIds.set(authority,ids);
 }
 const portal=createOperationsPortal({db:authDb,endpoint:f.endpoint,adminOrigin,provider,now,roles:operatorRoles,permissions:portalPermissions,
  roleDirectory:{async getOperatorRoles({externalSubject}){return [...(roles.get(externalSubject)??[])];}}});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now,permissions}),governance=new AccountChatGovernanceService({chat:f.chat,businessAdmin});
 async function login(subject,role){
  roles.set(subject,[operatorRoles[role]]);issuer.setAccount(subject);const jar=new Map(),started=response();
  await portal.login(request(jar),started,new URL(adminOrigin+'/v1/operations/login'));acceptCookies(jar,started);
  const completed=response();await portal.callback(request(jar),completed,await issuer.authorize(started.headers.get('location')));acceptCookies(jar,completed);
  const session=await portal.session(request(jar,{origin:adminOrigin}));assert.equal(session.state,'signed-in');assert.equal(session.operator.role,'reader');
  const principal=(await authDb.query('SELECT * FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2',[session.operator.id,f.endpoint])).rows[0];
  await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(operator_id) DO NOTHING`,[principal.operator_id,f.endpoint,principal.issuer,principal.external_subject,principal.display_name,new Date(f.now()*1000).toISOString()]);
  const assignments=[];
  for(const authority of [permissions,portalPermissions])assignments.push((await authority.saveAssignment(fixtureAdmin,{operationId:randomUUID(),expectedVersion:0,
   operatorId:session.operator.id,roleId:roleIds.get(authority)[role],enabled:true},{authorize:async()=>fixtureAdmin})).assignment);
  return {jar,session,subject,assignments};
 }
 const logs=[],authorizationCalls=[],control={afterInitial:null,replacement:null},server=createApi({bindings:{endpoint:f.endpoint},businessAdmin,accountChatGovernance:governance,
  operations:{portal:{authorizeOperator:async(req,options)=>{
   authorizationCalls.push(options);const fresh=await portal.authorizeOperator(control.replacement?{...req,headers:control.replacement}:req,options);
   if(control.afterInitial&&options.action){const action=control.afterInitial;control.afterInitial=null;await action();}return fresh;
  }}},browserOrigins:[adminOrigin],logger:entry=>logs.push(entry),rateLimit:200});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 const call=(path,owner,input,extra={})=>{
  const method=input===undefined?'GET':'POST',headers={...request(owner.jar,{origin:adminOrigin,...(input===undefined?{}:{'content-type':'application/json','x-galaxy-operator-csrf':owner.session.csrfToken})},method).headers,...extra};
  for(const key of Object.keys(headers))if(headers[key]===null)delete headers[key];
  return fetch(base+path,{method,headers,...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(10000)});
 };
 return {...f,permissions,portalPermissions,fixtureAdmin,authDb,issuer,portal,roles,governance,businessAdmin,logs,authorizationCalls,control,login,call,base};
}

test('one-message visibility HTTP retains current independent business authority and exact selected-case inputs',{timeout:90000},async t=>{
 const f=await fixture(t),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),message=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'PRIVATE_SELECTED_MESSAGE'}),
  source=await f.governance.source(a,{roomId,messageIds:[message.messageId]}),record=await f.governance.report(a,{operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'other',summary:'PRIVATE_REPORT_REASON',materials:[{messageId:message.messageId,revision:1,attachmentIds:[]}]}),
  reader=await f.login('visibility-http-reader','reader'),admin=await f.login('visibility-http-admin','administrator'),other=await f.login('visibility-http-other-admin','administrator'),
  directory='/v1/operations/chat-reports',detail=directory+'/'+record.reportId,path=detail+'/messages/'+message.messageId+'/visibility';
 const command=()=>({operationId:randomUUID(),expectedVersion:record.version,expectedRevision:0,messageRevision:1,action:'hide',summary:'PRIVATE_MESSAGE_ACTION_REASON'}),
  count=async()=>Number((await f.db.query("SELECT count(*) AS n FROM business_admin_audit_v1 WHERE action='chat-report-event'")).rows[0].n),
  heads=async()=>Number((await f.db.query('SELECT count(*) AS n FROM operations_chat_message_visibility_v1')).rows[0].n);
 await t.test('reader keeps room-filtered reads while writes require granted business authority, CSRF and exact same-origin input',async()=>{
  const listed=await f.call(directory+'?roomId='+roomId+'&state=received&limit=20',reader);assert.equal(listed.status,200);assert.equal((await listed.json()).items[0].reportId,record.reportId);
  assert.equal((await f.call(detail,reader)).status,200);
  for(const [owner,input,extra,status]of [[reader,command(),{},403],[admin,command(),{'x-galaxy-operator-csrf':null},403],
   [admin,command(),{'x-galaxy-operator-csrf':'incorrect'},403],[admin,command(),{origin:'https://foreign.example.invalid'},403],
   [admin,{...command(),operatorId:'forged-operator',scope:'all-messages'},{},400]]){
   const denied=await f.call(path,owner,input,extra);assert.equal(denied.status,status);
  }
  assert.equal((await f.call(path+'?roomId='+roomId,admin,command())).status,400);
  assert.equal((await f.call(path,admin)).status,404);
  assert.equal(await heads(),0);assert.equal(await count(),0);
 });
 await t.test('known local logout or a different freshly authorized operator cannot replace the bound command actor',async()=>{
  const removed=await f.login('visibility-http-logged-out','administrator');
  f.control.afterInitial=()=>f.portal.logout(request(removed.jar,{origin:adminOrigin,'x-galaxy-operator-csrf':removed.session.csrfToken},'POST'),response());
  const loggedOut=await f.call(path,removed,command());assert.equal(loggedOut.status,401);assert.equal((await loggedOut.json()).error,'operations_login_required');
  f.control.afterInitial=()=>{f.control.replacement=request(other.jar,{origin:adminOrigin,'x-galaxy-operator-csrf':other.session.csrfToken},'POST').headers;};
  try{const replaced=await f.call(path,admin,command());assert.equal(replaced.status,403);assert.equal((await replaced.json()).error,'business_admin_denied');}
  finally{f.control.afterInitial=null;f.control.replacement=null;}
  assert.equal(await heads(),0);assert.equal(await count(),0);
 });
 await t.test('registered POST applies one selected-message cover and generic audit returns only recorded metadata',async()=>{
  const input=command(),before=f.authorizationCalls.length,result=await f.call(path,admin,input);assert.equal(result.status,200);
  const current=await result.json();assert.equal(current.reportId,record.reportId);assert.equal(current.version,record.version+1);
  assert.ok(f.authorizationCalls.length>before+1,'the service rechecks the request-bound current authorizer');
  assert.ok(f.authorizationCalls.slice(before).every(options=>options.write===true));
  const head=(await f.db.query('SELECT * FROM operations_chat_message_visibility_v1 WHERE endpoint=$1 AND report_id=$2 AND message_id=$3',[f.endpoint,record.reportId,message.messageId])).rows[0];
  assert.equal(head.hidden,true);assert.equal(head.revision,1);assert.equal(head.message_revision,1);
  const actor=await f.portal.authorizeOperator(request(reader.jar,{origin:adminOrigin}),{write:false}),audit=await f.businessAdmin.audit(actor,{limit:100}),event=audit.items.find(item=>item.operationId===input.operationId);
  assert.equal(event.action,'chat-report-event');assert.equal(event.selection.kind,'message-hide');assert.equal(event.selection.reportId,record.reportId);
  assert.equal(event.selection.messageId,message.messageId);assert.equal(event.selection.sourceRevision,1);assert.equal(event.result.hidden,true);
  assert.equal(JSON.stringify(audit).includes('PRIVATE_'),false);assert.equal(await count(),1);
  const denied=await f.call(path,admin,{...input,operationId:randomUUID(),summary:'PRIVATE_MESSAGE_ACTION_REASON'});assert.equal(denied.status,409);
  assert.equal(await count(),1,'a rejected stale command records no successful message operation');
 });
 await t.test('the new operation reuses exact credentialed CORS without adding account headers or foreign origins',async()=>{
  const preflight=await fetch(f.base+path,{method:'OPTIONS',headers:{origin:adminOrigin,'access-control-request-method':'POST','access-control-request-headers':'content-type,x-galaxy-operator-csrf'},signal:AbortSignal.timeout(10000)});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');assert.equal(preflight.headers.get('access-control-allow-origin'),adminOrigin);
  for(const headers of [{origin:'https://foreign.example.invalid','access-control-request-method':'POST'},
   {origin:adminOrigin,'access-control-request-method':'POST','access-control-request-headers':'x-galaxy-account-csrf'}])
   assert.equal((await fetch(f.base+path,{method:'OPTIONS',headers,signal:AbortSignal.timeout(10000)})).status,403);
 });
 await t.test('provisioned worker can read the gate while only API changes the finite head and neither can rewrite its initial event or delete it',async()=>{
  await migrate(f.db,{roles:['api','worker']});
  const saved=(await f.db.query('SELECT * FROM operations_chat_message_visibility_v1 WHERE message_id=$1',[message.messageId])).rows[0];
  try{
   await f.db.exec('SET ROLE galaxy_evidence_worker');
   assert.equal(await chatMessageOperationsBlockedWithin(f.db,{messageId:message.messageId}),true);
   await assert.rejects(f.db.query('SELECT current_event_id FROM operations_chat_message_visibility_v1'),/permission denied/);
   await assert.rejects(f.db.query('UPDATE operations_chat_message_visibility_v1 SET hidden=false'),/permission denied/);
   await assert.rejects(f.db.query('DELETE FROM operations_chat_message_visibility_v1'),/permission denied/);
   await f.db.exec('RESET ROLE');
   await f.db.query('DELETE FROM operations_chat_message_visibility_v1 WHERE endpoint=$1 AND report_id=$2 AND message_id=$3',[saved.endpoint,saved.report_id,saved.message_id]);
   await f.db.exec('SET ROLE galaxy_api');
   await f.db.query(`INSERT INTO operations_chat_message_visibility_v1(endpoint,report_id,message_id,message_revision,revision,hidden,initial_event_id,current_event_id,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[saved.endpoint,saved.report_id,saved.message_id,saved.message_revision,saved.revision,saved.hidden,saved.initial_event_id,saved.current_event_id,saved.updated_at]);
   assert.equal((await f.db.query('SELECT hidden FROM operations_chat_message_visibility_v1 WHERE message_id=$1',[message.messageId])).rows[0].hidden,true);
   await f.db.query('UPDATE operations_chat_message_visibility_v1 SET hidden=hidden,revision=revision WHERE message_id=$1',[message.messageId]);
   await assert.rejects(f.db.query('UPDATE operations_chat_message_visibility_v1 SET initial_event_id=current_event_id'),/permission denied/);
   await assert.rejects(f.db.query('DELETE FROM operations_chat_message_visibility_v1'),/permission denied/);
  }finally{await f.db.exec('RESET ROLE');}
 });
 assert.equal(JSON.stringify(f.logs).includes('PRIVATE_'),false);assert.deepEqual(f.issuer.failures,[]);
});
