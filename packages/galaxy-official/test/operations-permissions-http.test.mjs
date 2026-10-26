import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {migrate} from '../src/database.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createOidcTransactionStore} from '../src/oidc-transaction-store.mjs';
import {createOperationsPortal} from '../src/operations-auth.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {ForumAttachmentsV1Service} from '../src/forum-attachments-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {OperationsResourcesService} from '../src/operations-resources.mjs';
import {OperationsFilesService} from '../src/operations-files.mjs';
import {OperationsFeedbackService} from '../src/operations-feedback.mjs';
import {OperationsProductRules} from '../src/operations-product-rules.mjs';
import {OperationsNotices} from '../src/operations-notices.mjs';
import {OperationsRetention} from '../src/operations-retention.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {ContentPublications} from '../src/content-publications.mjs';
import {SearchIndex} from '../src/search-index.mjs';
import {createOperationsJobs} from '../src/operations-jobs.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {adminOrigin,operatorRoles,request,response,acceptCookies} from './operations-management-fixture.mjs';

// Real registered HTTP, loopback OIDC, PG business grants and pg-boss. The
// upstream role directory, business email directory and original chat/file
// transport are explicit fixture contracts. There are no external identities,
// live messages, emails, storage changes or automatic execution engines here.
async function fixture(t){
// eslint-disable-next-line prefer-const -- Forward references must stay initialized to undefined when setup fails before assignment.
 const f=await accountChatFixture();let authDb;let issuer;let jobs;let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await jobs?.stop();await issuer?.close();await authDb?.close();await f.close();});
 authDb=new PGlite();await migrate(authDb);
 const roles=new Map(),callback=adminOrigin+'/v1/operations/callback',now=()=>Math.floor(Date.now()/1000);
 issuer=await oidcProviderFixture([callback],{emailVerified:true,roleClaims:{realm_access:{roles:[operatorRoles.reader]}}});
 const operatorAuthorization=async(actor,{db=f.db}={})=>{
  const row=(await db.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[f.endpoint,actor.operatorId])).rows[0];
  if(!row||row.issuer!==issuer.issuer)throw new ServiceError('business_admin_denied',403);
  const names=roles.get(row.external_subject)??[];return names.includes(operatorRoles.administrator)?'administrator':names.includes(operatorRoles.reader)?'reader':null;
 };
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization,now:f.now});
 const provider=await createOidcLoginProvider({id:'permission-http',name:'Synthetic operators',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:callback,includeOperatorRoles:true,includeAccountProfile:true,allowLoopbackHttp:true,now,
  transactionStore:createOidcTransactionStore({db:authDb,namespace:'permission-http',now})});
 const portal=createOperationsPortal({db:authDb,endpoint:f.endpoint,adminOrigin,provider,roles:operatorRoles,permissions,now,
  roleDirectory:{async getOperatorRoles({externalSubject}){return [...(roles.get(externalSubject)??[])];}}});
 let identityReads=0;
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,operatorAuthorization,now:f.now,identityDirectory:{async get(){identityReads++;return null;},async findByEmail(){identityReads++;return[];}}});
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts});
 businessAdmin.forum=forum;
 const forumFiles=new ForumAttachmentsV1Service({forum,store:f.files.store,scanner:f.files.scanner});forum.attachments=forumFiles;
 const community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),files=new OperationsFilesService({businessAdmin,chatAttachments:f.files,forumAttachments:forumFiles,now:f.now}),
  resources=new OperationsResourcesService({businessAdmin,projects:null,capsules:null,maxHideSeconds:forum.policy.maxGovernanceHideSeconds,now:f.now}),feedback=new OperationsFeedbackService({businessAdmin,accounts:f.accounts,now:f.now});
 jobs=createOperationsJobs({db:f.db,supervise:false});await jobs.start();
 const notices=new OperationsNotices({db:f.db,endpoint:f.endpoint,businessAdmin,accounts:f.accounts,jobs,now:f.now}),retention=new OperationsRetention({db:f.db,endpoint:f.endpoint,businessAdmin,jobs,now:f.now}),
  rules=new OperationsProductRules({db:f.db,endpoint:f.endpoint,businessAdmin,now:f.now}),publications=new ContentPublications({db:f.db,endpoint:f.endpoint,businessAdmin,jobs,now:f.now}),
  chatReports=new AccountChatGovernanceService({chat:f.chat,businessAdmin}),searchIndex=new SearchIndex({db:f.db,endpoint:f.endpoint,jobs,now:f.now});
 const calls=[],logs=[],control={afterAuthentication:null};
 server=createApi({bindings:{endpoint:f.endpoint},operationsPermissions:permissions,businessAdmin,operationsCommunity:community,operationsResources:resources,operationsFiles:files,operationsFeedback:feedback,
  operationsRules:rules,operationsNotices:notices,operationsRetention:retention,contentPublications:publications,accountChatGovernance:chatReports,operationsJobs:jobs,searchIndex,
  operations:{portal:{...portal,authorizeOperator:async(req,options)=>{calls.push(options);const actor=await portal.authorizeOperator(req,options);if(control.afterAuthentication){const work=control.afterAuthentication;control.afterAuthentication=null;await work();}return actor;}}},
  browserOrigins:[adminOrigin],rateLimit:1000,logger:entry=>logs.push(entry)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 async function login(subject,role){
  roles.set(subject,[operatorRoles[role]]);issuer.setAccount(subject);const jar=new Map(),started=response();await portal.login(request(jar),started,new URL(adminOrigin+'/v1/operations/login'));acceptCookies(jar,started);
  const completed=response();await portal.callback(request(jar),completed,await issuer.authorize(started.headers.get('location')));acceptCookies(jar,completed);
  const principal=(await authDb.query('SELECT * FROM operations_operator_principals_v1 WHERE endpoint=$1 AND external_subject=$2',[f.endpoint,subject])).rows[0];assert(principal);
  await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$6)`,[principal.operator_id,f.endpoint,principal.issuer,principal.external_subject,principal.display_name,new Date(f.now()*1000)]);
  const session=await portal.session(request(jar,{origin:adminOrigin}));assert.equal(session.state,'signed-in');assert.equal(session.operator.role,role);return {jar,session,subject};
 }
 const call=(path,who,input,extra={})=>{
  const method=input===undefined?'GET':'POST',headers={...request(who.jar,{origin:adminOrigin,...(input===undefined?{}:{'content-type':'application/json','x-galaxy-operator-csrf':who.session.csrfToken})},method).headers,...extra};
  for(const key of Object.keys(headers))if(headers[key]===null)delete headers[key];
  return fetch(base+path,{method,headers,...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(15000)});
 };
 return {...f,permissions,businessAdmin,portal,roles,jobs,feedback,community,searchIndex,issuer,base,call,login,calls,logs,control,identityReads:()=>identityReads};
}

test('registered business authorization keeps independent login, exact APIs and existing operations under current PG permissions',{timeout:120000},async t=>{
 const f=await fixture(t),admin=await f.login('permission-http-admin','administrator'),reader=await f.login('permission-http-reader','reader'),root='/v1/operations/permissions';
 let role;
 const saveRole=async codes=>{
  const result=await f.call(root+'/roles',admin,{operationId:randomUUID(),...(role?{id:role.id}:{}),expectedVersion:role?.version??0,name:'PRIVATE_ROLE_NAME',description:'PRIVATE_ROLE_DESCRIPTION',enabled:true,permissions:codes});
  assert.equal(result.status,200);role=(await result.json()).role;return role;
 };
 await t.test('REST uses a real current operator and exact parameters, and a reader can perform only granted business writes',async()=>{
  assert.equal((await f.call(root+'/catalog',reader)).status,403);
  assert.equal((await fetch(f.base+root+'/catalog',{headers:{origin:adminOrigin}})).status,401);
  const before=f.calls.length;
  for(const path of [root+'/catalog?operatorId=forged',root+'/roles?scope=all',root+'/history?after=1&after=2',root+'/history?role=administrator',root+'/history?query=PRIVATE_QUERY',root+'/history?after='+'1'.repeat(8193)]){
   assert.equal((await f.call(path,admin)).status,400,path);
  }
  assert.equal(f.calls.length,before,'global exact query policy rejects these before authentication');
  for(const path of [root+'/effective',root+'/execute',root+'/roles/'+randomUUID()+'/grant'])assert.equal((await f.call(path,admin)).status,404,path);
  assert.equal((await f.call(root+'/roles',admin,{operationId:randomUUID(),expectedVersion:0,name:'synthetic',description:'',enabled:true,permissions:[]},{'x-galaxy-operator-csrf':null})).status,403);
  await saveRole(['permissions.read','accounts.read','accounts.restriction.apply']);
  const assigned=await f.call(root+'/assignments',admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.session.operator.id,roleId:role.id,enabled:true});assert.equal(assigned.status,200);
  const catalog=await f.call(root+'/catalog',reader);assert.equal(catalog.status,200);assert.equal((await catalog.json()).permissions.canManageRoles,false);
  const snapshot=await (await f.call('/v1/operations/session',reader)).json();assert.equal(snapshot.operator.role,'reader');assert(snapshot.operator.businessAuthorization.permissions.includes('accounts.restriction.apply'));
  const users=await (await f.call('/v1/operations/users',reader)).json();assert.equal(users.items.length,3);assert(users.items.every(user=>user.identity.email===null&&user.identity.state==='not-authorized'));assert.equal(f.identityReads(),0);
  assert.equal((await f.call('/v1/operations/users?query=private%40example.invalid',reader)).status,403);assert.equal(f.identityReads(),0);
  const target='/v1/operations/users/'+f.people[0].accountId,command={operationId:randomUUID(),expectedRevision:0,until:new Date((f.now()+60)*1000).toISOString(),reason:'PRIVATE_RESTRICTION_REASON'};
  assert.equal((await f.call(target+'/restriction',reader,{...command,role:'administrator',operatorId:admin.session.operator.id})).status,400);
  const changed=await f.call(target+'/restriction',reader,command);assert.equal(changed.status,200);assert.equal((await changed.json()).restriction.active,true);
  assert.equal((await f.db.query('SELECT operator_role FROM business_admin_audit_v1 WHERE operation_id=$1',[command.operationId])).rows[0].operator_role,'reader');
  assert.equal((await f.call(target+'/restriction/release',reader,{operationId:randomUUID(),expectedRevision:1,reason:'没有授予解除动作'})).status,403);
  const disabled=await f.call(root+'/roles',admin,{operationId:randomUUID(),id:role.id,expectedVersion:role.version,name:role.name,description:role.description,enabled:false,permissions:role.permissions});assert.equal(disabled.status,200);role=(await disabled.json()).role;
  assert.equal((await f.call(target+'/restriction',reader,command)).status,403,'an old success receipt cannot preserve a revoked action');
  assert.deepEqual((await (await f.call('/v1/operations/session',reader)).json()).operator.businessAuthorization.permissions,[]);
  const history=await f.call(root+'/history?resourceId='+role.id+'&limit=1',admin);assert.equal(history.status,200);const page=await history.json();assert.equal(page.items.length,1);assert(page.nextAfter);assert.equal(Object.hasOwn(page.items[0],'input'),false);
 });
 await t.test('existing reads and real SQL summary stay within module grants, while queue and search commands recheck their business action inside the transaction',async()=>{
  await f.feedback.submit(f.people[0],{operationId:randomUUID(),body:'PRIVATE_FEEDBACK_BODY',category:'problem',module:'other'});
  await saveRole(['workbench.read','feedback.read']);
  const summary=await f.call('/v1/operations/summary',reader);assert.equal(summary.status,200);const value=await summary.json();assert.equal(value.feedback.pending,1);assert.equal(value.availability.feedback,'available');
  for(const key of ['communityReports','chatReports','sections','resources','files','jobs','search','businessActivity','recentOperations']){assert.equal(value[key],null,key);assert.equal(value.availability[key],'not-authorized');}
  assert.equal(value.analytics.state,'not-collected');assert.equal(value.ai,null);assert.equal(JSON.stringify(value).includes('PRIVATE_'),false);
  for(const path of ['/v1/operations/users','/v1/operations/users/summary','/v1/operations/community/sections','/v1/operations/community/reports','/v1/operations/community/content','/v1/operations/community/tags',
   '/v1/operations/resources/projects','/v1/operations/files/summary','/v1/operations/chat-reports','/v1/operations/notices','/v1/operations/rules','/v1/operations/retention','/v1/operations/jobs','/v1/operations/search/failures','/v1/operations/audit'])assert.equal((await f.call(path,reader)).status,403,path);
  const feedbackId=(await f.db.query('SELECT id FROM operations_feedback_v1 LIMIT 1')).rows[0].id;
  assert.equal((await f.call('/v1/operations/feedback/'+feedbackId+'/attachments/'+randomUUID()+'/content',reader,{})).status,403);
  assert.equal((await f.call('/v1/operations/community/content/post/'+randomUUID()+'/attachments/'+randomUUID()+'/content',reader,{})).status,403);
  assert.equal((await f.call('/v1/operations/chat-reports/'+randomUUID()+'/attachments/'+randomUUID()+'/content',reader,{})).status,403);
  await saveRole(['jobs.read','jobs.retry']);
  const jobId=await f.jobs.enqueue('account-notice',{noticeId:randomUUID()},{key:'permission-test:'+randomUUID()});await f.db.query("UPDATE galaxy_jobs.job SET state='failed' WHERE id=$1",[jobId]);
  const retry='/v1/operations/jobs/account-notice/'+jobId+'/retry';assert.equal((await f.call(retry,reader,{})).status,403);
  assert.equal((await f.db.query('SELECT state FROM galaxy_jobs.job WHERE id=$1',[jobId])).rows[0].state,'failed','jobs.retry alone cannot bypass notices.publish');
  await saveRole(['jobs.read','jobs.retry','notices.publish']);assert.equal((await f.call(retry,reader,{})).status,200);
  assert.notEqual((await f.db.query('SELECT state FROM galaxy_jobs.job WHERE id=$1',[jobId])).rows[0].state,'failed');
  await saveRole(['search.retry']);
  f.control.afterAuthentication=()=>saveRole([]);
  assert.equal((await f.call('/v1/operations/search/failures/'+randomUUID()+'/retry',reader,{expectedGeneration:1})).status,403);
  await assert.rejects(f.searchIndex.retryFailed({jobId:randomUUID(),expectedGeneration:1},{authorize:async()=>{throw new ServiceError('operations_permission_denied',403);}}),{code:'operations_permission_denied'},'the transaction checks authorization before even looking up a target');
 });
 await t.test('migration 103 grants API exact mutations and leaves worker and publisher permission data read-only',async()=>{
  await migrate(f.db,{roles:['api','worker','content-publisher']});
  const actor={kind:'business-operator',operatorId:admin.session.operator.id,role:'administrator',endpoint:f.endpoint};
  try{
   await f.db.query('SET ROLE galaxy_api');
   const made=await f.permissions.saveRole(actor,{operationId:randomUUID(),expectedVersion:0,name:'SQL role proof',description:'',enabled:true,permissions:['content.read']},{authorize:async()=>actor});assert.equal(made.role.version,1);
   await assert.rejects(f.db.query('DELETE FROM operations_business_roles_v1 WHERE false'),{code:'42501'});
   await assert.rejects(f.db.query("UPDATE operations_permission_events_v1 SET input='{}'::jsonb WHERE false"),{code:'42501'});
   await f.db.query('RESET ROLE');await f.db.query('SET ROLE galaxy_evidence_worker');
   assert.equal((await f.permissions.effective(actor)).source,'preconfigured-root');
   await assert.rejects(f.db.query('UPDATE operations_permission_authority_v1 SET version=version+1 WHERE false'),{code:'42501'});
   await assert.rejects(f.db.query('SELECT input FROM operations_permission_events_v1 LIMIT 1'),{code:'42501'});
   await f.db.query('RESET ROLE');await f.db.query('SET ROLE galaxy_content_publisher');
   assert((await f.permissions.requireAction(actor,'cms.publish')).businessAuthorization.permissions.includes('cms.publish'));
   await assert.rejects(f.db.query('SELECT id FROM community_accounts LIMIT 1'),{code:'42501'});
   await assert.rejects(f.db.query('DELETE FROM operations_role_assignments_v1 WHERE false'),{code:'42501'});
  }finally{await f.db.query('RESET ROLE');}
 });
 assert.equal(JSON.stringify(f.logs).includes('PRIVATE_'),false);assert.deepEqual(f.issuer.failures,[]);
});

test('permission audit retains only closed change metadata, never role prose, permission input, identities or future strings',()=>{
 const id=randomUUID(),base={id,sequence:1,operator_id:'synthetic-operator',operator_role:'reader',action:'permission-role-save',account_id:null,operation_id:randomUUID(),http_request_id:randomUUID(),created_at:new Date(),
  selection:{resourceId:id,expectedVersion:1,changedFields:['name','permissions','enabled'],name:'PRIVATE_NAME',description:'PRIVATE_DESCRIPTION',permissions:['PRIVATE_PERMISSION'],query:'PRIVATE_QUERY',summary:'PRIVATE_SUMMARY'},
  result:{version:2,enabled:false,permissionCount:1,role:{name:'PRIVATE_NAME'},input:{authorization:'PRIVATE_TOKEN'}}};
 const view=businessAuditMetadata(base);assert.deepEqual(view.selection,{resourceId:id,expectedVersion:1,changedFields:['name','permissions','enabled']});assert.deepEqual(view.result,{version:2,enabled:false,permissionCount:1});
 assert.equal(JSON.stringify(view).includes('PRIVATE_'),false);
 const unknown=businessAuditMetadata({...base,selection:{...base.selection,changedFields:['PRIVATE_FIELD']},result:{...base.result,enabled:'PRIVATE_STATE'}});
 assert.equal(Object.hasOwn(unknown.selection,'changedFields'),false);assert.equal(Object.hasOwn(unknown.result,'enabled'),false);assert.equal(JSON.stringify(unknown).includes('PRIVATE_'),false);
});
