import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate, transaction} from "../src/infrastructure/database.mjs";
import {migrations} from '../src/infrastructure/migrations.mjs';
import {createOperationsPortal} from "../src/operations/permissions/auth.mjs";
import {createOperationsManagementSessions} from "../src/operations/accounts/management-sessions.mjs";
import {createStoredOperatorAuthorization} from "../src/operations/configuration.mjs";
import {OperationsPermissionsAuthority} from '../src/operations/permissions/authority.mjs';
import {createKeycloakAdminDirectory} from "../src/identity/authentication/keycloak-admin-directory.mjs";
import {operationsPermissionCodes} from '../src/operations-permission-catalog.mjs';
import {acceptCookies, request, response, deferred, endpoint, adminOrigin, operatorRoles} from './operations-management-fixture.mjs';

const issuer='https://management-auth.example.invalid/realms/operations';
const hash=value=>createHash('sha256').update(value).digest('hex');
const opaque=()=>randomBytes(32).toString('base64url');
const principal=sub=>({issuer,externalSubject:sub,operatorId:hash(issuer+'\0'+sub)});
const root=Object.freeze({version:1,endpoint,...principal('fixed-root')});
const hasCode=code=>error=>error?.code===code;
const originated=jar=>request(jar,{origin:adminOrigin});

// One new lifecycle group. The PostgreSQL schema, portal, role SQL, authority,
// lifecycle adapter and cache adapter are actual implementations. Only the
// external identity provider/directory transport is a double. PGlite serializes
// transactions: the two orderings below are not multi-connection lock evidence.
test('fixed-root authentication, lifecycle fences and invalidated role reads stay closed across callback/revocation orderings',
 {timeout:90000},async t=>{
  // Current security regression: follow this source composition's complete
  // migration contract. Historical 122 compatibility needs a frozen fixture.
  assert.equal(migrations.some(x=>x.version===120),false,'held120 remains excluded');
  const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api','worker']});
  assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(x=>Number(x.version)),
   migrations.map(x=>x.version),'the complete current migration set was actually applied');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name='ai_domains'")).rows[0].n,0);
  const now=()=>Math.floor(Date.now()/1000),at=()=>new Date(now()*1000).toISOString();
  const publicAccount=randomUUID(),publicScope=hash('public-scope'),publicToken=hash('public-token');
  await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
   VALUES($1,$2,'https://website.example.invalid/realms/galaxy','revocation-order','email',$3,$3)`,[publicAccount,endpoint,at()]);
  await db.query(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email_verified,csrf_token,created_at,expires_at)
   VALUES($1,$2,$3,$4,'https://website.example.invalid/realms/galaxy','revocation-order',true,$5,$6,$7)`,
  [publicScope,publicToken,hash('public-login'),publicAccount,opaque(),now(),now()+300]);
  const roles=new Map(),previews=new Map();let nextSubject='fixed-root',completeGate=null;
  const directory={
   async getOperatorRoles(value){return [...(roles.get(value.externalSubject)??[])];},
   invalidateOperatorRoles(value){return value.issuer===issuer;},
  };
  roles.set('fixed-root',[operatorRoles.administrator]);roles.set('other-native-admin',[operatorRoles.administrator]);
  const provider={
   describe(){return {issuer,clientId:'lifecycle-fixture',redirectUri:adminOrigin+'/v1/operations/callback'};},
   async begin(){const state=randomUUID();previews.set(state,nextSubject);return {authorizationUrl:issuer+'/auth?state='+state,expiresAt:now()+300};},
   async complete(preview){const state=new URL(preview.authorizationUrl).searchParams.get('state'),sub=previews.get(state);
    if(completeGate){const gate=completeGate;completeGate=null;gate.entered.resolve();await gate.release.promise;}
    return {issuer,clientId:'lifecycle-fixture',externalSubject:sub,expiresAt:now()+300,
     operatorRoles:[...(roles.get(sub)??[])],accountProfile:{displayName:'Synthetic '+sub,email:sub+'@example.invalid'}};},
   async cancel(){},
  };
  const sessions=createOperationsManagementSessions({db,endpoint,issuer,roleDirectory:directory,now});
  const stored=createStoredOperatorAuthorization({db,endpoint,issuer,roles:operatorRoles,roleDirectory:directory,rootPrincipal:root,managementSessions:sessions});
  const permissions=new OperationsPermissionsAuthority({db,endpoint,operatorAuthorization:stored,now});
  const portal=createOperationsPortal({db,endpoint,adminOrigin,provider,roleDirectory:directory,roles:operatorRoles,
   permissions,rootPrincipal:root,managementSessions:sessions,now});
  const noRoot=createOperationsPortal({db,endpoint,adminOrigin,provider,roleDirectory:directory,roles:operatorRoles,managementSessions:sessions,now});
  const begin=async(instance,sub)=>{nextSubject=sub;const jar=new Map(),out=response();
   await instance.login(request(jar),out,new URL(adminOrigin+'/v1/operations/login?returnTo=%2Fadmin%2Foperations'));
   acceptCookies(jar,out);const state=new URL(out.headers.get('location')).searchParams.get('state');
   return {jar,state,tokenHash:hash(jar.get('__Host-galaxy-operator-login').split('=')[1]),instance};};
  const finish=async(login)=>{const out=response();await login.instance.callback(request(login.jar),out,
   new URL(adminOrigin+'/v1/operations/callback?state='+login.state+'&code=fixture-only'));acceptCookies(login.jar,out);return out;};
  const login=async(instance,sub)=>{const pending=await begin(instance,sub);const out=await finish(pending);
   assert.equal(out.headers.get('location'),adminOrigin+'/admin/operations');return pending;};
  const addLocal=async sub=>{
   const p=principal(sub);await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(operator_id) DO NOTHING`,[p.operatorId,endpoint,issuer,sub,'Synthetic '+sub,at()]);
   await db.query(`INSERT INTO operations_management_accounts_v1(operator_id,endpoint,issuer,external_subject,version,created_by,created_at,updated_at)
    VALUES($1,$2,$3,$4,1,$1,$5,$5) ON CONFLICT(operator_id) DO NOTHING`,[p.operatorId,endpoint,issuer,sub,at()]);return p;
  };
  await db.exec('SET ROLE galaxy_api');
  const rootLogin=await login(portal,'fixed-root'),rootSession=await portal.session(originated(rootLogin.jar));
  assert.equal(rootSession.operator.role,'administrator');assert.equal(rootSession.operator.rootAdministrator,true);
  assert.equal(rootSession.operator.admission,'administrator');
  const rootEffective=await permissions.effective({kind:'business-operator',endpoint,operatorId:root.operatorId,role:'reader'});
  assert.equal(rootEffective.source,'preconfigured-root');assert.deepEqual(new Set(rootEffective.permissions),new Set(operationsPermissionCodes));
  const otherLogin=await login(portal,'other-native-admin'),otherSession=await portal.session(originated(otherLogin.jar));
  assert.equal(otherSession.operator.admission,'administrator');assert.equal(otherSession.operator.role,'reader');
  assert.equal(otherSession.operator.rootAdministrator,false);assert.deepEqual(otherSession.operator.businessAuthorization.permissions,[]);
  const roleId=randomUUID(),assignmentId=randomUUID(),memberId=principal('other-native-admin').operatorId;
  await db.query(`INSERT INTO operations_business_roles_v1(id,endpoint,name,enabled,version,permissions,created_by,updated_by,created_at,updated_at)
   VALUES($1,$2,'Synthetic bounded role',true,1,$3,$4,$4,$5,$5)`,[roleId,endpoint,['analytics.read','ai.use.overview'],root.operatorId,at()]);
  await db.query(`INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at)
   VALUES($1,$2,$3,$4,true,1,$5,$5,$6,$6)`,[assignmentId,endpoint,memberId,roleId,root.operatorId,at()]);
  const memberEffective=await permissions.effective({kind:'business-operator',endpoint,operatorId:memberId,role:'administrator'});
  assert.equal(memberEffective.source,'business-roles');assert.equal(memberEffective.role,'reader');
  assert.deepEqual(memberEffective.permissions,['ai.use.overview','analytics.read']);
  await assert.rejects(permissions.requireAction({kind:'business-operator',endpoint,operatorId:memberId,role:'administrator'},'management.accounts.delete'),hasCode('operations_permission_denied'));
  const noRootLogin=await login(noRoot,'fixed-root');assert.equal((await noRoot.session(originated(noRootLogin.jar))).operator.role,'reader');
  const noRootStored=createStoredOperatorAuthorization({db,endpoint,issuer,roles:operatorRoles,roleDirectory:directory,managementSessions:sessions});
  assert.equal(await noRootStored({kind:'business-operator',endpoint,operatorId:root.operatorId,role:'administrator'}),'reader');
  assert.equal(await stored({kind:'business-operator',endpoint,operatorId:principal('other-native-admin').operatorId,role:'administrator'}),'reader');
  roles.set('fixed-root',[]);assert.equal((await portal.session(originated(rootLogin.jar))).state,'signed-out');
  await assert.rejects(stored({kind:'business-operator',endpoint,operatorId:root.operatorId,role:'administrator'}),hasCode('business_admin_denied'));
  roles.set('fixed-root',[operatorRoles.administrator]);
  t.diagnostic('fixed root, ordinary native administrator and missing-root authority exercised through actual portal/stored authority');

  for(const [sub,field] of [['locally-disabled','login_blocked'],['locally-deleted','deleted_at']]){
   roles.set(sub,[operatorRoles.administrator]);const identity=await addLocal(sub),live=await login(portal,sub),pending=await begin(portal,sub);
   await db.query(`UPDATE operations_management_accounts_v1 SET ${field}=${field==='login_blocked'?'true':'clock_timestamp()'} WHERE operator_id=$1`,[identity.operatorId]);
   assert.equal((await portal.session(originated(live.jar))).state,'signed-out');
   assert.match((await finish(pending)).headers.get('location'),/reason=denied/);
   await assert.rejects(stored({kind:'business-operator',endpoint,operatorId:identity.operatorId,role:'administrator'}),hasCode('operations_access_denied'));
  }
  t.diagnostic('local disabled/deleted principals denied by actual current, callback and stored authorization, even with stale native administrator');

  const sub='revocation-order',identity=await addLocal(sub);roles.set(sub,[operatorRoles.reader]);
  const live=await login(portal,sub),pending=await begin(portal,sub),gate={entered:deferred(),release:deferred()};completeGate=gate;
  const completing=finish(pending);await gate.entered.promise;
  const revoked=await sessions.revoke(identity);assert.equal(revoked.inflightBlocked,true);assert.equal(revoked.revokedSessions,1);
  gate.release.resolve();assert.match((await completing).headers.get('location'),/reason=denied/);
  assert.equal((await portal.session(originated(live.jar))).state,'signed-out');
  const newer=await login(portal,sub);assert.equal((await portal.session(originated(newer.jar))).state,'signed-in','a later deliberate login is admitted');
  const reverse=await sessions.revoke(identity);assert.equal(reverse.revokedSessions,1);
  assert.equal((await portal.session(originated(newer.jar))).state,'signed-out','callback committed before revoke is removed');

  // Keep sub-millisecond data in PostgreSQL throughout. JS Date would collapse
  // these timestamps; the adapter must compare the two timestamptz columns.
  const precision=await begin(portal,sub),fence='2026-10-24T09:00:00.123456Z';
  await db.query("UPDATE operations_operator_logins_v1 SET status='exchanging',started_at=$4 WHERE endpoint=$1 AND configuration_id=$2 AND token_hash=$3",
   [endpoint,portal.configurationId,precision.tokenHash,'2026-10-24T09:00:00.123455Z']);
  await db.query(`INSERT INTO operations_management_login_fences_v1(endpoint,issuer,external_subject,revoked_before) VALUES($1,$2,$3,$4)
   ON CONFLICT(endpoint,issuer,external_subject) DO UPDATE SET revoked_before=EXCLUDED.revoked_before`,[endpoint,issuer,sub,fence]);
  const assertPrecision=()=>transaction(db,tx=>sessions.assertCallback(identity,{db:tx,configurationId:portal.configurationId,tokenHash:precision.tokenHash}));
  await assert.rejects(assertPrecision(),hasCode('operations_access_denied'));
  await db.query('UPDATE operations_operator_logins_v1 SET started_at=$2 WHERE token_hash=$1',[precision.tokenHash,fence]);
  await assert.rejects(assertPrecision(),hasCode('operations_access_denied'));
  await db.query('UPDATE operations_operator_logins_v1 SET started_at=$2 WHERE token_hash=$1',[precision.tokenHash,'2026-10-24T09:00:00.123457Z']);
  await assertPrecision();
  t.diagnostic('both callback/revoke serializations and DB microsecond before/equal/after fence observed; not multi-connection contention');

  // A portal revocation covers all configurations of this endpoint/identity;
  // another endpoint, issuer, subject and public-account sessions stay separate.
  const insertSession=async(label,{scopeEndpoint=endpoint,scopeIssuer=issuer,subject=sub,config=portal.configurationId}={})=>{
   const operatorId=hash(scopeIssuer+'\0'+subject),tokenHash=hash(label);await db.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'Synthetic','reader',$7,$8)`,[scopeEndpoint,config,tokenHash,operatorId,scopeIssuer,subject,opaque(),new Date((now()+300)*1000).toISOString()]);return tokenHash;
  };
  const gone=[await insertSession('same-configuration'),await insertSession('other-configuration',{config:hash('other-configuration')})];
  const kept=[await insertSession('other-endpoint',{scopeEndpoint:'https://other.example.invalid'}),await insertSession('other-issuer',{scopeIssuer:'https://other.example.invalid/realms/operations'}),await insertSession('other-subject',{subject:'another-subject'})];
  const publicBefore=(await db.query('SELECT count(*)::int AS n FROM official_account_sessions_v1')).rows[0].n;
  assert.equal(publicBefore,1,'a real local public-account session is present for the separation assertion');
  assert.equal((await sessions.summary(identity)).activeCount,2);
  assert.equal((await sessions.revoke(identity)).revokedSessions,2);
  const remains=(await db.query('SELECT token_hash FROM operations_operator_sessions_v1 WHERE token_hash=ANY($1::text[])',[gone.concat(kept)])).rows.map(x=>x.token_hash);
  assert.deepEqual(new Set(remains),new Set(kept));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM official_account_sessions_v1')).rows[0].n,publicBefore);
  assert.equal((await sessions.summary(identity)).activeCount,0);
  await assert.rejects(sessions.revoke({...identity,operatorId:root.operatorId}),hasCode('operations_access_denied'));
  t.diagnostic('management revocation scope and identity hash binding exercised under actual galaxy_api SQL rights');

  await db.exec('SET ROLE galaxy_evidence_worker');
  assert.equal(await stored({kind:'business-operator',endpoint,operatorId:principal('other-native-admin').operatorId,role:'administrator'}),'reader');
  await db.exec('RESET ROLE');

  let fetchGate=null,nativeEnabled=true,nativeRoles=[operatorRoles.administrator],fetches=0;
  const transport=async(input,options)=>{
   const url=new URL(input);if(url.pathname.endsWith('/token'))return Response.json({access_token:'fixture-only-not-live',expires_in:300});
   assert.equal(options.method??'GET','GET');fetches++;
   if(url.pathname.endsWith('/role-mappings/realm/composite')){
    const captured=[...nativeRoles];if(fetchGate){const wait=fetchGate;fetchGate=null;wait.entered.resolve();await wait.release.promise;}
    return Response.json(captured.map(name=>({name})));
   }
   return Response.json({id:'cache-target',enabled:nativeEnabled});
  };
  const nativeDirectory=createKeycloakAdminDirectory({issuer,clientId:'fixture-reader',clientSecret:'fixture-only-not-live',fetch:transport,now});
  const cachePrincipal={issuer,externalSubject:'cache-target'};
  assert.deepEqual(await nativeDirectory.getOperatorRoles(cachePrincipal),[operatorRoles.administrator]);
  const before=fetches;assert.deepEqual(await nativeDirectory.getOperatorRoles(cachePrincipal),[operatorRoles.administrator]);assert.equal(fetches,before);
  nativeDirectory.invalidateOperatorRoles(cachePrincipal);
  const wait={entered:deferred(),release:deferred()};fetchGate=wait;const inFlight=nativeDirectory.getOperatorRoles(cachePrincipal);
  await wait.entered.promise;nativeEnabled=false;nativeRoles=[];assert.equal(nativeDirectory.invalidateOperatorRoles(cachePrincipal),true);
  wait.release.resolve();await assert.rejects(inFlight,hasCode('operations_directory_unavailable'));
  assert.deepEqual(await nativeDirectory.getOperatorRoles(cachePrincipal),[],'old in-flight roles cannot repopulate the invalidated cache');
  assert.equal(nativeDirectory.invalidateOperatorRoles({...cachePrincipal,issuer:'https://foreign.example.invalid'}),false);
  t.diagnostic('actual directory adapter rejected a captured pre-invalidation role response and fetched current disabled state');
 });
