import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {createOidcLoginProvider} from "../src/identity/authentication/oidc-login.mjs";
import {createOidcTransactionStore} from "../src/identity/authentication/oidc-transaction-store.mjs";
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';

test('shared private OIDC transactions work with fresh providers and consume exactly once, with namespace/state/expiry isolation', {timeout:60000},async t=>{
  const db=new PGlite();t.after(()=>db.close());await migrate(db);
  const redirectUri='https://operations.example.org/v1/operations/callback';
  const issuer=await oidcProviderFixture([redirectUri]);t.after(issuer.close);
  let clock=Math.floor(Date.now()/1000);const now=()=>clock;
  const provider=namespace=>createOidcLoginProvider({id:'operations',name:'Synthetic operations',issuer:issuer.issuer,
    clientId:'galaxy-fixture',redirectUri,now,allowLoopbackHttp:true,
    transactionStore:createOidcTransactionStore({db,namespace,now})});
  const a=await provider('operations:fixture'),b=await provider('operations:fixture'),foreign=await provider('operations:different');
  const original=await a.begin(),preview=JSON.parse(JSON.stringify(original)),returned=await issuer.authorize(preview.authorizationUrl);
  assert.equal(JSON.stringify(preview).includes('verifier'),false);
  const wrongState=new URL(returned);wrongState.searchParams.set('state','wrong-state');
  await assert.rejects(b.complete(preview,wrongState),/does not match/);
  const wrongPath=new URL(returned);wrongPath.pathname='/other';
  await assert.rejects(b.complete(preview,wrongPath),/does not match/);
  await assert.rejects(foreign.complete(preview,returned),/consumed/);
  const before=issuer.requests.filter(value=>value.path==='/token').length;
  const completed=await Promise.allSettled([a.complete(preview,returned),b.complete(preview,returned)]);
  assert.equal(completed.filter(value=>value.status==='fulfilled').length,1);
  assert.equal(completed.filter(value=>value.status==='rejected').length,1);
  assert.equal(issuer.requests.filter(value=>value.path==='/token').length-before,1);
  const canceled=await a.begin();await b.cancel(JSON.parse(JSON.stringify(canceled)));
  await assert.rejects(a.complete(canceled,await issuer.authorize(canceled.authorizationUrl)),/consumed/);
  const expired=await a.begin();clock+=301;
  await assert.rejects(b.complete(JSON.parse(JSON.stringify(expired)),await issuer.authorize(expired.authorizationUrl)),/expired/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM oidc_login_transactions_v1')).rows[0].n,0);
  assert.deepEqual(issuer.failures,[]);
});

test('operator roles are opt-in signed ID Token claims, limited to realm and the exact relying client', {timeout:60000},async t=>{
  const redirectUri='https://operations.example.org/v1/operations/callback';
  const roleClaims={realm_access:{roles:['operator','reader']},resource_access:{'galaxy-fixture':{roles:['reader','maintainer']},'another-client':{roles:['foreign-administrator']}}};
  const issuer=await oidcProviderFixture([redirectUri],{roleClaims});t.after(issuer.close);
  const options={id:'operations',name:'Synthetic operations',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri,allowLoopbackHttp:true};
  const ordinary=await createOidcLoginProvider(options),operator=await createOidcLoginProvider({...options,includeOperatorRoles:true});
  const run=async provider=>{const preview=await provider.begin();return provider.complete(preview,await issuer.authorize(preview.authorizationUrl));};
  assert.equal(Object.hasOwn(await run(ordinary),'operatorRoles'),false,'normal login output is unchanged');
  const selected=await run(operator);
  assert.deepEqual(selected.operatorRoles,['operator','reader','maintainer']);
  assert.equal(selected.galaxyAuthorization,false,'signed role metadata is not a Galaxy subject credential');
  roleClaims.realm_access={roles:'administrator'};
  await assert.rejects(run(operator),/verification failed/,'a malformed signed role claim cannot gain authority');
  roleClaims.realm_access={roles:Array.from({length:129},()=> 'operator')};
  await assert.rejects(run(operator),/verification failed/);
  roleClaims.realm_access={roles:[]};roleClaims.resource_access={};
  assert.deepEqual((await run(operator)).operatorRoles,[]);
  assert.deepEqual(issuer.failures,[]);
});
