import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from './service-fixture.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createOfficialAccountPortal,loadOfficialAccountPortal} from '../src/official-account.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {IdentityLinkService} from '../src/identity-links.mjs';
import {CommunityAccountRegistry} from '../src/community-accounts.mjs';
import {createApi} from '../src/http.mjs';

test('official login is cookie-bound, lists independently signed IDs, and cannot authorize a Galaxy subject', {timeout:60000}, async t => {
  const endpoint = 'https://official.example.org', website = 'https://galaxy.example.org';
  const callback = endpoint + '/v1/account/callback', associationCallback = endpoint + '/v1/identity/callback/fixture';
  const issuer = await oidcProviderFixture([callback,associationCallback],{emailVerified:true});
  t.after(issuer.close);
  let clock = Math.floor(Date.now()/1000);
  const provider = await createOidcLoginProvider({id:'fixture',name:'Synthetic account',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:associationCallback,allowLoopbackHttp:true,now:()=>clock});
  const loginProvider = await createOidcLoginProvider({id:'official-account-entry',name:'Synthetic entry',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:callback,includeAccountProfile:true,allowLoopbackHttp:true,now:()=>clock});
  const f = await serviceFixture(['binding','data-export'],null,{now:clock}); t.after(()=>f.db.close());
  const other = await serviceFixture(['binding','data-export'],f.db,{migrateDatabase:false,now:clock});
  const registry = new CommunityAccountRegistry(f.access,[provider]);
  const identity = new IdentityLinkService(f.access,[provider],{accountRegistry:registry});
  const officialAccounts = createOfficialAccountPortal({provider:loginProvider,db:f.db,endpoint,websiteOrigin:website,associationProviders:[provider],now:()=>clock});
  const server = createApi({...f,identity,officialAccounts,browserOrigins:[website],rateLimit:250});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path,options={})=>fetch(base+path,{redirect:'manual',...options});
  const jar = new Map();
  function accept(response) {for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0], [name]=pair.split('=');jar.set(name,pair);}}
  const cookie = () => [...jar.values()].join('; ');
  async function start(query='') {const response=await request('/v1/account/login'+query,{headers:{Cookie:cookie()}});accept(response);return response;}
  async function finish(response,headers={Cookie:cookie()}) {const returned=await issuer.authorize(response.headers.get('location'));const result=await request(returned.pathname+returned.search,{headers});accept(result);return result;}
  async function session(extra='') {const response=await request('/v1/account/session'+extra,{headers:{Cookie:cookie(),Origin:website}});return {response,value:await response.json()};}
  assert.equal((await session()).value.state,'signed-out');
  for(const returnTo of ['https://evil.invalid','//evil.invalid','/app/../../outside','/app/\\evil.invalid','/app/%0d%0aLocation:evil']) {
    const response = await start('?returnTo='+encodeURIComponent(returnTo));
    assert.equal(response.status,400,'untrusted return destination rejected: '+returnTo);
  }
  const first = await start('?returnTo='+encodeURIComponent('/app/community?channel=help'));
  assert.equal(first.status,303); assert.ok(first.headers.getSetCookie()[0].includes('HttpOnly; Secure; SameSite=Lax'));
  const returned = await issuer.authorize(first.headers.get('location'));
  const alien = await request(returned.pathname+returned.search);
  assert.equal(alien.status,303); assert.match(alien.headers.get('location'),/accountLogin=failed/);
  assert.equal((await session()).value.state,'signed-out','foreign browser cannot acquire victim login');
  const correct = await request(returned.pathname+returned.search,{headers:{Cookie:cookie()}}); accept(correct);
  assert.equal(correct.headers.get('location'),website+'/app/community?channel=help');
  const empty = await session();
  assert.equal(empty.value.state,'signed-in'); assert.deepEqual(empty.value.linkedIds,[]);
  assert.equal(empty.value.account.email,'synthetic@example.invalid'); assert.equal(empty.value.account.emailVerified,true);
  assert.equal(empty.response.headers.get('access-control-allow-credentials'),'true');
  assert.equal(empty.response.headers.get('cache-control'),'no-store');
  for(const forbidden of ['access_token','id_token','externalSubject','issuer','publicKey','bindingId']) assert.ok(!JSON.stringify(empty.value).includes(forbidden));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM external_identity_links')).rows[0].n,0,'account login creates no ID association');
  for(const owner of [f,other]) {
    const preview = await identity.begin(owner.actor,{providerId:'fixture'});
    await identity.callback('fixture',await issuer.authorize(preview.authorizationUrl));
    const status = await identity.status(owner.actor,{id:preview.loginId});
    await identity.confirm(owner.actor,{id:preview.loginId,signed:await owner.signForTest(status.payloadJson,'galaxy-identity-link+jws')});
  }
  const full = await session();
  assert.deepEqual(new Set(full.value.linkedIds.map(value=>value.subjectId)),new Set([f.actor.subjectId,other.actor.subjectId]));
  assert.equal(full.value.galaxyAuthorization,false);
  assert.equal((await request('/v1/identity/providers',{method:'POST',headers:{Cookie:cookie(),'Content-Type':'application/json'},body:'{}'})).status,401,'account cookie cannot replace subject authorization');
  const sorted = full.value.linkedIds.map(value=>value.subjectId).sort();
  assert.deepEqual((await session('?after='+sorted[0])).value.linkedIds.map(value=>value.subjectId),[sorted[1]]);
  const postLogout = (originValue,csrf)=>request('/v1/account/logout',{method:'POST',headers:{Cookie:cookie(),Origin:originValue,'Content-Type':'application/json','X-Galaxy-Account-CSRF':csrf},body:'{}'});
  assert.equal((await postLogout('https://evil.invalid',full.value.csrfToken)).status,403);
  assert.equal((await postLogout(website,'x'.repeat(43))).status,403);
  const preflight=await request('/v1/account/logout',{method:'OPTIONS',headers:{Origin:website,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-galaxy-account-csrf'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
  const otherPreflight=await request('/v1/identity/confirm',{method:'OPTIONS',headers:{Origin:website,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-galaxy-account-csrf'}});
  assert.equal(otherPreflight.status,403,'cookie CSRF exception does not broaden Galaxy operation CORS');
  const logout = await postLogout(website,full.value.csrfToken); assert.equal(logout.status,200);accept(logout);
  assert.equal((await session()).value.state,'signed-out');
  issuer.setAccount('another-official-account');
  await finish(await start());
  assert.deepEqual((await session()).value.linkedIds,[],'another account cannot enumerate the first account IDs');
  clock += 3601;
  assert.equal((await session()).value.state,'signed-out','expired official session cannot read associations');
  assert.deepEqual(issuer.failures,[]);
});

test('official account configuration rejects extra credentials and foreign authorities before discovery',async t=>{
  const temporary=resolve(tmpdir()),directory=await mkdtemp(join(temporary,'galaxy-official-account-config-'));
  t.after(async()=>{assert.equal(dirname(resolve(directory)),temporary);assert.ok(basename(directory).startsWith('galaxy-official-account-config-'));await rm(directory,{recursive:true,force:true});});
  const file=join(directory,'account.json'),endpoint='https://official.example.org',websiteOrigin='https://galaxy.example.org';
  const issuer='https://auth.example.org/realms/galaxy',calls=[];
  const association={describe:()=>({issuer,clientId:'galaxy-official'})};
  const factory=async options=>{calls.push(options);return {describe:()=>({issuer,clientId:options.clientId,redirectUri:options.redirectUri})};};
  const options={endpoint,websiteOrigin,db:{},browserOrigins:[websiteOrigin],identityProviders:[association],factory};
  const valid={version:1,issuer,clientId:'galaxy-account-entry',websiteOrigin};
  assert.equal(await loadOfficialAccountPortal(undefined,options),null);
  for(const input of [{...valid,clientSecret:'not-a-credential'},{...valid,websiteOrigin:'https://foreign.example.org'},
    {...valid,issuer:'http://127.0.0.1:1234/realms/test'},{...valid,clientId:'*'},{...valid,issuer:issuer+'?unexpected=1'}]){
    await writeFile(file,JSON.stringify(input));await assert.rejects(loadOfficialAccountPortal(file,options));
  }
  assert.equal(calls.length,0,'untrusted configuration cannot begin discovery');
  await writeFile(file,JSON.stringify(valid));const portal=await loadOfficialAccountPortal(file,options);
  assert.equal(calls.length,1);assert.equal(calls[0].includeAccountProfile,true);assert.equal(calls[0].redirectUri,endpoint+'/v1/account/callback');
  assert.equal(Object.hasOwn(calls[0],'clientSecret'),false);assert.match(portal.configurationHash,/^[a-f0-9]{64}$/);
});
