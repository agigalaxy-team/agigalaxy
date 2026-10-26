import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { localPaths } from '../../galaxy-core/src/storage/files.mjs';
import { createConnectionProfile,saveConnectionProfile } from '../../galaxy-core/src/connection-profile.mjs';
import { createConfiguredRuntime } from '../../../integrations/host-adapters/opencode-stable/configured-runtime.mjs';
import { createApi } from '../src/http.mjs';
import { createBuilderClient } from "../src/clients/builder.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { serviceFixture } from './service-fixture.mjs';
import { hubProfile,hubManifestFixture,hubDeclaration } from './hub-manifest-fixture.mjs';

async function serve(t,services){const api=createApi({...services,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));});
  const origin=`http://127.0.0.1:${api.address().port}`;
  return {get:async(url,options={})=>{const response=await fetch(origin+new URL(url).pathname,{signal:options.signal});assert.equal(response.status,200);return response.json();},
    post:async(url,options)=>{const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',...(options.credential?{Authorization:`Bearer ${options.credential}`}:{})},body:options.bodyJson,signal:options.signal});assert.equal(response.status,new URL(url).pathname.endsWith('-challenges')?201:200);return response.json();}};
}
test('configured Hub uses existing identity and actual HTTP binding/session handshake with an exact Hub target',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-hub-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const f=await serviceFixture(['binding'],null,{manifestProfile:hubProfile,endpoint:'https://hub.example.org'});t.after(()=>f.db.close());
  const http=await serve(t,f),endpoint=f.bindings.endpoint;
  await initializeGalaxyIntegration(directory,{profile:'coding-case',source:'test'});
  const paths=localPaths(directory),identity=await readFile(paths.identity),key=await readFile(paths.privateKey);
  const profile=kind=>createConnectionProfile({targets:[{id:'target',kind,endpoint}],scopes:[{id:'bind',targetId:'target',action:'binding',recipient:endpoint,
    purpose:'Explicit Hub connection',visibleFields:['subjectId','genesisProof','installationId','scopes'],expiresAt:new Date((f.now+90000)*1000).toISOString()}]});
  await saveConnectionProfile(directory,profile('official'));
  let reads=0,writes=0;
  const configuration={networkType:'hub',endpoint,dataDirectory:directory,scopes:['binding'],installationId:randomUUID(),bindingScopeId:'bind',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
    connectionSend:async(...args)=>{writes++;return http.post(...args);}};
  const source=createConfiguredRuntime(configuration,{readManifest:async(...args)=>{reads++;return http.get(...args);}});t.after(()=>source.close());
  assert.equal(reads,0);assert.equal(writes,0);assert.equal(source.status().networkType,'hub');
  const result=await source.read(new AbortController().signal);
  assert.equal(result.networkType,'hub');assert.equal(result.profile,'galaxy-hub/1');assert.match(result.manifestSha256,/^[a-f0-9]{64}$/);
  assert.equal(result.connected,false);await assert.rejects(result.controller.prepare());assert.equal(writes,0);
  await saveConnectionProfile(directory,profile('hub'));
  const preview=await result.controller.prepare();assert.equal(writes,0);
  await result.controller.execute(preview,preview.confirmation);
  assert.equal(writes,4);assert.equal((await result.controller.status()).state,'session-local');assert.equal((await result.controller.status()).networkType,'hub');
  assert.deepEqual(await readFile(paths.identity),identity);assert.deepEqual(await readFile(paths.privateKey),key);
  result.controller.disconnect();assert.equal((await result.controller.status()).state,'disconnected');
  const wrong=createConfiguredRuntime({...configuration,networkType:'official'},{readManifest:http.get});t.after(()=>wrong.close());
  await assert.rejects(wrong.read(new AbortController().signal));assert.equal(wrong.status().state,'unverified');assert.equal(writes,4);
});

test('Hub directory check uses separate pins, anonymous HTTP and live declaration recheck',async t=>{
  const f=await serviceFixture(['binding','consent','builders']);t.after(()=>f.db.close());
  const registry=await serve(t,f),hub=hubManifestFixture(),remote=await serve(t,hub);
  const builderId=randomUUID(),declarationId=randomUUID(),declaration=hubDeclaration(hub.manifest.data);
  const signed=await f.authorize({id:declarationId,builderId,kind:'declare',expectedRevision:0,declaration},'builder.publish',{visibility:'Public',purpose:'public-profile'});
  await f.builders.publish(f.actor,signed);
  const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  sessions.adopt({endpoint:f.bindings.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes:['binding','consent','builders'],expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  const hubTrustedKeys=new Map();let reads=0,afterRead=async()=>{};
  const client=createBuilderClient({endpoint:f.bindings.endpoint,sessions,send:registry.post,trustedKeys:f.bindings.trustedKeys,hubTrustedKeys,now:()=>f.now,
    readHubManifest:async(url,options)=>{reads++;assert.equal(url,declaration.manifest.url);assert.deepEqual(Object.keys(options),['signal']);const value=await remote.get(url,options);await afterRead();return value;}});
  const input={builderId,declarationId,manifestSha256:declaration.manifest.sha256};
  await assert.rejects(client.verifyHub(input));assert.equal(reads,0);
  hubTrustedKeys.set(declaration.endpoint,f.bindings.trustedKeys);await assert.rejects(client.verifyHub(input));assert.equal(reads,1);
  hubTrustedKeys.set(declaration.endpoint,hub.bindings.trustedKeys);
  const matched=await client.verifyHub(input);assert.equal(matched.directoryState,'matched');assert.equal(matched.connected,false);assert.equal(matched.capabilityVerified,false);
  afterRead=async()=>{hub.bindings.trustedKeys.get('hub-fixture').revoked=true;};
  await assert.rejects(client.verifyHub(input),/trust changed/);hub.bindings.trustedKeys.get('hub-fixture').revoked=false;
  const abort=new AbortController();afterRead=async()=>abort.abort();await assert.rejects(client.verifyHub(input,{signal:abort.signal}));
  afterRead=async()=>{const current=await f.builders.get(f.actor,{builderId});const grant=await f.authorize({id:randomUUID(),builderId,kind:'maintenance',expectedRevision:current.revision,declarationId,action:'delist',summary:'Fixture listing withdrawn'},'builder.publish',{visibility:'Public',purpose:'public-profile'});await f.builders.publish(f.actor,grant);};
  await assert.rejects(client.verifyHub(input),/changed/);
  const before=reads;await assert.rejects(client.verifyHub(input));assert.equal(reads,before);
  assert.equal((await f.builders.get(f.actor,{builderId})).registration.state,'delisted');
});
