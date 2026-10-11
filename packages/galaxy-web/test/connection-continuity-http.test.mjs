import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {migrate} from '../../galaxy-official/src/database.mjs';
import {createServices} from '../../galaxy-official/src/services.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createWebRuntime} from '../src/runtime.mjs';
import {createIdentityControlClient} from '../../galaxy-core/src/domain/identity-control-client.mjs';
import {createDeviceMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';

const {PGlite}=createRequire(new URL('../../galaxy-official/package.json',import.meta.url))('@electric-sql/pglite');
function memoryStore(){const rows=new Map();return{rows,get:async key=>structuredClone(rows.get(key)),put:async(key,value)=>rows.set(key,structuredClone(value)),
 update:async(key,change)=>{const value=change(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);}};}
async function fixture(t){
 let clock=Math.floor(Date.now()/1000);const db=new PGlite();await migrate(db);
 const server=generateKeyPairSync('ed25519'),endpoint='https://official.example.org',trustedKeys=new Map([['fixture',{
  publicKeyPem:server.publicKey.export({type:'spki',format:'pem'}),notBefore:clock-1,notAfter:clock+200000,revoked:false}]]);
 const services=createServices({db,endpoint,kid:'fixture',signingKey:server.privateKey,trustedKeys,allowedScopes:browserScopes,now:()=>clock,operator:'Isolated connection fixture',region:'test'});
 const api=createApi({...services,rateLimit:10000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+api.address().port,requests=[],clients=[],store=memoryStore();
 const fetcher=async(url,options)=>{const parsed=new URL(url);assert.equal(parsed.origin,endpoint);
  requests.push({path:parsed.pathname,...(parsed.pathname==='/v2/binding-challenges'?{scopes:JSON.parse(options.body).scopes}:{})});
  return fetch(origin+parsed.pathname,options);};
 const web=async()=>{const runtime=await createWebRuntime({endpoint,trustedKeys},{store,fetch:fetcher,now:()=>clock});clients.push(runtime);return runtime;};
 t.after(async()=>{clients.forEach(client=>client.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await db.close();});
 return{services,store,requests,web,now:()=>clock,advance:seconds=>{clock+=seconds;}};
}
test('approved browser connection resumes after reopen and expiry with exactly its scopes; explicit exit persists',async t=>{
 const f=await fixture(t),first=await f.web();assert.equal(await first.resumeConnection(),null);assert.equal(f.requests.length,0);
 await first.createIdentity({confirmed:true});const before=f.requests.length;assert.equal(await first.resumeConnection(),null);assert.equal(f.requests.length,before);
 const initial=await first.connect({confirmed:true,scopes:['binding','assistance']}),owner=(await first.status()).identity;
 const preference=[...f.store.rows.entries()].find(([key])=>key.includes(':connection:'))[1];
 assert.deepEqual(preference.scopes,['binding','assistance']);assert.equal(preference.enabled,true);
 assert.equal(/credential|privateKey|token|signature/i.test(JSON.stringify(preference)),false);
 first.close();const reopened=await f.web();
 const [a,b]=await Promise.all([reopened.resumeConnection(),reopened.resumeConnection()]);assert.equal(a.bindingId,b.bindingId);
 assert.equal(a.subjectId,owner.subjectId);assert.equal(a.bindingId,initial.bindingId);assert.deepEqual(a.scopes,initial.scopes);
 const lease=reopened.receiptStatus.captureLease();f.advance(601);assert.equal((await reopened.status()).connection,null);
 const renewed=await reopened.resumeConnection();assert.equal(renewed.bindingId,a.bindingId);assert.deepEqual(renewed.scopes,initial.scopes);
 assert.throws(lease.assertCurrent,/receipt_status_authority_changed/);
 assert.deepEqual(f.requests.filter(item=>item.path==='/v2/binding-challenges').map(item=>item.scopes),[['binding','assistance']]);
 assert.equal(f.requests.filter(item=>item.path==='/v1/sessions').length,3,'only the short-lived session changes after reopen or expiry');
 await reopened.disconnect();assert.equal((await reopened.status()).connection,null);const count=f.requests.length;
 assert.equal(await reopened.resumeConnection(),null);assert.equal(f.requests.length,count);
 reopened.close();const exited=await f.web();assert.equal(await exited.resumeConnection(),null);assert.equal(f.requests.length,count);
});
test('reopening refuses changed receipt identity, device, epoch, scope, expiry and an actually revoked binding without replacing it',async t=>{
 const f=await fixture(t),runtime=await f.web();await runtime.createIdentity({confirmed:true});const initial=await runtime.connect({confirmed:true,scopes:['binding','assistance']});
 const [key,preference]=[...f.store.rows.entries()].find(([key])=>key.includes(':connection:')),
  receipt=preference.binding,
  claims=JSON.parse(Buffer.from(receipt.receipt.split('.')[1],'base64url')).data;
 runtime.close();
 const alternatives=[{subjectId:'GUID'+'A'.repeat(28)},
  {control:{...claims.control,deviceId:crypto.randomUUID()}},{control:{...claims.control,epoch:claims.control.epoch+1}},
  {installationId:crypto.randomUUID()},{scopes:['binding']},{endpoint:'https://different.example.org'}];
 for(const difference of alternatives){
  const replacement={...claims,...difference},signed=await f.services.bindings.sign('binding-receipt',replacement,receipt.bindingId,86400);
  await f.store.put(key,{...preference,binding:{bindingId:receipt.bindingId,receipt:signed}});
  const reopened=await f.web(),before=f.requests.filter(value=>['/v1/sessions','/v1/bindings'].includes(value.path)).length;
  await assert.rejects(reopened.resumeConnection(),/mismatch/);
  assert.equal(f.requests.filter(value=>['/v1/sessions','/v1/bindings'].includes(value.path)).length,before);
  assert.equal((await reopened.status()).connection,null);reopened.close();
 }
 await f.store.put(key,preference);
 // Use an actual authenticated same-device session to revoke its own binding.
 const owner=await f.web();await owner.resumeConnection();await owner.api.call(`/v1/bindings/${initial.bindingId}/revoke`,{});owner.close();
 const denied=await f.web(),before=f.requests.filter(value=>value.path==='/v1/bindings').length;
 await assert.rejects(denied.resumeConnection(),error=>error.code==='access_denied');
 assert.equal(f.requests.filter(value=>value.path==='/v1/bindings').length,before);
 assert.equal((await denied.status()).connection,null);
 f.advance(86401);const expired=await f.web();await assert.rejects(expired.resumeConnection(),error=>error.code==='ERR_JWT_EXPIRED');
 assert.equal(f.requests.filter(value=>value.path==='/v1/bindings').length,before);
});
test('automatic connection refuses a genuinely revoked device using fresh signed identity control',async t=>{
 const f=await fixture(t),runtime=await f.web();await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
 const {identity}=await runtime.status(),original=await f.store.get(`device:${identity.subjectId}:${identity.deviceId}`),second=await createDeviceMaterial();
 const makeClient=(controller,newDevice=controller)=>createIdentityControlClient({endpoint:runtime.api.endpoint,send:runtime.api.send,store:memoryStore(),now:f.now,
  signController:payload=>signIdentityPayload(payload,controller.privateKey),signNewDevice:payload=>signIdentityPayload(payload,newDevice.privateKey)});
 let state=await f.services.identityControl.publicState(identity.subjectId);const grant=makeClient(original,second);
 await grant.confirm(await grant.prepare({version:2,kind:'authorize-device',operationId:crypto.randomUUID(),subjectId:identity.subjectId,
  expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:await identityKeyId(original.publicKeyPem),
  newDevice:{deviceId:second.deviceId,publicKeyPem:second.publicKeyPem,scopes:['manage-identity',...browserScopes]}}),{confirmed:true});
 state=await f.services.identityControl.publicState(identity.subjectId);const revoke=makeClient(second);
 await revoke.confirm(await revoke.prepare({version:2,kind:'revoke-device',operationId:crypto.randomUUID(),subjectId:identity.subjectId,
  expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:await identityKeyId(second.publicKeyPem),deviceId:identity.deviceId}),{confirmed:true});
 runtime.close();const reopened=await f.web(),before=f.requests.filter(item=>item.path==='/v2/binding-challenges').length;
 await assert.rejects(reopened.resumeConnection(),/当前设备已失效/);assert.equal((await reopened.status()).connection,null);
 assert.equal(f.requests.filter(item=>item.path==='/v2/binding-challenges').length,before);
});
