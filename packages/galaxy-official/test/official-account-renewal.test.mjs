import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/infrastructure/database.mjs';
import {createOidcLoginProvider} from '../src/identity/authentication/oidc-login.mjs';
import {createOfficialAccountPortal} from '../src/accounts/official-account.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';

test('real account portal keeps stable owner/HttpOnly cookie, renews only input activity and logs out during unknown refresh',async()=>{
 const db=new PGlite(),endpoint='https://portal.invalid',websiteOrigin=endpoint,callback=endpoint+'/v1/account/callback';
 const fixture=await oidcProviderFixture([callback],{refreshTokens:true});
 let clock=Math.floor(Date.now()/1000),fail=false,calls=0;
 const now=()=>clock;
 try{
  await migrate(db);
  const provider=await createOidcLoginProvider({id:'account-fixture',name:'Synthetic',issuer:fixture.issuer,clientId:'galaxy-fixture',redirectUri:callback,sessionRenewal:true,allowLoopbackHttp:true,now,
   fetch:(input,options)=>{if(options?.body?.get?.('grant_type')==='refresh_token'){calls++;if(fail)throw Error('lost refresh response');}return fetch(input,options);}});
  const portal=createOfficialAccountPortal({provider,db,endpoint,websiteOrigin,associationProviders:[provider],now,sessionRenewal:{key:randomBytes(32),idleSeconds:120,maximumSeconds:600,refreshBeforeSeconds:10}});
  const headers=new Map(),response={setHeader:(key,value)=>headers.set(key.toLowerCase(),value),end(){}};
  const jar=new Map();
  const accept=()=>{const values=headers.get('set-cookie')??[];for(const value of Array.isArray(values)?values:[values]){const pair=value.split(';')[0];jar.set(pair.split('=')[0],pair);}headers.clear();};
  const request=(extra={},method='GET')=>({method,headers:{cookie:[...jar.values()].join('; '),...extra}});
  await portal.login(request(),response,new URL(endpoint+'/v1/account/login'));const authorization=headers.get('location');accept();
  await portal.callback(request(),response,await fixture.authorize(authorization));
  assert.match(headers.get('set-cookie')[0],/HttpOnly; Secure; SameSite=Lax; Max-Age=600/);accept();
  const cookie=jar.get('__Host-galaxy-account'),url=new URL(endpoint+'/v1/account/session');
  const initial=await portal.session(request(),url);assert.equal(initial.expiresAt,clock+120);
  clock+=30;assert.equal((await portal.session(request(),url)).expiresAt,initial.expiresAt,'ordinary reads do not renew');
  const foreign=await portal.session(request({origin:'https://foreign.invalid','x-galaxy-user-activity':'1','x-galaxy-account-csrf':initial.csrfToken}),url);assert.equal(foreign.expiresAt,initial.expiresAt);
  const active=await portal.session(request({'sec-fetch-site':'same-origin',host:'portal.invalid','x-galaxy-user-activity':'1','x-galaxy-account-csrf':initial.csrfToken}),url);
  assert.equal(active.expiresAt,clock+120);assert.equal(active.account.id,initial.account.id);assert.equal(active.csrfToken,initial.csrfToken);
  await db.query('UPDATE official_account_sessions_v1 SET upstream_expires_at=$1',[clock-1]);
  const refreshed=await portal.session(request(),url);assert.equal(calls,1);assert.equal(refreshed.account.id,initial.account.id);assert.equal(jar.get('__Host-galaxy-account'),cookie);
  fail=true;await db.query('UPDATE official_account_sessions_v1 SET upstream_expires_at=$1',[clock-1]);
  await assert.rejects(portal.session(request(),url),{code:'portal_session_refresh_unconfirmed'});
  await assert.rejects(portal.session(request(),url),{code:'portal_session_refresh_unconfirmed'});assert.equal(calls,2);
  const result=await portal.logout(request({origin:websiteOrigin,'x-galaxy-account-csrf':initial.csrfToken},'POST'),response);
  assert.equal(result.state,'signed-out');assert.equal((await portal.session(request(),url)).state,'signed-out');
 }finally{await fixture.close();await db.close();}
});
