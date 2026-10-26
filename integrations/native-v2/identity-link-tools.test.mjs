import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {loadToolMcpClient} from '../../packages/galaxy-web/scripts/browser-tool-runtime.mjs';
const {Client,InMemoryTransport}=await loadToolMcpClient();
import {serviceFixture} from '../../packages/galaxy-official/test/service-fixture.mjs';
import {oidcProviderFixture} from '../../packages/galaxy-official/test/oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from '../../packages/galaxy-official/src/oidc-login.mjs';
import {createApi} from '../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../../packages/galaxy-edge-mcp/src/native-v2/server.mjs';
import {nativeData} from '../../packages/galaxy-edge-mcp/test/native-result.mjs';

async function fixture(){
 const endpoint='https://official.example.org',directory=await mkdtemp(join(tmpdir(),'galaxy-native-account-'));
 const clock={now:Math.floor(Date.now()/1000)},issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
 let services,api;const connections=[],calls=[],previews=new WeakMap();let loseConfirm=false,dropConfirm=false;
 try{
  const oidc=await createOidcLoginProvider({id:'fixture',name:'Isolated official account',issuer:issuer.issuer,clientId:'galaxy-fixture',
   redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>clock.now});
  // The actual independent OIDC issuer is HTTP loopback in this portable test.
  // Only the public browser-facing URL has an HTTPS test facade. Discovery,
  // code exchange, PKCE and signed tokens still use the real issuer SDK.
  const provider={describe:oidc.describe,begin:async()=>{const original=await oidc.begin(),url=new URL(original.authorizationUrl);
   const value={...original,authorizationUrl:'https://synthetic-login.example'+url.pathname+url.search};previews.set(value,original);return value;},
   complete:(value,returned)=>oidc.complete(previews.get(value),returned),cancel:value=>oidc.cancel(previews.get(value))};
  services=await serviceFixture(browserScopes,null,{now:clock.now,identityProviders:[provider],syntheticCommunityQuota:false});
  services.access.now=()=>clock.now;
  api=createApi({...services,rateLimit:3000});await new Promise(done=>api.listen(0,'127.0.0.1',done));const local='http://127.0.0.1:'+api.address().port;
  const fetcher=async(url,options={})=>{const path=new URL(url).pathname;assert.equal(new URL(url).origin,endpoint);
   if(dropConfirm&&path==='/v1/identity/confirm'){dropConfirm=false;calls.push({path,status:0,method:options.method,bytes:options.body});throw Error('synthetic_transport_lost_before_delivery');}
   const response=await fetch(local+path,options);calls.push({path,status:response.status,method:options.method??'GET',
    ...(path==='/v1/identity/confirm'?{bytes:options.body}: {})});
   if(loseConfirm&&path==='/v1/identity/confirm'&&response.status===200){loseConfirm=false;await response.arrayBuffer();throw Error('synthetic_committed_ack_lost');}
   return response;};
  async function attach(name){
   const runtime=await createNativeRuntime({dataDirectory:join(directory,name),endpoint,website:'https://selected.example',trustedKeys:services.access.trustedKeys,
    now:()=>clock.now,fetch:fetcher,openBrowser:async()=>({launched:false,state:'isolated-test-captured'})});
   const server=createNativeToolServer(runtime),client=new Client({name:'isolated-native-account',version:'1'},{capabilities:{}});
   const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
   const raw=(name,input)=>client.callTool({name,arguments:input});
   const call=async(name,input)=>{const result=await raw(name,input),data=nativeData(result);assert.equal(result.isError??false,false,JSON.stringify(data));return data;};
   const entry={runtime,server,client,raw,call};connections.push(entry);return entry;
  }
  async function allow(value){assert.equal(value.state,'user-choice-needs-browser');const url=new URL(value.url),page=await fetch(url);
   assert.equal(page.status,200);const html=await page.text();assert.match(html,/允许本次操作/);
   const denied=await fetch(url,{method:'POST',headers:{Origin:'https://selected.example','content-type':'application/x-www-form-urlencoded'},body:'action=allow'});assert.equal(denied.status,403);
   const response=await fetch(url,{method:'POST',headers:{Origin:url.origin,'content-type':'application/x-www-form-urlencoded'},body:'action=allow'});assert.equal(response.status,200);
  }
  async function initialize(connection){
   const review=await connection.call('galaxy_native_initialize',{});assert.equal((await connection.runtime.status()).identity,null);
   await allow(review);const initialized=await connection.call('galaxy_native_initialize',{});assert.equal(initialized.localOnly,true);
   const local=JSON.parse(await readFile(join(connection.runtime.store.dataDirectory,'galaxy-id.json'),'utf8'));
   assert.equal(local.id,initialized.identity);assert.equal(local.birthOrigin,'local');assert.equal((await connection.runtime.status()).connected,false);
   await allow(await connection.call('galaxy_native_connect',{}));await connection.call('galaxy_native_connect',{});return initialized.identity;
  }
  async function login(connection){
   const list=await connection.call('galaxy_identity_account_read',{action:'providers'});assert.equal(list.providers[0].id,'fixture');
   const started=await connection.call('galaxy_identity_account_read',{action:'begin',providerId:'fixture'}),url=new URL(started.authorizationUrl);
   assert.equal(url.searchParams.get('scope'),'openid email');
   const returned=await issuer.authorize(issuer.issuer+url.pathname+url.search),response=await fetch(local+returned.pathname+returned.search);assert.equal(response.status,200);
   assert.equal((await response.json()).state,'awaiting-local-signature');
   const state=await connection.call('galaxy_identity_account_read',{action:'status',id:started.loginId});assert.equal(state.state,'awaiting-local-signature');
   return{started,state};
  }
  return{directory,clock,issuer,services,calls,attach,initialize,login,allow,loseNextConfirm:()=>loseConfirm=true,dropNextConfirm:()=>dropConfirm=true,
   async close(){for(const entry of connections){await entry.client.close();await entry.server.close();entry.runtime.close();}
    api.closeAllConnections();await new Promise(done=>api.close(done));await services.db.close();await issuer.close();
    const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-account-'));await rm(target,{recursive:true,force:true});}};
 }catch(error){api?.closeAllConnections();if(api?.listening)await new Promise(done=>api.close(done));await services?.db.close();await issuer.close();throw error;}
}

test('installed Native creates locally, OIDC alone cannot link, real local review signs and lost ACK reconciles the same account and ID',{timeout:90000},async()=>{
 const f=await fixture();try{
  const a=await f.attach('environment-a'),subjectId=await f.initialize(a),{started,state}=await f.login(a);
  assert.equal(state.intent.subjectId,subjectId);assert.equal((await f.services.db.query('SELECT count(*)::int n FROM external_identity_links')).rows[0].n,0);
  const prepared=await a.call('galaxy_identity_account_prepare',{action:'link',id:started.loginId}),input={previewId:prepared.previewId};
  const review=await a.call('galaxy_identity_account_execute',input);
  assert.equal((await f.services.db.query('SELECT count(*)::int n FROM external_identity_links')).rows[0].n,0);
  await f.allow(review);f.loseNextConfirm();const result=await a.call('galaxy_identity_account_execute',input);
  assert.equal(result.state,'linked');assert.equal(result.remoteResent,false);assert.equal(result.id,started.loginId);
  assert.equal(f.calls.filter(row=>row.path==='/v1/identity/confirm').length,1,'accepted response loss is read, never retransmitted');
  assert.equal((await a.call('galaxy_identity_account_execute',input)).state,'linked');
  const links=await a.call('galaxy_identity_account_read',{action:'query'});assert.equal(links.items.length,1);assert.equal(links.items[0].subjectId,subjectId);
  const retained=await a.call('galaxy_identity_account_recover',{id:started.loginId});assert.equal(retained.state,'linked');
  assert.ok(!JSON.stringify(retained).includes('signed'));assert.ok(!JSON.stringify(links).includes('PRIVATE KEY'));
  const stored=(await f.services.db.query('SELECT * FROM external_identity_links WHERE id=$1',[started.loginId])).rows[0];
  assert.equal(stored.subject_id,subjectId);assert.equal(stored.control_epoch,1);assert.equal(stored.signer_key_id,a.runtime.api.snapshot().control.keyId);
  assert.equal(JSON.parse(stored.payload_text).externalSubject,'synthetic-oidc-subject');
  assert.equal((await a.runtime.status()).identity,subjectId);assert.deepEqual(f.issuer.failures,[]);
 }finally{await f.close();}
});

test('undelivered approved intent retries the exact bytes; unlink has a separate reviewed operation and expired previews cannot sign',{timeout:90000},async()=>{
 const f=await fixture();try{
  const a=await f.attach('environment-a'),subjectId=await f.initialize(a),{started}=await f.login(a);
  const prepared=await a.call('galaxy_identity_account_prepare',{action:'link',id:started.loginId}),input={previewId:prepared.previewId};
  await f.allow(await a.call('galaxy_identity_account_execute',input));f.dropNextConfirm();const result=await a.call('galaxy_identity_account_execute',input);
  assert.equal(result.state,'linked');assert.equal(result.remoteResent,true);assert.equal(result.originalSignedBytes,true);
  const attempts=f.calls.filter(row=>row.path==='/v1/identity/confirm');assert.equal(attempts.length,2);assert.equal(attempts[0].bytes,attempts[1].bytes);
  const unlink=await a.call('galaxy_identity_account_prepare',{action:'unlink',id:started.loginId}),unlinkInput={previewId:unlink.previewId};
  await f.allow(await a.call('galaxy_identity_account_execute',unlinkInput));assert.equal((await a.call('galaxy_identity_account_execute',unlinkInput)).state,'revoked');
  assert.equal((await a.call('galaxy_identity_account_recover',{id:started.loginId})).state,'revoked');
  assert.equal((await a.runtime.status()).identity,subjectId);assert.equal((await f.services.db.query('SELECT count(*)::int n FROM external_identity_links')).rows[0].n,1);
  const another=await f.login(a),expired=await a.call('galaxy_identity_account_prepare',{action:'link',id:another.started.loginId}),expiredInput={previewId:expired.previewId};
  await f.allow(await a.call('galaxy_identity_account_execute',expiredInput));f.clock.now+=301;
  const before=f.calls.filter(row=>row.path==='/v1/identity/confirm').length,denied=await a.raw('galaxy_identity_account_execute',expiredInput);
  assert.equal(denied.isError,true);assert.equal(f.calls.filter(row=>row.path==='/v1/identity/confirm').length,before);
 }finally{await f.close();}
});

test('two locally controlled environment IDs link one verified account without merging; changed Native binding cannot consume a held preview',{timeout:90000},async()=>{
 const f=await fixture();try{
  const a=await f.attach('environment-a'),b=await f.attach('environment-b'),subjectA=await f.initialize(a),subjectB=await f.initialize(b);assert.notEqual(subjectA,subjectB);
  for(const c of[a,b]){const{started}=await f.login(c),prepared=await c.call('galaxy_identity_account_prepare',{action:'link',id:started.loginId}),input={previewId:prepared.previewId};await f.allow(await c.call('galaxy_identity_account_execute',input));assert.equal((await c.call('galaxy_identity_account_execute',input)).state,'linked');}
  assert.equal((await f.services.db.query('SELECT count(*)::int n FROM community_accounts')).rows[0].n,1);
  assert.equal((await f.services.db.query('SELECT count(*)::int n FROM external_identity_links')).rows[0].n,2);
  const another=await f.login(a),preview=await a.call('galaxy_identity_account_prepare',{action:'link',id:another.started.loginId}),input={previewId:preview.previewId};
  await f.allow(await a.call('galaxy_identity_account_execute',input));await a.runtime.connect({confirmed:true});
  const before=f.calls.filter(row=>row.path==='/v1/identity/confirm').length,stale=await a.raw('galaxy_identity_account_execute',input);
  assert.equal(stale.isError,true);assert.equal(nativeData(stale).error,'receipt_status_authority_changed');assert.equal(f.calls.filter(row=>row.path==='/v1/identity/confirm').length,before);
  const selected=await b.runtime.store.readConnection(b.runtime.api.endpoint);await a.runtime.store.updateConnection(a.runtime.api.endpoint,()=>({active:selected.active,permission:{enabled:false}}));await a.runtime.status();
  const foreign=await a.raw('galaxy_identity_account_execute',input);assert.equal(foreign.isError,true);assert.equal((await a.runtime.status()).identity,subjectB);
  assert.equal(f.calls.filter(row=>row.path==='/v1/identity/confirm').length,before);assert.deepEqual(f.issuer.failures,[]);
 }finally{await f.close();}
});
