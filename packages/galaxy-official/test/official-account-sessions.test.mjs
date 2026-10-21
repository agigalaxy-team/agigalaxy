import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {migrate} from '../src/database.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createOfficialAccountPortal} from '../src/official-account.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';

const endpoint='https://official.example.org',websiteOrigin='https://galaxy.example.org';
const callback=endpoint+'/v1/account/callback';
const sessionUrl=new URL(endpoint+'/v1/account/session');
function response(){
  const headers=new Map();
  return {headers,statusCode:200,setHeader:(key,value)=>headers.set(key.toLowerCase(),value),end(){}};
}
function request(jar,extra={},method='GET'){
  return {method,headers:{cookie:[...jar.values()].join('; '),...extra}};
}
function accept(jar,result){
  const values=result.headers.get('set-cookie')??[];
  for(const value of Array.isArray(values)?values:[values]){
    const pair=value.split(';')[0],separator=pair.indexOf('='),name=pair.slice(0,separator);
    if(pair.slice(separator+1))jar.set(name,pair);else jar.delete(name);
  }
}
async function start(portal,jar,returnTo='/app/account'){
  const result=response();await portal.login(request(jar),result,new URL(endpoint+'/v1/account/login?returnTo='+encodeURIComponent(returnTo)));
  accept(jar,result);return result.headers.get('location');
}
async function finish(portal,jar,returned){
  const result=response();await portal.callback(request(jar),result,returned);return result;
}
async function factory(db,issuer,now,transport=fetch,origin=websiteOrigin){
  const provider=await createOidcLoginProvider({id:'official-account-entry',name:'Synthetic entry',issuer:issuer.issuer,
    clientId:'galaxy-fixture',redirectUri:callback,includeAccountProfile:true,allowLoopbackHttp:true,now,fetch:transport});
  return createOfficialAccountPortal({db,endpoint,websiteOrigin:origin,provider,associationProviders:[provider],now});
}

test('pending PKCE and official sessions survive database reopen and new provider instances without changing UID or owner', {timeout:60000},async t=>{
  const temporary=resolve(tmpdir()),directory=await mkdtemp(join(temporary,'galaxy-account-sessions-'));
  let db=new PGlite(directory);
  t.after(async()=>{await db.close();assert.equal(dirname(resolve(directory)),temporary);assert.ok(basename(directory).startsWith('galaxy-account-sessions-'));await rm(directory,{recursive:true,force:true,maxRetries:4,retryDelay:100});});
  await migrate(db);
  const issuer=await oidcProviderFixture([callback],{emailVerified:true});t.after(issuer.close);
  let clock=Math.floor(Date.now()/1000);const now=()=>clock,jar=new Map();
  const first=await factory(db,issuer,now),target='/app/community?compose=post&draft=preserved';
  const authorization=await start(first,jar,target),returned=await issuer.authorize(authorization);
  // No portal/provider object from the first process participates in callback.
  await db.close();db=new PGlite(directory);
  const second=await factory(db,issuer,now),completed=await finish(second,jar,returned);accept(jar,completed);
  assert.equal(completed.headers.get('location'),websiteOrigin+target);
  assert.equal(completed.headers.get('set-cookie').some(value=>value.startsWith('__Host-galaxy-account-login=')),false,'a callback never overwrites a newer login cookie');
  const signedIn=await second.session(request(jar),sessionUrl);
  assert.equal(signedIn.state,'signed-in');assert.equal(signedIn.galaxyAuthorization,false);
  assert.deepEqual(signedIn.linkedIds,[]);assert.equal(signedIn.account.displayName,signedIn.account.uid);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM subjects')).rows[0].n,0,'online login creates no local identity');
  const saved=await db.query('SELECT token_hash FROM official_account_sessions_v1');
  const rawCookie=jar.get('__Host-galaxy-account').split('=')[1];
  assert.equal(saved.rows.some(row=>row.token_hash===rawCookie),false,'only token digests are persisted');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM oidc_login_transactions_v1')).rows[0].n,0);
  await second.data.updateSettings({kind:'official-account',accountId:signedIn.account.id,endpoint},{expectedRevision:0,
    displayName:'A name chosen by the owner',publicQuery:{enabled:false,scope:'profile'},archiveRetentionDays:null});
  await db.close();db=new PGlite(directory);
  const third=await factory(db,issuer,now),otherInstance=await factory(db,issuer,now);
  const resumed=await third.session(request(jar),sessionUrl);
  assert.equal(resumed.account.uid,signedIn.account.uid);assert.equal(resumed.account.displayName,'A name chosen by the owner');
  assert.equal(resumed.csrfToken,signedIn.csrfToken);assert.equal(resumed.expiresAt,signedIn.expiresAt,'restart does not extend lifetime');
  const action=request(jar,{origin:websiteOrigin,'x-galaxy-account-id':resumed.account.id,'x-galaxy-account-csrf':resumed.csrfToken},'POST');
  assert.equal((await otherInstance.actionActor(action)).accountId,resumed.account.id);
  assert.deepEqual(Object.keys(await third.currentSession(request(jar))).sort(),['accountId','expiresAt','externalSubject','issuer']);
  await assert.rejects(third.actionActor({...action,headers:{...action.headers,authorization:'Bearer rejected'}}),error=>error.code==='access_denied');
  const foreign=await factory(db,issuer,now,fetch,'https://another.example.org');
  assert.equal((await foreign.session(request(jar),sessionUrl)).state,'signed-out','different website/configuration cannot borrow the cookie');
  assert.equal((await otherInstance.revokeSessions({accountId:resumed.account.id})).revokedSessions,1);
  assert.equal((await third.session(request(jar),sessionUrl)).state,'signed-out','remote-instance revocation applies on the next read');
  await assert.rejects(third.actionActor(action),error=>error.code==='official_account_login_required');
  const reentry=await finish(third,jar,await issuer.authorize(await start(third,jar)));accept(jar,reentry);
  const relogged=await third.session(request(jar),sessionUrl);assert.equal(relogged.account.uid,resumed.account.uid);
  assert.equal(relogged.account.displayName,'A name chosen by the owner');
  const beforeLogout=new Map(jar),out=response();
  await otherInstance.logout(request(jar,{origin:websiteOrigin,'x-galaxy-account-csrf':relogged.csrfToken},'POST'),out);accept(jar,out);
  assert.equal((await third.session(request(beforeLogout),sessionUrl)).state,'signed-out','copied old cookies stay revoked');
  const last=await finish(third,jar,await issuer.authorize(await start(third,jar)));accept(jar,last);
  clock+=3601;assert.equal((await otherInstance.session(request(jar),sessionUrl)).state,'signed-out');
  assert.deepEqual(issuer.failures,[]);
});

test('multiple portal instances consume a callback once and an old tab cannot cancel the latest original return', {timeout:60000},async t=>{
  const db=new PGlite();t.after(()=>db.close());await migrate(db);
  const issuer=await oidcProviderFixture([callback],{emailVerified:true});t.after(issuer.close);
  let clock=Math.floor(Date.now()/1000);const now=()=>clock,jar=new Map();
  const a=await factory(db,issuer,now),b=await factory(db,issuer,now);
  const returned=await issuer.authorize(await start(a,jar,'/app/rooms'));
  const count=issuer.requests.filter(value=>value.path==='/token').length;
  const results=await Promise.all([finish(a,jar,returned),finish(b,jar,returned)]);
  assert.equal(results.filter(value=>value.headers.get('location')===websiteOrigin+'/app/rooms').length,1);
  assert.equal(results.filter(value=>value.headers.get('location').includes('accountLogin=stale')).length,1);
  assert.equal(issuer.requests.filter(value=>value.path==='/token').length-count,1,'only one real token exchange occurs');
  const winner=results.find(value=>value.headers.get('set-cookie'));accept(jar,winner);
  const uid=(await a.session(request(jar),sessionUrl)).account.uid;
  const old=await issuer.authorize(await start(a,jar,'/app/community?compose=post'));
  const newer=await issuer.authorize(await start(b,jar,'/app/work?tab=mine'));
  const stale=await finish(a,jar,old);
  assert.equal(stale.headers.has('set-cookie'),false);assert.match(stale.headers.get('location'),/accountLogin=stale/);
  const current=await finish(a,jar,newer);accept(jar,current);
  assert.equal(current.headers.get('location'),websiteOrigin+'/app/work?tab=mine');
  assert.equal((await b.session(request(jar),sessionUrl)).account.uid,uid);
  const delayedResponse=await finish(a,jar,await issuer.authorize(await start(a,jar,'/app/rooms?tab=first')));
  // Its response is deliberately not accepted. A different tab starts another
  // login before that newly issued session cookie has reached this browser.
  const following=await issuer.authorize(await start(b,jar,'/app/rooms?tab=latest'));
  const oldCookie=new Map(jar);accept(oldCookie,delayedResponse);
  assert.equal((await a.session(request(oldCookie),sessionUrl)).state,'signed-out','unseen issuance cannot revive the superseded login');
  const followed=await finish(b,jar,following);accept(jar,followed);
  assert.equal(followed.headers.get('location'),websiteOrigin+'/app/rooms?tab=latest');
  assert.equal((await a.session(request(jar),sessionUrl)).account.uid,uid);
  const canceledAuthorization=new URL(await start(a,jar,'/app/community?compose=reply'));
  const canceled=new URL(callback);canceled.searchParams.set('state',canceledAuthorization.searchParams.get('state'));canceled.searchParams.set('error','access_denied');
  const cancellation=await finish(b,jar,canceled);accept(jar,cancellation);
  assert.equal(cancellation.headers.get('location'),websiteOrigin+'/app/community?compose=reply&accountLogin=cancelled');
  const expired=await issuer.authorize(await start(a,jar,'/app/work'));clock+=301;
  const expiry=await finish(b,jar,expired);assert.match(expiry.headers.get('location'),/accountLogin=stale/);
  assert.equal(expiry.headers.has('set-cookie'),false);
  assert.deepEqual(issuer.failures,[]);
});

test('logout during a real token exchange cannot be undone by its delayed successful response', {timeout:60000},async t=>{
  const db=new PGlite();t.after(()=>db.close());await migrate(db);
  const issuer=await oidcProviderFixture([callback],{emailVerified:true});t.after(issuer.close);
  const now=()=>Math.floor(Date.now()/1000),jar=new Map(),plain=await factory(db,issuer,now);
  accept(jar,await finish(plain,jar,await issuer.authorize(await start(plain,jar))));
  const previous=await plain.session(request(jar),sessionUrl);
  let entered,release;const tokenRequest=new Promise(resolve=>{entered=resolve;}),released=new Promise(resolve=>{release=resolve;});
  const delayed=await factory(db,issuer,now,async(input,options)=>{
    if(new URL(input).pathname==='/token'){entered();await released;}
    return fetch(input,options);
  });
  const returned=await issuer.authorize(await start(delayed,jar)),pending=finish(delayed,jar,returned);
  try{
    await Promise.race([tokenRequest,pending.then(()=>{throw Error('Expected the token request before callback completion.');})]);
    await plain.logout(request(jar,{origin:websiteOrigin,'x-galaxy-account-csrf':previous.csrfToken},'POST'),response());
  } finally {release();}
  const late=await pending;assert.match(late.headers.get('location'),/accountLogin=failed/);
  assert.equal((late.headers.get('set-cookie')??[]).some(value=>value.startsWith('__Host-galaxy-account=')),false);
  assert.equal((await plain.session(request(jar),sessionUrl)).state,'signed-out');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM official_account_sessions_v1 WHERE revoked_at IS NULL')).rows[0].n,0);
  assert.deepEqual(issuer.failures,[]);
});
