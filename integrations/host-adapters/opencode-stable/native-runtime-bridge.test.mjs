import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {createNativeRuntimeBridge} from './native-runtime-bridge.mjs';
import {nativeData} from '../../../packages/galaxy-edge-mcp/test/native-result.mjs';

test('ordinary OpenCode bridge loads the actual Native entry, keeps one real choice and leaves identity disconnected',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-opencode-bridge-')),configPath=join(directory,'public.json'),dataDirectory=join(directory,'data');
 const bridge=createNativeRuntimeBridge({configPath});let review;
 const before=['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal));
 try{
  await assert.rejects(bridge.call('galaxy_native_status'),{code:'native_configuration_not_found'});
  await assert.rejects(stat(dataDirectory),{code:'ENOENT'});
  const now=Math.floor(Date.now()/1000),key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  await writeFile(configPath,JSON.stringify({version:2,website:'https://selected.invalid',endpoint:'https://not-connected.invalid',dataDirectory,
   trustedKeys:{synthetic:{publicKeyPem:key,notBefore:now-1,notAfter:now+3600,revoked:false}}}));
  const statuses=await Promise.all([bridge.call('galaxy_native_status'),bridge.call('galaxy_native_status')]);
  for(const status of statuses){assert.equal(nativeData(status).connected,false);assert.equal(nativeData(status).identity,null);}
  await assert.rejects(stat(dataDirectory),{code:'ENOENT'});
  const invalid=await bridge.call('galaxy_native_initialize',{profile:'minimal',confirmed:true});assert.equal(invalid.isError,true,'A model-supplied confirmed flag is never a choice.');
  const canceled=nativeData(await bridge.call('galaxy_native_initialize',{profile:'minimal'}));assert.equal(canceled.state,'user-choice-needs-browser');
  const declined=await fetch(canceled.url,{method:'POST',headers:{origin:new URL(canceled.url).origin,'content-type':'application/x-www-form-urlencoded'},body:'action=decline'});assert.equal(declined.status,200);
  const declinedResult=nativeData(await bridge.call('galaxy_native_initialize',{profile:'minimal'}));assert.equal(declinedResult.state,'declined');
  await assert.rejects(stat(dataDirectory),{code:'ENOENT'});
  const initial=nativeData(await bridge.call('galaxy_native_initialize',{profile:'minimal'}));assert.equal(initial.state,'user-choice-needs-browser');review=initial.url;
  assert.notEqual(review,canceled.url,'An explicit new choice cannot reuse the canceled page.');
  assert.match(await(await fetch(canceled.url)).text(),/已取消，本次操作没有获得授权/,'The exact canceled page stays readable.');
  const again=nativeData(await bridge.call('galaxy_native_initialize',{profile:'minimal'}));assert.equal(again.url,review,'Polling resumes the same actual loopback choice.');
  const response=await fetch(review,{method:'POST',headers:{origin:new URL(review).origin,'content-type':'application/x-www-form-urlencoded'},body:'action=allow'});assert.equal(response.status,200);
  const created=nativeData(await bridge.call('galaxy_native_initialize',{profile:'minimal'}));assert.equal(created.localOnly,true);
  const identity=JSON.parse(await readFile(join(dataDirectory,'galaxy-id.json'),'utf8'));assert.equal(identity.id,created.identity);
  const status=nativeData(await bridge.call('galaxy_native_status'));assert.equal(status.identity,created.identity);assert.equal(status.connected,false);
  assert.equal(nativeData(await bridge.call('galaxy_native_status')).identity,created.identity,'Ordinary reading keeps the original identity without preparing another choice.');
  const closing=bridge.close();assert.equal(closing,bridge.close());await closing;await assert.rejects(fetch(review));await assert.rejects(bridge.call('galaxy_native_status'),/native_bridge_closed/);
  assert.deepEqual(['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal)),before);
 }finally{await bridge.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-opencode-bridge-'));await rm(target,{recursive:true,force:true});}
});
