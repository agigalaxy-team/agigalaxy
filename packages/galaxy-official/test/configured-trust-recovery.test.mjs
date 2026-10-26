import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,randomUUID } from 'node:crypto';
import { mkdtemp,rm,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguredRuntime } from '../../../integrations/host-adapters/opencode-stable/configured-runtime.mjs';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { createConnectionProfile,saveConnectionProfile } from '../../galaxy-core/src/connection-profile.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { createServices } from '../src/services.mjs';
import { issueKeyring } from "../src/security/trust-keyring.mjs";

test('root-managed host persists revocation, drops old sessions on failed discovery, reconnects explicitly and cannot roll trust back after restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-trust-recovery-')),f=await serviceFixture(['binding']);
  t.after(async()=>{await f.db.close();await rm(directory,{recursive:true,force:true});});
  const dataDirectory=join(directory,'identity'),trustDirectory=join(directory,'trust'),endpoint=f.bindings.endpoint;
  await initializeGalaxyIntegration(dataDirectory,{profile:'coding-case',source:'test'});
  await saveConnectionProfile(dataDirectory,createConnectionProfile({targets:[{id:'official',kind:'official',endpoint}],
    scopes:[{id:'bind',targetId:'official',action:'binding',recipient:endpoint,purpose:'Explicit synthetic connection',
      visibleFields:['subjectId','genesisProof','installationId','scopes'],expiresAt:new Date((f.now+90000)*1000).toISOString()}]}));
  const root=generateKeyPairSync('ed25519'),next=generateKeyPairSync('ed25519');
  const pin=(pair,kid)=>({kid,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),notBefore:f.now-1,notAfter:f.now+200000,revoked:false});
  const rootPins=new Map([['root',pin(root,'root')]]),trustedKeys=new Map();
  const old={kid:'fixture',...f.bindings.trustedKeys.get('fixture'),revoked:false};
  const issue=(sequence,keys)=>issueKeyring({endpoint,sequence,keys,rootKid:'root',rootPrivateKey:root.privateKey,now:f.now});
  const original=await issue(1,[old]);let keyring=original,document=(await f.manifest.get()).document,backend=f;
  let writes=0,keyReads=0,manifestReads=0,manifestGate=null,manifestEntered;
  const config={dataDirectory,trustDirectory,rootPins,trustedKeys,endpoint,installationId:randomUUID(),bindingScopeId:'bind',scopes:['binding'],now:()=>f.now,
    connectionSend:async(url,input)=>{writes++;const body=JSON.parse(input.bodyJson);
      const handlers={'/v1/binding-challenges':()=>backend.bindings.challenge(body),'/v1/bindings':()=>backend.bindings.bind(body),
        '/v1/session-challenges':()=>backend.access.challenge(body),'/v1/sessions':()=>backend.access.activate(body)};
      return handlers[new URL(url).pathname]();}};
  const transport={readKeyring:async(url,input)=>{keyReads++;assert.equal(url,endpoint+'/.well-known/galaxy-signing-keys.json');assert.deepEqual(Object.keys(input),['signal']);return keyring;},
    readManifest:async()=>{manifestReads++;manifestEntered?.();if(manifestGate)await manifestGate;return document;}};
  const source=createConfiguredRuntime(config,transport);t.after(()=>source.close());
  assert.equal(keyReads,0);assert.equal(manifestReads,0);assert.deepEqual(await readdir(directory),['identity']);
  assert.throws(()=>createConfiguredRuntime({...config,trustDirectory:undefined},transport),/requires root pins/);
  const first=await source.read(new AbortController().signal);
  const preview=await first.controller.prepare();assert.equal(writes,0);
  assert.equal((await first.controller.execute(preview,preview.confirmation)).state,'session-local');assert.equal(writes,4);
  assert.equal(source.status().trustSequence,1);
  const pending=await first.controller.prepare();
  keyring=await issue(2,[{...old,revoked:true},pin(next,'next')]);
  await assert.rejects(source.read(new AbortController().signal)); // The server still presents the old signed Manifest.
  assert.equal(trustedKeys.get('fixture').revoked,true);assert.equal(source.status().trustSequence,2);
  assert.equal((await first.controller.status()).state,'no-session');
  await assert.rejects(first.controller.execute(pending,pending.confirmation));assert.equal(writes,4);
  backend=createServices({db:f.db,endpoint,signingKey:next.privateKey,kid:'next',trustedKeys:new Map(trustedKeys),now:()=>f.now,operator:'Recovered fixture',region:'test',allowedScopes:['binding']});
  document=(await backend.manifest.get()).document;
  const recovered=await source.read(new AbortController().signal);
  assert.equal((await recovered.controller.status()).state,'no-session');assert.equal(writes,4);
  const reconnect=await recovered.controller.prepare();
  assert.equal((await recovered.controller.execute(reconnect,reconnect.confirmation)).state,'session-local');assert.equal(writes,8);
  source.close();keyring=original;
  const reopened=createConfiguredRuntime({...config,trustedKeys:new Map()},transport);t.after(()=>reopened.close());
  await assert.rejects(reopened.read(new AbortController().signal),/rollback/);
  keyring=await issue(3,[old,pin(next,'next')]);
  await assert.rejects(reopened.read(new AbortController().signal),/resurrection/);
  keyring=await issue(3,[{...old,revoked:true},pin(next,'next')]);
  const again=await reopened.read(new AbortController().signal),p=await again.controller.prepare();
  await again.controller.execute(p,p.confirmation);
  keyring=await issue(4,[{...old,revoked:true},{...pin(next,'next'),revoked:true}]);
  let release;manifestGate=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{manifestEntered=resolve;}),abort=new AbortController();
  const canceled=reopened.read(abort.signal);await entered;abort.abort();release();await assert.rejects(canceled);
  assert.equal(reopened.status().state,'canceled');assert.equal(reopened.status().trustSequence,4);
  assert.equal((await again.controller.status()).state,'no-session');
  const after=createConfiguredRuntime({...config,trustedKeys:new Map()},transport);t.after(()=>after.close());
  keyring=await issue(3,[{...old,revoked:true},pin(next,'next')]);
  await assert.rejects(after.read(new AbortController().signal),/rollback/);
  assert.equal((await readdir(trustDirectory)).length,1);
});
