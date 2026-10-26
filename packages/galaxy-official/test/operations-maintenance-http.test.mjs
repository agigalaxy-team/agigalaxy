import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {createApi} from '../src/http.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createOidcTransactionStore} from '../src/oidc-transaction-store.mjs';
import {createOperationsPortal} from '../src/operations-auth.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsMaintenanceService} from '../src/operations-maintenance.mjs';
import {MaintenanceNativeClient,maintenanceRequestSignature} from '../src/operations-maintenance-native.mjs';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {adminOrigin,operatorRoles,request,response,acceptCookies} from './operations-management-fixture.mjs';
import {operationsProxyPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// The new public/private registrations, OIDC, sessions, CSRF and PG grants are
// real. Only the maintenance socket's native effects are doubled. This is not
// a repository backup or production restoration check.
test('maintenance central HTTP confines exact metadata routes, fresh human grants and authenticated private intent', {timeout:90000},async t=>{
 const f=await accountChatFixture(),authDb=new PGlite();await migrate(authDb);const roles=new Map(),subjects=new Map(),nativeCalls=[],records=[];
// eslint-disable-next-line prefer-const -- Forward references must stay initialized to undefined when setup fails before assignment.
 let server;let issuer;let service;let afterAuthentication=null;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await issuer?.close();await authDb.close();await f.close();});
 const callback=adminOrigin+'/v1/operations/callback',now=()=>Math.floor(Date.now()/1000);
 issuer=await oidcProviderFixture([callback],{emailVerified:true,roleClaims:{realm_access:{roles:[operatorRoles.reader]}}});
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>roles.get(actor.operatorId)??null,now:f.now});
 const provider=await createOidcLoginProvider({id:'maintenance-http',name:'Synthetic maintenance operators',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:callback,includeOperatorRoles:true,includeAccountProfile:true,allowLoopbackHttp:true,now,transactionStore:createOidcTransactionStore({db:authDb,namespace:'maintenance-http',now})});
 const portal=createOperationsPortal({db:authDb,endpoint:f.endpoint,adminOrigin,provider,roles:operatorRoles,permissions,now,roleDirectory:{getOperatorRoles:async({externalSubject})=>subjects.has(externalSubject)?[operatorRoles[subjects.get(externalSubject)]]:[]}});
 const key='SYNTHETIC_MAINTENANCE_HTTP_SERVICE_KEY_ONLY',native=new MaintenanceNativeClient({key,now:f.now,transport:async input=>{
  nativeCalls.push(input);
  if(input.kind==='overview')return{availability:{state:'available'},components:[],storage:[],coverage:[],errors:{availability:{state:'unavailable'},count:null}};
  if(input.kind==='catalog')return{items:[],total:0,nextAfter:null,coverage:[],capabilities:{backupCreate:false,backupVerify:true}};
  if(input.kind==='logs')return{items:[],components:['api'],nextBefore:null};
  if(input.kind==='operation')return{id:input.operationId,kind:'backup-create',state:'running',steps:[],publicActivation:false};
  if(input.kind==='backup-create'){
   assert.equal((await service.authorizeNative({kind:input.kind,operationId:input.operationId,operatorId:input.operatorId})).authorized,true);
   return{id:input.operationId,kind:input.kind,state:'running',startedAt:new Date(f.now()*1000).toISOString(),steps:[],publicActivation:false};
  }
  throw Object.assign(Error('SYNTHETIC_NATIVE_PRIVATE_ERROR'),{code:'maintenance_native_unavailable',status:503});
 }});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now});service=new OperationsMaintenanceService({businessAdmin,native,now:f.now});
 server=createApi({bindings:{endpoint:f.endpoint},operationsMaintenance:service,maintenanceNative:native,operations:{portal:{...portal,authorizeOperator:async(req,options)=>{const actor=await portal.authorizeOperator(req,options);if(afterAuthentication&&options.action){const effect=afterAuthentication;afterAuthentication=null;await effect();}return actor;}}},browserOrigins:[adminOrigin],rateLimit:1000,logger:row=>records.push(row)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port,prefix='/v1/operations/maintenance';
 async function login(subject,role){
  subjects.set(subject,role);issuer.setAccount(subject);const jar=new Map(),started=response();await portal.login(request(jar),started,new URL(adminOrigin+'/v1/operations/login'));acceptCookies(jar,started);const completed=response();await portal.callback(request(jar),completed,await issuer.authorize(started.headers.get('location')));acceptCookies(jar,completed);
  const principal=(await authDb.query('SELECT * FROM operations_operator_principals_v1 WHERE endpoint=$1 AND external_subject=$2',[f.endpoint,subject])).rows[0];assert.ok(principal);
  await f.db.query('INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[principal.operator_id,f.endpoint,principal.issuer,principal.external_subject,principal.display_name,new Date(f.now()*1000)]);roles.set(principal.operator_id,role);
  return{jar,session:await portal.session(request(jar,{origin:adminOrigin})),actor:{kind:'business-operator',operatorId:principal.operator_id,role,endpoint:f.endpoint}};
 }
 const call=(path,who,input,extra={})=>{
  const method=input===undefined?'GET':'POST',headers={...request(who.jar,{origin:adminOrigin,...(input===undefined?{}:{'content-type':'application/json','x-galaxy-operator-csrf':who.session.csrfToken})},method).headers,...extra};for(const name of Object.keys(headers))if(headers[name]===null)delete headers[name];
  return fetch(base+path,{method,headers,...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(15000)});
 };
 const admin=await login('maintenance-http-admin','administrator'),reader=await login('maintenance-http-reader','reader');
 assert.equal((await fetch(base+prefix+'/overview',{headers:{origin:adminOrigin}})).status,401);assert.equal((await call(prefix+'/overview',reader)).status,403);
 let role;const saveRole=async codes=>{role=(await permissions.saveRole(admin.actor,{operationId:randomUUID(),...(role?{id:role.id}:{}),expectedVersion:role?.version??0,name:'Synthetic maintenance HTTP role',description:'',enabled:true,permissions:codes},{authorize:async()=>admin.actor})).role;};
 await saveRole(['maintenance.read','maintenance.logs.read','maintenance.backups.create']);await permissions.saveAssignment(admin.actor,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.actor.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin.actor});
 const okay=await call(prefix+'/overview',reader);assert.equal(okay.status,200);assert.equal((await okay.json()).storage.find(x=>x.id==='object-repository').usedBytes,null);
 assert.equal((await call(prefix+'/logs?component=api&level=error&period=1h&before=1792725810000000000&limit=2',reader)).status,200);assert.equal((await call(prefix+'/backups?limit=1',reader)).status,200);
 for(const path of ['/overview?limit=1','/logs?query=PRIVATE_LOGQL','/logs?limit=1&limit=2','/backups?point=forged','/restore-plans?operatorId=forged'])assert.equal((await call(prefix+path,reader)).status,400,path);
 const input={operationId:randomUUID(),kind:'create'};
 for(const csrf of [null,'WRONG_SYNTHETIC_CSRF'])assert.equal((await call(prefix+'/backups',reader,input,{'x-galaxy-operator-csrf':csrf})).status,403);
 assert.equal((await call(prefix+'/backups',reader,input,{origin:'https://foreign.example.invalid'})).status,403);assert.equal((await call(prefix+'/backups?limit=1',reader,input)).status,400);
 const made=await call(prefix+'/backups',reader,input);assert.equal(made.status,200);assert.equal((await made.json()).operation.id,input.operationId);
 assert.equal((await call(prefix+'/backups',reader,{...input,role:'administrator'})).status,400);
 const privatePath='/v1/internal/maintenance/authorize',privateInput={operationId:input.operationId,operatorId:reader.actor.operatorId,kind:'backup-create'},raw=JSON.stringify(privateInput),at=String(f.now()),id=randomUUID();
 const authHeaders={'content-type':'application/json','x-galaxy-service-key':key,'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(key,{id,at,body:raw})};
 assert.equal((await fetch(base+privatePath,{method:'POST',headers:{'content-type':'not-json'},body:'PRIVATE_MALFORMED_BODY'})).status,401);
 assert.equal((await fetch(base+privatePath,{method:'POST',headers:{...authHeaders,'x-galaxy-service-signature':'0'.repeat(64)},body:raw})).status,401);
 const authorized=await fetch(base+privatePath,{method:'POST',headers:authHeaders,body:raw});assert.equal(authorized.status,200);assert.equal((await authorized.json()).authorized,true);
 const changed=raw.replace('backup-create','backup-verify');assert.equal((await fetch(base+privatePath,{method:'POST',headers:authHeaders,body:changed})).status,401);
 const policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:adminOrigin+path,method,headers:new Headers(headers),publicOrigin:adminOrigin});
 assert.equal(operationsReadPath(prefix+'/logs?before=1792725810000000000&limit=2'),true);assert.equal(policy(prefix+'/backups','POST',{origin:adminOrigin}).allowed,true);
 for(const path of [privatePath,prefix+'/logs?sql=secret',prefix+'/overview?limit=1',prefix+'/backups?limit=1&limit=2'])assert.equal(policy(path).allowed,false);
 assert.equal(policy(privatePath,'POST',{origin:adminOrigin}).allowed,false);assert.equal(policy(prefix+'/backups','POST',{origin:'https://foreign.example.invalid'}).allowed,false);
 const before=nativeCalls.length;afterAuthentication=()=>saveRole([]);assert.equal((await call(prefix+'/overview',reader)).status,403);assert.equal(nativeCalls.length,before);
 assert.equal((await fetch(base+privatePath,{method:'POST',headers:authHeaders,body:raw})).status,403);
 assert.ok(!JSON.stringify(records).includes('PRIVATE_MALFORMED_BODY'));assert.ok(!JSON.stringify(records).includes('SYNTHETIC_NATIVE_PRIVATE_ERROR'));assert.ok(!JSON.stringify(records).includes(key));
});
