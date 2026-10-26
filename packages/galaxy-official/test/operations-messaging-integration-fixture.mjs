import assert from 'node:assert/strict';
import 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {adminOrigin,operatorRoles,request,response,acceptCookies} from './operations-management-fixture.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createOidcTransactionStore} from '../src/oidc-transaction-store.mjs';
import {createOperationsPortal} from '../src/operations-auth.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsSmtpService} from '../src/operations-smtp.mjs';
import {OperationsMessagingService} from '../src/operations/messaging/service.mjs';
import {createSmtpCredentialResolver} from '../src/infrastructure/operations-smtp-credentials.mjs';
import {createApi} from '../src/http.mjs';
import {queueFixture} from './operations-jobs-fixture.mjs';

// A registered local API and loopback OIDC over real PGlite and native pg-boss.
// Upstream operator/recipient directories and SMTP are explicit doubles.
export async function messagingIntegrationFixture(t){
 const f=await accountChatFixture(),roles=new Map(),calls=[],logs=[],mailCalls=[],identities=new Map();
// eslint-disable-next-line prefer-const -- Forward references must stay initialized to undefined when setup fails before assignment.
 let issuer;let server;let queue;let authDb;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await queue?.jobs.stop();await issuer?.close();await authDb?.close();await f.close();});
 authDb=new PGlite();await migrate(authDb);
 const callback=adminOrigin+'/v1/operations/callback',now=()=>Math.floor(Date.now()/1000);
 issuer=await oidcProviderFixture([callback],{emailVerified:true,roleClaims:{realm_access:{roles:[operatorRoles.reader]}}});
 const operatorAuthorization=async actor=>roles.get(actor.operatorId)??null;
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization,now:f.now});
 const provider=await createOidcLoginProvider({id:'messaging-central',name:'Synthetic operators',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:callback,
  includeOperatorRoles:true,includeAccountProfile:true,allowLoopbackHttp:true,now,transactionStore:createOidcTransactionStore({db:authDb,namespace:'messaging-central',now})});
 const subjects=new Map(),portal=createOperationsPortal({db:authDb,endpoint:f.endpoint,adminOrigin,provider,roles:operatorRoles,permissions,now,
  roleDirectory:{getOperatorRoles:async({externalSubject})=>[operatorRoles[subjects.get(externalSubject)??'reader']]}});
 f.people.forEach((person,index)=>identities.set('synthetic-'+index,{issuer:'https://login.example.org',externalSubject:'synthetic-'+index,email:'PRIVATE_SYNTHETIC_'+index+'@example.invalid',emailVerified:true,enabled:true}));
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,operatorAuthorization,identityDirectory:{get:async({externalSubject})=>identities.get(externalSubject)},now:f.now});
 const credentialResolver=createSmtpCredentialResolver([{ref:'synthetic-approved',label:'本地测试引用',host:'smtp.example.invalid',port:2525,tls:'starttls',purposes:['account','notice','community','updates','team'],user:'PRIVATE_SMTP_USER',password:'PRIVATE_SMTP_PASSWORD'}]);
 const control={transportResult:{submission:'submitted',code:null,retryable:false},beforeSubmit:null};
 const transport={verify:async(_configuration,input)=>{await input.authorize();mailCalls.push({kind:'connection'});return {submission:'connected',code:null,retryable:false};},
  submit:async(_configuration,input)=>{if(control.beforeSubmit)await control.beforeSubmit();await input.authorize();mailCalls.push({kind:'delivery',messageId:input.messageId});return control.transportResult;}};
 const smtp=new OperationsSmtpService({db:f.db,endpoint:f.endpoint,businessAdmin,credentialResolver,directory:{get:async({externalSubject})=>identities.get(externalSubject)},transport,
  resolveTxt:async name=>name.startsWith('_dmarc.')?[['v=DMARC1; p=none']]:name.includes('._domainkey.')?[['v=DKIM1; p=SYNTHETIC_PUBLIC_KEY']]:[['v=spf1 -all']],now:f.now});
 queue=queueFixture(f.db);await queue.jobs.start();
 const messaging=new OperationsMessagingService({db:f.db,endpoint:f.endpoint,businessAdmin,accounts:f.accounts,jobs:queue.jobs,mailProvider:smtp,now:f.now});
 server=createApi({bindings:{endpoint:f.endpoint},operationsMessaging:messaging,operationsSmtp:smtp,operationsPermissions:permissions,businessAdmin,operationsJobs:queue.jobs,
  operations:{portal:{...portal,authorizeOperator:async(req,options)=>{calls.push(options);return portal.authorizeOperator(req,options);}}},browserOrigins:[adminOrigin],rateLimit:2000,logger:entry=>logs.push(entry)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 async function login(subject,role){
  subjects.set(subject,role);issuer.setAccount(subject);const jar=new Map(),started=response();await portal.login(request(jar),started,new URL(adminOrigin+'/v1/operations/login'));acceptCookies(jar,started);
  const completed=response();await portal.callback(request(jar),completed,await issuer.authorize(started.headers.get('location')));acceptCookies(jar,completed);
  const principal=(await authDb.query('SELECT * FROM operations_operator_principals_v1 WHERE endpoint=$1 AND external_subject=$2',[f.endpoint,subject])).rows[0];assert(principal);
  await f.db.query('INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[principal.operator_id,f.endpoint,principal.issuer,principal.external_subject,principal.display_name,new Date(f.now()*1000)]);
  roles.set(principal.operator_id,role);const session=await portal.session(request(jar,{origin:adminOrigin}));assert.equal(session.state,'signed-in');return {jar,session,subject,actor:{kind:'business-operator',operatorId:principal.operator_id,role,endpoint:f.endpoint}};
 }
 const call=(path,who,input,extra={})=>{
  const method=input===undefined?'GET':'POST',headers={...request(who.jar,{origin:adminOrigin,...(input===undefined?{}:{'content-type':'application/json','x-galaxy-operator-csrf':who.session.csrfToken})},method).headers,...extra};
  for(const key of Object.keys(headers))if(headers[key]===null)delete headers[key];
  return fetch(base+path,{method,headers,...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(15000)});
 };
 const configuration=()=>({enabled:false,host:'smtp.example.invalid',port:2525,tls:'starttls',credentialRef:'synthetic-approved',connectionTimeoutMs:1000,greetingTimeoutMs:1000,socketTimeoutMs:1000,maxConnections:2,rateLimit:100,rateWindowSeconds:60,dkimSelector:'synthetic'});
 const config=(changes={})=>({channels:['announcement','inapp'],content:{purpose:'service-update',title:'本地合成公告',body:'PRIVATE_MESSAGE_BODY',href:'/guide/',expiresAt:new Date((f.now()+86400)*1000).toISOString()},audience:{kind:'all-accounts'},senderKey:'notice',schedule:{kind:'immediate'},...changes});
 return {...f,permissions,businessAdmin,smtp,messaging,queue,roles,subjects,issuer,portal,base,call,login,calls,logs,control,mailCalls,identities,configuration,config};
}
