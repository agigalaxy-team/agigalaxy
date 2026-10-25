import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {OperationsRegisteredUsersService} from '../src/operations/accounts/registered-service.mjs';
import {createKeycloakWebsiteDirectory} from '../src/keycloak-website-directory.mjs';
import {createOfficialAccountPortal} from '../src/official-account.mjs';
import {OfficialAccountSessionStore} from '../src/official-account-session-store.mjs';
import {createAccountUid,upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from '../src/official-account-uid.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';
import {registeredUsersPermissionCodes} from '../src/infrastructure/operations-registered-users-v1-schema.mjs';

function nativeFixture(users,issuer='https://website-auth.example/realms/galaxy'){
 const state={users,mode:'normal',writes:[],reads:[],tokens:[],beforeGet:null},privateValue='SYNTHETIC_PRIVATE_CREDENTIAL_AND_NATIVE_ERROR';
 const transport=async(url,options={})=>{
  const u=new URL(url),method=options.method??'GET',path=u.pathname;
  if(path.endsWith('/token')){
   const body=new URLSearchParams(options.body),client=body.get('client_id');state.tokens.push(client);
   return Response.json({access_token:client==='website-manager'?'local-management-token':'local-reader-token',expires_in:60});
  }
  const selected=decodeURIComponent(path.split('/users/')[1]?.split('/')[0]??''),user=state.users.find(row=>row.id===selected);
  if(method==='GET'){
   state.reads.push(path+u.search);
   if(path.endsWith('/users/count'))return Response.json(state.users.length);
   if(path.endsWith('/users')){const first=Number(u.searchParams.get('first')),max=Number(u.searchParams.get('max'));
    if(state.mode==='page-failure'&&first>=100)return Response.json({error:privateValue},{status:503});return Response.json(state.users.slice(first,first+max));}
   if(!user)return Response.json({error:privateValue},{status:404});
   if(path.endsWith('/credentials'))return Response.json(user.requiredActions?.includes('UPDATE_PASSWORD')?[]:[{id:'private-id',type:'password',secretData:privateValue,credentialData:privateValue}]);
   if(path.endsWith('/federated-identity'))return Response.json([]);
   if(path.endsWith('/sessions'))return Response.json([{id:privateValue,accessToken:privateValue,ipAddress:privateValue}]);
   if(state.beforeGet)await state.beforeGet(user,options);
   return Response.json({...user,access:{manage:options.headers.authorization==='Bearer local-management-token'},credentials:[{secretData:privateValue}],attributes:{private:privateValue}});
  }
  assert.equal(options.headers.authorization,'Bearer local-management-token','native mutation uses the separate management client');
  state.writes.push({selected,path,method,body:options.body});
  if(state.mode==='lost-reset'&&path.endsWith('/execute-actions-email'))throw Error(privateValue);
  if(state.mode==='write-forbidden')return Response.json({error:privateValue},{status:403});
  if(!user)return Response.json({error:privateValue},{status:404});
  if(method==='PUT'&&!path.endsWith('/execute-actions-email'))Object.assign(user,JSON.parse(options.body));
  return new Response(null,{status:204});
 };
 const directory=createKeycloakWebsiteDirectory({issuer,reader:{clientId:'website-reader',clientSecret:'local-read-only-fixture'},writer:{clientId:'website-manager',clientSecret:'local-management-fixture'},fetch:transport});
 return {directory,state,privateValue,transport};
}

// Real PG authority, old released <=119 plus 121 (held120 deliberately absent),
// and real API/worker SQL roles. Native Keycloak HTTP is an explicit transport
// double. This is not a live realm or production account-management test.
test('registered directory counts the complete observed generation and original commands preserve current identity, permissions, business and session boundaries',{timeout:120000},async t=>{
 const db=new PGlite();t.after(()=>db.close());
 const selected=migrations.filter(row=>row.version<=119||row.version===121);
 assert(selected.some(row=>row.version===121),'central must register the complete 119-to-121 migration before this group runs');
 await db.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const row of selected){await db.exec(row.sql);await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[row.version]);}
 assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='operations_automation_grants_v1' AND column_name='ai_domains'")).rows[0].n,0,'held120 was not applied');
 const apiRoleFile=process.env.GALAXY_REGISTERED_USERS_API_ROLE_FILE??new URL('../src/infrastructure/api-role.sql',import.meta.url);
 const apiSql=await readFile(apiRoleFile,'utf8');assert(!/\bai_domains\b/.test(apiSql),'use the released119-to-121 role baseline, not held120 permissions');await db.exec(apiSql);
 const workerRoleFile=process.env.GALAXY_REGISTERED_USERS_WORKER_ROLE_FILE??new URL('../src/infrastructure/worker-role.sql',import.meta.url);await db.exec(await readFile(workerRoleFile,'utf8'));
 const endpoint='https://registered-users.example',issuer='https://website-auth.example/realms/galaxy',clock=Date.parse('2030-01-01T00:00:00.000Z')/1000,now=()=>clock,at=new Date(clock*1000).toISOString();
 const admin={kind:'business-operator',operatorId:'registered-admin',role:'administrator',endpoint},reader={...admin,operatorId:'registered-reader',role:'reader'},basic={...reader,operatorId:'registered-basic'},ungranted={...reader,operatorId:'registered-ungranted'};
 for(const actor of [admin,reader,basic,ungranted])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.example',$1,'本地目录管理者',$3,$3)",[actor.operatorId,endpoint,at]);
 const upstream=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader'],[basic.operatorId,'reader'],[ungranted.operatorId,'reader']]);
 const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async actor=>upstream.get(actor.operatorId),now}),businessAdmin=new BusinessAdminService({db,endpoint,permissions,now});
 const saveRole=(name,codes)=>permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name,description:'Local registration management fixture',enabled:true,permissions:codes},{authorize:async()=>admin});
 let role=(await saveRole('注册管理必要动作',[...registeredUsersPermissionCodes,'accounts.identity.read'])).role;
 const basicRole=(await saveRole('仅基础注册目录',['accounts.registered.read'])).role;
 for(const [actor,roleId]of [[reader,role.id],[basic,basicRole.id]])await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:actor.operatorId,roleId,enabled:true},{authorize:async()=>admin});
 const users=Array.from({length:123},(_,index)=>({id:randomUUID(),email:'registered-'+index+'@example.invalid',enabled:true,emailVerified:index!==85,createdTimestamp:Date.parse('2029-01-01T00:00:00.000Z')+index*1000,
  firstName:'来源姓名'+index,lastName:'',requiredActions:index===85?['UPDATE_PASSWORD']:[]}));users[122].email=users[0].email;
 const fixture=nativeFixture(users,issuer),{directory,state,privateValue}=fixture,accountId=randomUUID(),orphanId=randomUUID(),uid=createAccountUid();
 for(const [id,subject,scopeIssuer]of [[accountId,users[0].id,issuer],[orphanId,randomUUID(),'https://retired-website.example/realms/galaxy']]){
  await db.query("INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at,restricted_until) VALUES($1,$2,$3,$4,$5,'email',$6,$6,$7)",[id,id===accountId?uid:createAccountUid(),endpoint,scopeIssuer,subject,at,id===accountId?'2030-02-01T00:00:00.000Z':null]);
  await db.query("INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,revision,updated_at) VALUES($1,'person','本人选择的业务名',0,$2)",[id,at]);
 }
 const provider={describe:()=>({issuer,clientId:'website',redirectUri:endpoint+'/v1/account/callback'})};
 const portal=createOfficialAccountPortal({db,endpoint,websiteOrigin:'https://website.example',provider,associationProviders:[provider],now});
 const service=new OperationsRegisteredUsersService({businessAdmin,directory,accountPortal:portal,now}),auth={authorize:async()=>reader};
 await db.exec('SET ROLE galaxy_api');
 const initial=await service.list(reader);assert.equal(initial.pagination.total,null);assert.deepEqual(initial.items,[]);assert.equal(initial.source.coverage,'not-ready');
 const accountCountBefore=Number((await db.query('SELECT count(*) AS n FROM community_accounts')).rows[0].n);
 await db.exec('SET ROLE galaxy_evidence_worker');assert.equal((await service.sync()).state,'complete');
 await assert.rejects(db.query('UPDATE operations_registered_commands_v1 SET state=state'),{code:'42501'});
 await db.exec('SET ROLE galaxy_api');
 const page=await service.list(reader,{page:7,pageSize:20,source:'registered',sort:'registered-asc'});
 assert.equal(page.source.registeredCount,123);assert.equal(page.pagination.matchingTotal,123);assert.equal(page.pagination.totalPages,7);assert.equal(page.items.length,3);
 assert.equal(new Set(page.items.map(row=>row.registrationId)).size,3);assert(page.items.every(row=>row.business===null),'late pages include users with no business profile');
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM community_accounts')).rows[0].n),accountCountBefore,'GET and sync never create business identities');
 const narrowed=await service.list(reader,{source:'registered',subjectType:'person',participation:'restricted',business:'formed',registeredFrom:'2029-01-01T00:00:00.000Z',registeredTo:'2029-01-01T00:00:00.000Z'});
 assert.equal(narrowed.pagination.matchingTotal,1);assert.equal(narrowed.items[0].business.accountId,accountId);const target=narrowed.items[0].registrationId;
 assert.equal((await service.list(reader,{query:users[0].email})).pagination.matchingTotal,2,'matching emails never merge distinct issuer/sub identities');
 const orphan=await service.list(reader,{source:'business-only'});assert.equal(orphan.pagination.matchingTotal,1);assert.equal(orphan.items[0].identity.presence,'outside-configured-issuer');
 assert.equal((await service.list(reader,{participation:'unrestricted'})).pagination.matchingTotal,1,'no-business is not mislabeled normal business participation');
 const baseList=await service.list(basic,{source:'registered',query:uid});assert.equal(baseList.pagination.matchingTotal,1);assert.equal(baseList.items[0].identity.email,null);assert.equal(baseList.items[0].identity.issuer,null);
 await assert.rejects(service.list(basic,{query:users[0].email}),{code:'operations_permission_denied'});
 for(const actor of [ungranted,{...ungranted,role:'administrator'},{...reader,endpoint:'https://foreign.example'}])await assert.rejects(service.list(actor),error=>['operations_permission_denied','business_admin_denied'].includes(error.code));
 const oldGeneration=page.source.generationId;state.mode='page-failure';await db.exec('SET ROLE galaxy_evidence_worker');assert.equal((await service.sync()).state,'failed');await db.exec('SET ROLE galaxy_api');state.mode='normal';
 const afterFailure=await service.list(reader);assert.equal(afterFailure.source.generationId,oldGeneration);assert.equal(afterFailure.source.state,'unavailable');assert.equal(afterFailure.pagination.total,124,'a partial generation is never published or counted');
 const missingBusiness=(await service.list(reader,{source:'registered',query:'registered-85@example.invalid'})).items[0];
 const pending=await service.detail(reader,missingBusiness.registrationId);assert.equal(pending.item.stage.state,'completion-required');assert.equal(pending.businessRef,null);assert.equal(pending.capabilities.canCorrectProfile,false);
 const first=await service.detail(reader,target);assert.equal(first.item.stage.state,'registered');assert.equal(first.security.sessions.sso.activeCount,1);assert.equal(first.security.sessions.website.activeCount,0);
 assert(!JSON.stringify(first).includes(privateValue));assert.equal(first.readExpiresAt-first.checkedAt,30);
 const correction={operationId:randomUUID(),kind:'profile-correct',expectedVersion:first.targetVersion,expectedProfileRevision:0,displayName:'运营记录纠正后的业务名',reason:'本人提出明确昵称纠正',basis:'当前已核对的本人请求'};
 const corrected=await service.command(reader,target,correction,auth);assert.equal(corrected.state,'completed');assert.equal(corrected.result.effects.profile.revision,1);assert.deepEqual(corrected.result.correction,{field:'displayName',before:'本人选择的业务名',after:correction.displayName});
 assert.equal((await db.query('SELECT display_name FROM official_account_profiles_v1 WHERE account_id=$1',[accountId])).rows[0].display_name,correction.displayName);
 assert.equal((await service.command(reader,target,correction,auth)).replayed,true);assert.equal((await service.operation(reader,correction.operationId)).result.effects.profile.revision,1);
 const trail=await service.history(reader,target);assert.equal(trail.items[0].reason,correction.reason);assert.equal(trail.items[0].basis,correction.basis);assert.equal(trail.items[0].operatorDisplayName,'本地目录管理者');
 await assert.rejects(service.command(reader,target,{...correction,operationId:randomUUID()},auth),{code:'registered_user_changed'});
 const sessionStore=new OfficialAccountSessionStore({db,scope:portal.configurationHash,now});
 await sessionStore.createLogin({loginHash:'c'.repeat(64),preview:{authorizationUrl:issuer+'/protocol/openid-connect/auth?state=local-registration-session',expiresAt:clock+300},returnTo:'https://website.example/app/account'});
 await sessionStore.claimLogin('c'.repeat(64),'local-registration-session');
 await sessionStore.completeLogin('c'.repeat(64),{tokenHash:'a'.repeat(64)},async()=>({accountId,issuer,externalSubject:users[0].id,account:{email:users[0].email,emailVerified:true},csrfToken:'b'.repeat(43),expiresAt:clock+3600}));
 let detail=await service.detail(reader,target);
 const disabled=await service.command(reader,target,{operationId:randomUUID(),kind:'login-disable',expectedVersion:detail.targetVersion,reason:'明确停用当前登录'},auth);
 assert.equal(disabled.state,'completed');assert.equal(users[0].enabled,false);assert.equal(disabled.result.effects.websiteSessions.revokedSessions,1);assert.equal(disabled.result.effects.ssoSessions.state,'confirmed');
 assert.equal((await db.query('SELECT restricted_until FROM community_accounts WHERE id=$1',[accountId])).rows[0].restricted_until.toISOString(),'2030-02-01T00:00:00.000Z');
 detail=await service.detail(reader,target);const restored=await service.command(reader,target,{operationId:randomUUID(),kind:'login-restore',expectedVersion:detail.targetVersion,reason:'明确恢复当前登录'},auth);
 assert.equal(restored.state,'completed');assert.equal(users[0].enabled,true);assert.equal((await portal.sessionSummary({issuer,externalSubject:users[0].id})).activeCount,0,'restoring login never restores revoked website sessions');
 state.mode='lost-reset';detail=await service.detail(reader,target);const reset={operationId:randomUUID(),kind:'password-reset',expectedVersion:detail.targetVersion,reason:'本人请求重新设置密码'};
 const unknown=await service.command(reader,target,reset,auth);assert.equal(unknown.state,'unknown');assert.equal(unknown.result.passwordChanged,false);const writes=state.writes.length;
 assert.equal((await service.operation(reader,reset.operationId)).state,'unknown');assert.equal((await service.command(reader,target,reset,auth)).state,'unknown');assert.equal(state.writes.length,writes,'original receipt and replay never resend a lost action-email ACK');
 await assert.rejects(service.command(reader,target,{...reset,reason:'不同原意图'},auth),{code:'registered_operation_conflict'});
 await assert.rejects(service.operation(basic,reset.operationId),{code:'registered_operation_not_found'});
 const history=await service.history(reader,target);assert(!JSON.stringify(history).includes(privateValue));
 state.mode='normal';const alternate=(await service.list(reader,{query:'registered-1@example.invalid'})).items[0];
 const editRole=async codes=>{role=(await permissions.saveRole(admin,{operationId:randomUUID(),id:role.id,expectedVersion:role.version,name:role.name,description:'Local registration management fixture',enabled:true,permissions:codes},{authorize:async()=>admin})).role;};
 state.beforeGet=async()=>{state.beforeGet=null;await editRole(role.permissions.filter(code=>code!=='accounts.identity.read'));};
 const maskedAfterAwait=await service.detail(reader,alternate.registrationId);assert.equal(maskedAfterAwait.identity,undefined);assert.equal(maskedAfterAwait.item.identity.email,null);assert.equal(maskedAfterAwait.item.identity.readState,'not-authorized');assert.equal(maskedAfterAwait.security.sessions.sso.activeCount,null);
 await editRole([...registeredUsersPermissionCodes,'accounts.identity.read']);
 const nextDetail=await service.detail(reader,alternate.registrationId);let gets=0;
 state.beforeGet=async()=>{if(++gets===2){state.beforeGet=null;await editRole(role.permissions.filter(code=>code!=='accounts.login.disable'));}};
 const beforeRevoked=state.writes.length;
 const refused=await service.command(reader,alternate.registrationId,{operationId:randomUUID(),kind:'login-disable',expectedVersion:nextDetail.targetVersion,reason:'验证读取期间撤权会阻止副作用'},auth);
 assert.equal(refused.state,'failed');assert.equal(refused.result.effects.identity.code,'operations_permission_denied');assert.equal(state.writes.length,beforeRevoked,'revocation during current native read prevents the following native write');state.beforeGet=null;
 const audit=(await db.query("SELECT * FROM business_admin_audit_v1 WHERE action LIKE 'registered-user-%'")).rows;
 assert(!JSON.stringify(audit).includes(users[0].email));assert(!JSON.stringify(audit).includes(correction.reason));assert(!JSON.stringify(audit).includes(correction.displayName));
 const savedAudit=audit.find(row=>row.action==='registered-user-profile-correct'),publicAudit=businessAuditMetadata({...savedAudit,selection:{...savedAudit.selection,email:privateValue},result:{...savedAudit.result,reason:privateValue}});
 assert.equal(publicAudit.selection.kind,'profile-correct');assert.equal(publicAudit.result.state,'completed');assert(!JSON.stringify(publicAudit).includes(privateValue));
 assert.equal((await service.operation(reader,randomUUID())).state,'not-recorded');
 await assert.rejects(async()=>service.list(reader,{sql:'SELECT secret'}),{code:'invalid_registered_users_request'});
 await assert.rejects(service.command(reader,target,{...reset,operationId:randomUUID(),url:'https://arbitrary.invalid'},auth),{code:'invalid_registered_users_request'});
 const noBusinessAfter=Number((await db.query('SELECT count(*) AS n FROM community_accounts')).rows[0].n);assert.equal(noBusinessAfter,accountCountBefore);
 await db.exec('RESET ROLE');
});

test('website management transport projects only metadata, uses separate clients and never retries a lost native write ACK',async()=>{
 const issuer='https://website-auth.example/realms/galaxy',user={id:randomUUID(),email:'local@example.invalid',enabled:true,emailVerified:true,createdTimestamp:0,requiredActions:[],firstName:'Native'};
 const f=nativeFixture([user],issuer),principal={issuer,externalSubject:user.id};let gates=0;
 const read=await f.directory.get(principal);assert.equal(read.registeredAt,'1970-01-01T00:00:00.000Z');assert(!JSON.stringify(read).includes(f.privateValue));
 assert.deepEqual(await f.directory.registrationEvidence(principal),{hasCredentials:true,hasFederatedIdentities:false});assert.equal((await f.directory.sessionSummary(principal)).activeCount,1);
 assert.equal((await f.directory.management(principal)).state,'available');
 assert.deepEqual(await f.directory.resetLink(principal,{authorize:async()=>{gates++;}}),{state:'submitted',code:null});assert.equal(gates,1);
 assert.deepEqual(JSON.parse(f.state.writes[0].body),['UPDATE_PASSWORD']);assert(f.state.tokens.includes('website-reader'));assert(f.state.tokens.includes('website-manager'));
 f.state.mode='lost-reset';const before=f.state.writes.length;assert.equal((await f.directory.resetLink(principal,{authorize:async()=>{gates++;}})).state,'unknown');assert.equal(f.state.writes.length,before+1);
 const frozen=f.state.writes.length;await assert.rejects(f.directory.setEnabled(principal,false,{authorize:async()=>{throw Object.assign(Error('current grant revoked'),{code:'operations_permission_denied'});}}),{code:'operations_permission_denied'});assert.equal(f.state.writes.length,frozen);
 await assert.rejects(f.directory.setEnabled({issuer:'https://foreign.invalid',externalSubject:user.id},false,{authorize:async()=>{}}),{code:'registered_identity_target_invalid'});
 await assert.rejects(f.directory.resetLink(principal,{}),{code:'operations_authorization_unavailable'});
 const readonly=createKeycloakWebsiteDirectory({issuer,reader:{clientId:'website-reader',clientSecret:'local-read-fixture'},fetch:f.transport});
 assert.equal((await readonly.management(principal)).state,'not-configured');await assert.rejects(readonly.resetLink(principal,{authorize:async()=>{}}),{code:'registered_identity_management_not_configured'});
});

test('registered website session revocation fences a delayed verified callback atomically while allowing a genuinely later login',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
 const selected=migrations.filter(row=>row.version<=119||row.version===121);assert(selected.some(row=>row.version===121));
 for(const row of selected){await db.exec(row.sql);await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[row.version]);}
 const apiSql=await readFile(process.env.GALAXY_REGISTERED_USERS_API_ROLE_FILE??new URL('../src/infrastructure/api-role.sql',import.meta.url),'utf8');assert(!/\bai_domains\b/.test(apiSql));await db.exec(apiSql);await db.exec('SET ROLE galaxy_api');
 const endpoint='https://registered-fence.example',issuer='https://website-auth.example/realms/galaxy',principal={issuer,externalSubject:'native-delayed-subject'},now=()=>Math.floor(Date.now()/1000);
 const provider={describe:()=>({issuer,clientId:'website-fence',redirectUri:endpoint+'/v1/account/callback'})},portal=createOfficialAccountPortal({db,endpoint,websiteOrigin:'https://website.example',provider,associationProviders:[provider],now});
 const store=new OfficialAccountSessionStore({db,scope:portal.configurationHash,now});
 const begin=async(key)=>{const loginHash=key.repeat(64);await store.createLogin({loginHash,preview:{authorizationUrl:issuer+'/protocol/openid-connect/auth?state=state-'+key,expiresAt:now()+300},returnTo:'https://website.example/app/account'});await store.claimLogin(loginHash,'state-'+key);return loginHash;};
 let createdInsideTransaction=false;
 const createVerified=async connection=>{
  createdInsideTransaction=true;const row=await upsertOfficialAccountWithin(connection,{endpoint,...principal,verificationMethod:'email',verifiedAt:now()});
  await ensureOfficialAccountProfileWithin(connection,row.id,{subjectType:row.created?'person':null,now:now()});
  return {accountId:row.id,...principal,account:{email:'local-fence@example.invalid',emailVerified:true},csrfToken:'k'.repeat(43),expiresAt:now()+3600};
 };
 const oldLogin=await begin('a');assert.deepEqual(await portal.revokeSessions({accountId:null,...principal}),{revokedSessions:0,inflightBlocked:true});
 await assert.rejects(store.completeLogin(oldLogin,{tokenHash:'b'.repeat(64)},createVerified),/revoked before issuance/);assert.equal(createdInsideTransaction,true);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM community_accounts')).rows[0].n),0,'the already executed callback account upsert rolls back with the fence rejection');
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM official_account_profiles_v1')).rows[0].n),0,'the callback-created profile rolls back too');
 assert.equal((await portal.sessionSummary(principal)).activeCount,0);await store.failLogin(oldLogin);
 await new Promise(resolve=>setTimeout(resolve,5));const newLogin=await begin('c'),fresh=await store.completeLogin(newLogin,{tokenHash:'d'.repeat(64)},createVerified);
 assert.equal((await portal.sessionSummary(principal)).activeCount,1);assert.equal((await store.session('d'.repeat(64))).accountId,fresh.accountId);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM community_accounts')).rows[0].n),1);
 const before=(await db.query('SELECT revoked_before FROM operations_registered_login_fences_v1 WHERE scope_hash=$1',[portal.configurationHash])).rows[0].revoked_before;
 assert(before,'the current portal stores a real principal-specific fence');
 await assert.rejects(portal.revokeSessions({accountId:fresh.accountId,issuer,externalSubject:'a-different-principal'}),{code:'invalid_account'});
 assert.equal((await portal.sessionSummary(principal)).activeCount,1,'a mismatched account/principal cannot revoke another target');
 await db.exec('RESET ROLE');
});
