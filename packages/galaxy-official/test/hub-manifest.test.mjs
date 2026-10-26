import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManifestService,verifyManifest,verifyHubManifest,hubManifestDigest,validateHubManifest } from '../src/manifest.mjs';
import { verifyHubDirectoryManifest } from "../src/clients/builder.mjs";
import { loadNetworkProfile } from "../src/network/network-profile.mjs";
import { runtimeConfigSnapshot,recordRuntimeConfig,verifyRuntimeConfigEvent } from '../src/operations/runtime-config-audit.mjs';
import { createApi } from '../src/http.mjs';
import { hubManifestFixture,hubDeclaration,hubProfile } from './hub-manifest-fixture.mjs';
import { serviceFixture } from './service-fixture.mjs';

test('Hub HTTP Manifest has an explicit profile and stable JCS directory digest across refreshes',async t=>{
  const f=hubManifestFixture(),api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));});
  const url=`http://127.0.0.1:${api.address().port}/.well-known/galaxy-network.json`;
  const first=await fetch(url),document=await first.json(),options={endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys,now:f.bindings.now()};
  const verified=await verifyHubManifest(document,options),declaration=hubDeclaration(verified.data);
  assert.equal(verified.profile,'galaxy-hub/1');assert.equal(verified.connected,false);assert.equal(verified.authorized,false);
  const matched=await verifyHubDirectoryManifest(document,{...options,declaration});
  assert.equal(matched.directoryState,'matched');assert.equal(matched.directoryOwnerVerified,false);assert.equal(matched.capabilityVerified,false);
  const reversed=Object.fromEntries(Object.entries(verified.data).reverse());
  reversed.hub=Object.fromEntries(Object.entries(reversed.hub).reverse());
  assert.equal(hubManifestDigest(reversed),verified.manifestSha256);
  assert.equal((await fetch(url,{headers:{'If-None-Match':first.headers.get('etag')}})).status,304);
  f.setTime(options.now+61);const second=await fetch(url),refreshed=await second.json();
  assert.notEqual(refreshed.signed,document.signed);assert.notEqual(first.headers.get('etag'),second.headers.get('etag'));
  assert.equal((await verifyHubManifest(refreshed,{...options,now:f.bindings.now()})).manifestSha256,verified.manifestSha256);
  for(const modified of [{name:'Another name'},{operator:'Another operator'},{region:'Another region'},
    {charter:'https://other.example.org/charter'},{scope:'Another scope'},{policy:'https://hub.example.org/other'},
    {exit:'Another exit'},{export:'Another export'},{release:{...declaration.release,version:'9.0.0'}},
    {manifest:{...declaration.manifest,sha256:'0'.repeat(64)}}]){
    const checked=await verifyHubDirectoryManifest(document,{...options,declaration:{...declaration,...modified}});
    assert.equal(checked.directoryState,'mismatch');assert.equal(checked.differences.length,1);
  }
  await assert.rejects(verifyManifest(document,{...options,networkType:'hub'}));
  await assert.rejects(verifyHubManifest(document,{...options,trustedKeys:new Map()}));
  await assert.rejects(verifyHubManifest(document,{...options,now:options.now+300}));
  await assert.rejects(verifyHubDirectoryManifest(document,{...options,declaration:{...declaration,manifest:{...declaration.manifest,specVersion:'future/9'}}}));
  await assert.rejects(verifyHubDirectoryManifest(document,{...options,declaration:{...declaration,manifest:{...declaration.manifest,url:f.bindings.endpoint+'/other'}}}));
  const tampered=document.signed.split('.');const data=JSON.parse(Buffer.from(tampered[1],'base64url'));data.data.operator='Tampered';tampered[1]=Buffer.from(JSON.stringify(data)).toString('base64url');
  await assert.rejects(verifyHubManifest({signed:tampered.join('.')},options));
  const official=new ManifestService({bindings:f.bindings,operator:'Test',region:'test'});
  await assert.rejects(verifyHubManifest((await official.get()).document,{...options,now:f.bindings.now(),networkType:'official'}));
});

test('network profile file selects Hub explicitly and runtime audit retains old records',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-hub-profile-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'profile.json');
  assert.deepEqual(await loadNetworkProfile(undefined),{networkType:'official'});
  await writeFile(path,JSON.stringify(hubProfile));assert.deepEqual(await loadNetworkProfile(path),hubProfile);
  await writeFile(path,JSON.stringify({...hubProfile,endpoint:'https://unapproved.example.org'}));await assert.rejects(loadNetworkProfile(path));
  await writeFile(path,JSON.stringify({networkType:'official',hub:hubProfile.hub}));await assert.rejects(loadNetworkProfile(path));
  const h=hubManifestFixture();
  for(const hub of [{...hubProfile.hub,profile:'future/9'},{...hubProfile.hub,charter:'https://localhost/charter'},{...hubProfile.hub,exit:''}])
    assert.throws(()=>validateHubManifest({...h.manifest.data,hub},h.bindings.endpoint));
  const f=await serviceFixture(['binding'],null,{manifestProfile:hubProfile,endpoint:h.bindings.endpoint});t.after(()=>f.db.close());
  assert.equal(f.manifest.data.networkType,'hub');
  const before=await recordRuntimeConfig(f.db,{endpoint:h.bindings.endpoint,component:'api',snapshot:runtimeConfigSnapshot({})});
  const network={type:'hub',manifestSha256:hubManifestDigest(f.manifest.data)};
  const after=await recordRuntimeConfig(f.db,{endpoint:h.bindings.endpoint,component:'api',snapshot:runtimeConfigSnapshot({network})});
  assert.deepEqual(after.payload.changes.changedSections,['network']);assert.deepEqual(after.payload.snapshot.network,network);
  verifyRuntimeConfigEvent(before);verifyRuntimeConfigEvent(after);
});
