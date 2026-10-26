import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,transaction} from '../src/database.mjs';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {OperationsManagementAccountsService} from '../src/operations/accounts/management-service.mjs';
import {createKeycloakManagementAccounts} from '../src/keycloak-management-accounts.mjs';
import {createOperationsManagementSessions} from '../src/operations-management-sessions.mjs';
import {managementId} from '../src/operations/accounts/management-schema.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const endpoint='https://management-api.example.invalid',otherEndpoint='https://another-management-api.example.invalid';
const issuer='https://management-auth.example.invalid/realms/operations';
const origin='http://127.0.0.1:18081';
const syntheticSecret='SYNTHETIC_MANAGEMENT_SECRET_NOT_A_REAL_CREDENTIAL';

// One new service leaf only. PostgreSQL/PGlite, migrations, API SQL role,
// current PG authorization, native-client projection and portal session/fence
// adapter are real. Native HTTP/token and verification-email delivery are
// explicit doubles. This does not contact a realm/SMTP/provider or prove
// multi-connection contention or a human OIDC browser workflow.
test('submitted verification preserves old email and original receipt; native session uncertainty never skips independent portal revocation',
 {timeout:90000},async t=>{
  assert.equal(migrations.at(-1).version,122);
  assert(!migrations.some(row=>row.version===120),'Use the isolated released119/121 plus management122 composition, never held120');
  const db=new PGlite();t.after(()=>db.close());
  await migrate(db,{roles:['api']});
  const now=()=>Math.floor(Date.now()/1000),at=()=>new Date(now()*1000).toISOString();
  const people=[
   {id:randomUUID(),username:'fixed-root',firstName:'Synthetic Root',lastName:'',email:'root@example.invalid',emailVerified:true,enabled:true,createdTimestamp:Date.now(),requiredActions:[]},
   {id:randomUUID(),username:'bounded-member',firstName:'Synthetic Member',lastName:'',email:'member.old@example.invalid',emailVerified:false,enabled:true,createdTimestamp:Date.now(),requiredActions:[]},
  ];
  const nativeUsers=new Map(people.map(row=>[row.id,row]));
  const nativeRoles=new Map([[people[0].id,['galaxy-operations-administrator']],[people[1].id,['galaxy-operations-reader']]]);
  const logoutStatuses=new Map([[people[1].id,503],[people[0].id,403]]),logoutCalls=[],emailCalls=[];
  const transport=async(url,options={})=>{
   const target=new URL(url),method=options.method??'GET';
   if(target.href===issuer+'/protocol/openid-connect/token'){
    assert.equal(method,'POST');
    return Response.json({access_token:new URLSearchParams(options.body).get('client_id'),expires_in:60});
   }
   assert.equal(target.origin,origin);
   const sub=decodeURIComponent(target.pathname.split('/users/')[1]?.split('/')[0]??''),user=nativeUsers.get(sub);
   if(method==='GET'){
    assert.equal(options.headers.authorization,'Bearer synthetic-reader');
    if(target.pathname.endsWith('/users/count'))return Response.json(nativeUsers.size);
    if(target.pathname.endsWith('/users'))return Response.json([...nativeUsers.values()].slice(Number(target.searchParams.get('first')),Number(target.searchParams.get('first'))+Number(target.searchParams.get('max'))));
    if(!user)return Response.json({error:'synthetic-not-found'},{status:404});
    if(target.pathname.endsWith('/role-mappings/realm/composite'))return Response.json((nativeRoles.get(sub)??[]).map(name=>({id:hash(name),name,clientRole:false})));
    if(target.pathname.endsWith('/sessions'))return Response.json([]);
    return Response.json(user);
   }
   assert.equal(method,'POST');assert(target.pathname.endsWith('/logout'));
   assert.equal(options.headers.authorization,'Bearer synthetic-writer');
   logoutCalls.push({sub,status:logoutStatuses.get(sub)});
   return Response.json({error:'synthetic-native-rejection'},{status:logoutStatuses.get(sub)});
  };
  const emailChanges={
   available:async()=>true,
   async request(principal,newEmail,{operationId,authorize}){
    await authorize();emailCalls.push({principal,newEmail,operationId});
    // Accepted email verification is not a verified email change or delivery.
    return {state:'submitted',code:null};
   },
  };
  const directory=createKeycloakManagementAccounts({issuer,adminOrigin:origin,
   reader:{clientId:'synthetic-reader',clientSecret:syntheticSecret},
   writer:{clientId:'synthetic-writer',clientSecret:syntheticSecret},emailChanges,fetch:transport,now});
  const principal=person=>({operatorId:managementId(issuer,person.id),issuer,externalSubject:person.id});
  const rootPrincipal={version:1,endpoint,...principal(people[0])};
  const actor={kind:'business-operator',operatorId:rootPrincipal.operatorId,endpoint,role:'reader'};
  for(const person of people){
   const p=principal(person);
   await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$6)`,[p.operatorId,endpoint,issuer,p.externalSubject,person.firstName,at()]);
   await db.query(`INSERT INTO operations_management_accounts_v1(operator_id,endpoint,issuer,external_subject,version,created_by,created_at,updated_at)
    VALUES($1,$2,$3,$4,1,$5,$6,$6)`,[p.operatorId,endpoint,issuer,p.externalSubject,actor.operatorId,at()]);
  }
  const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async(candidate,{db:connection})=>{
   const row=(await connection.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,candidate.operatorId])).rows[0];
   const person=nativeUsers.get(row?.external_subject),roles=nativeRoles.get(row?.external_subject)??[];
   if(row?.issuer!==issuer||!person?.enabled||!roles.length)return null;
   return candidate.operatorId===rootPrincipal.operatorId&&roles.includes('galaxy-operations-administrator')?'administrator':'reader';
  }});
  const roleDirectory={invalidateOperatorRoles:value=>value.issuer===issuer};
  const sessions=createOperationsManagementSessions({db,endpoint,issuer,roleDirectory,now});
  const businessAdmin=new BusinessAdminService({db,endpoint,permissions,now});
  const service=new OperationsManagementAccountsService({businessAdmin,directory,rootPrincipal,managementSessions:sessions,now});
  const authorize={authorize:async()=>actor};
  const tokens=new Map(),callbacks=new Map();
  for(const person of people){
   const p=principal(person),same=[],other=[];
   for(const [label,scopeEndpoint]of [['current',endpoint],['other-config',endpoint],['other-endpoint',otherEndpoint]]){
    const token=hash(person.id+label),configuration=hash('configuration-'+label);
    await db.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,'Synthetic','reader',$7,$8)`,[scopeEndpoint,configuration,token,p.operatorId,issuer,p.externalSubject,'A'.repeat(43),new Date((now()+600)*1000).toISOString()]);
    (scopeEndpoint===endpoint?same:other).push(token);
   }
   tokens.set(person.id,{same,other});
   const login={configurationId:hash(person.id+'pending-config'),tokenHash:hash(person.id+'pending-login')};
   await db.query(`INSERT INTO operations_operator_logins_v1(endpoint,configuration_id,token_hash,preview,return_to,status,expires_at,started_at)
    VALUES($1,$2,$3,'{}','/admin','exchanging',$4,$5)`,[endpoint,login.configurationId,login.tokenHash,new Date((now()+600)*1000).toISOString(),new Date((now()-60)*1000).toISOString()]);
   callbacks.set(person.id,login);
  }
  await db.exec('SET ROLE galaxy_api');
  assert.equal((await db.query('SELECT current_user AS name')).rows[0].name,'galaxy_api');
  assert.equal(nativeUsers.size,2,'Only two synthetic people participate');
  const member=principal(people[1]);
  const beforeEmail=(await directory.get(member)),beforeDetail=await service.detail(actor,member.operatorId);
  assert.equal(beforeDetail.capabilities.canChangeEmail,true);
  const emailIntent={operationId:randomUUID(),kind:'email-change',expectedVersion:beforeDetail.targetVersion,newEmail:'member.new@example.invalid',reason:'Synthetic verification request only'};
  const accepted=await service.command(actor,member.operatorId,emailIntent,authorize);
  assert.equal(accepted.state,'completed','The request workflow is complete after the verification bridge accepted it');
  assert.deepEqual(accepted.result.phases,[{kind:'email-verification',state:'submitted',code:null}]);
  assert.equal(emailCalls.length,1);
  const afterEmail=await directory.get(member),afterDetail=await service.detail(actor,member.operatorId);
  assert.equal(afterEmail.email,beforeEmail.email);
  assert.equal(afterEmail.emailVerified,beforeEmail.emailVerified);
  assert.equal(afterDetail.item.email,people[1].email);
  assert.equal(afterDetail.item.emailVerified,false,'No new verified email fact is invented');
  const replay=await service.command(actor,member.operatorId,emailIntent,authorize);
  assert.equal(replay.replayed,true);assert.equal(replay.operationId,emailIntent.operationId);
  assert.deepEqual(replay.result,accepted.result);assert.equal(emailCalls.length,1,'Original operation replay never sends another verification request');
  assert.equal((await service.operation(actor,emailIntent.operationId)).state,'completed');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE operation_id=$1',[emailIntent.operationId])).rows[0].n,1);
  t.diagnostic('verification bridge submitted → completed request receipt; old email/unverified state kept; same original operation called bridge once');

  for(const person of [people[1],people[0]]){
   const p=principal(person),scope=tokens.get(person.id),nativeState=logoutStatuses.get(person.id)===503?'unknown':'failed';
   await transaction(db,connection=>sessions.assertCallback(p,{db:connection,...callbacks.get(person.id)}));
   assert.equal((await sessions.summary(p)).activeCount,2);
   const detail=await service.detail(actor,p.operatorId);
   const intent={operationId:randomUUID(),kind:'sessions-revoke',expectedVersion:detail.targetVersion,reason:'Synthetic independent session teardown'};
   const receipt=await service.command(actor,p.operatorId,intent,authorize);
   assert.equal(receipt.state,nativeState==='unknown'?'unknown':'partial');
   assert.deepEqual(receipt.result.phases.map(row=>({kind:row.kind,state:row.state})),[
    {kind:'native-sessions',state:nativeState},{kind:'portal-sessions',state:'confirmed'}]);
   assert.equal(receipt.result.phases[1].revokedSessions,2);assert.equal(receipt.result.phases[1].inflightBlocked,true);
   assert.equal((await sessions.summary(p)).activeCount,0);
   const remains=(await db.query('SELECT token_hash FROM operations_operator_sessions_v1 WHERE token_hash=ANY($1::text[])',[scope.same.concat(scope.other)])).rows.map(row=>row.token_hash);
   assert.deepEqual(remains,scope.other,'Other endpoint session remains; both configurations of this portal are removed');
   const fence=(await db.query('SELECT revoked_before::text AS stamp FROM operations_management_login_fences_v1 WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3',[endpoint,issuer,p.externalSubject])).rows[0];
   assert(fence?.stamp,'The real portal adapter created a durable late-login fence');
   await assert.rejects(transaction(db,connection=>sessions.assertCallback(p,{db:connection,...callbacks.get(person.id)})),{code:'operations_access_denied'});
   const calls=logoutCalls.length,again=await service.command(actor,p.operatorId,intent,authorize);
   assert.equal(again.replayed,true);assert.equal(again.state,receipt.state);assert.equal(logoutCalls.length,calls);
   assert.deepEqual((await service.operation(actor,intent.operationId)).result,receipt.result);
   assert.equal((await db.query('SELECT revoked_before::text AS stamp FROM operations_management_login_fences_v1 WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3',[endpoint,issuer,p.externalSubject])).rows[0].stamp,fence.stamp,'Receipt replay does not repeat portal revocation or move the fence');
   if(person===people[1])assert.equal((await sessions.summary(principal(people[0]))).activeCount,2,'Another current principal is independent');
   t.diagnostic('native '+nativeState+' retained separately; real portal removed two sessions, fenced prior callback, preserved other endpoint and replayed without dispatch');
  }
  assert.equal(logoutCalls.length,2);assert.equal(emailCalls.length,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_operator_principals_v1')).rows[0].n,2);
 });

