import {nativeData} from '../../packages/galaxy-edge-mcp/test/native-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

test('real stdio TrustPackage choice writes six exact local files and imports offline without any fetch',{timeout:45000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-trust-stdio-'));let child,reviewUrl;
 try {
  const dataDirectory=join(directory,'data'),pair=generateKeyPairSync('ed25519'),now=Math.floor(Date.now()/1000),configPath=join(directory,'public-config.json');
  await writeFile(configPath,JSON.stringify({version:2,endpoint:'https://never-connected.example',website:'https://selected.example',dataDirectory,
   trustedKeys:{fixture:{publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),notBefore:now-10,notAfter:now+1000,revoked:false}}}));
  const guard=join(directory,'no-network.mjs');await writeFile(guard,"globalThis.fetch=async()=>{process.stderr.write('UNEXPECTED_NETWORK');throw new Error('no network allowed');};");
  const entry=join(directory,'stdio-entry.mjs');await writeFile(entry,`import {startNativeStdio} from ${JSON.stringify(pathToFileURL(resolve('packages/galaxy-edge-mcp/src/native-v2/stdio.mjs')).href)};try{await startNativeStdio();}catch(e){process.stderr.write(e.stack);process.exitCode=1;}`);
  child=spawn(process.execPath,['--import',pathToFileURL(guard).href,entry],{cwd:directory,windowsHide:true,
   stdio:['pipe','pipe','pipe'],env:{...process.env,GALAXY_NATIVE_CONFIG:configPath}});
  let seq=0,buffer='',stderr='';const outstanding=new Map();child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const text=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!text)continue;
   const message=JSON.parse(text),p=outstanding.get(message.id);if(p){outstanding.delete(message.id);clearTimeout(p.timer);p.resolve(message);}}});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;outstanding.set(id,{resolve,timer:setTimeout(()=>reject(new Error('stdio timeout '+stderr)),10000)});
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const call=async(name,args={})=>{const response=await rpc('tools/call',{name,arguments:args});assert.ok(!response.error,JSON.stringify(response.error));
   const result=nativeData(response.result);assert.ok(!response.result.isError,JSON.stringify(result));return result;};
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-independent-trust-client',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const listed=await rpc('tools/list');assert.equal(listed.result.tools.filter(t=>t.name.startsWith('galaxy_trust_native_')).length,9);
  async function choose(name,args,action='allow'){
   const response=await call(name,args);assert.equal(response.state,'user-choice-needs-browser');reviewUrl=response.url;
   const html=await(await fetch(reviewUrl)).text();assert.ok(!html.includes('PRIVATE KEY'));
   assert.equal((await fetch(reviewUrl,{method:'POST',headers:{Origin:new URL(reviewUrl).origin,'Content-Type':'application/x-www-form-urlencoded'},body:'action='+action})).status,200);
   return call(name,args);
  }
  const initialized=await choose('galaxy_native_initialize',{profile:'minimal'});assert.equal(initialized.localOnly,true);
  const data={action:'package',claims:[{id:randomUUID(),text:'Synthetic newcomer self assertion; not a production claim',authority:'self-asserted',capabilityVerified:false}],
   audience:{kind:'subjects',subjectIds:[initialized.identity]},expiresAt:now+3600};
  const declined=await call('galaxy_trust_native_prepare',data);assert.equal((await choose('galaxy_trust_native_execute',{operationId:declined.operationId},'decline')).state,'declined');
  await assert.rejects(stat(join(dataDirectory,'trust-packages')),{code:'ENOENT'});
  await call('galaxy_trust_native_cancel_preview',{operationId:declined.operationId});
  const prepared=await call('galaxy_trust_native_prepare',data),exported=await choose('galaxy_trust_native_execute',{operationId:prepared.operationId});
  assert.equal(exported.files.length,6);assert.equal(exported.remotePublished,false);assert.equal(exported.privateKeyExported,false);
  const path=exported.files.find(p=>p.endsWith('galaxy-trust-package.json')),container=JSON.parse(await readFile(path,'utf8'));
  const imported=await call('galaxy_trust_native_import',{package:container});assert.equal(imported.integrity,'valid');assert.equal(imported.capabilityVerified,false);assert.equal(imported.currentRevocationChecked,false);
  const replay=await call('galaxy_trust_native_execute',{operationId:prepared.operationId});assert.equal(replay.state,'completed');assert.deepEqual(replay.receipt.files,exported.files);
  const vcPrepared=await call('galaxy_trust_native_prepare',{action:'vc-package',package:container});
  const vcExported=await choose('galaxy_trust_native_execute',{operationId:vcPrepared.operationId});
  assert.equal(vcExported.files.length,8);assert.equal(vcExported.issuerAuthority,'self-issued-package-attestation');
  assert.equal(vcExported.currentStatus,'unknown');assert.equal(vcExported.capabilityVerified,false);
  const bundle=JSON.parse(await readFile(vcExported.files.find(p=>/galaxy-trust-vc-jose-[a-f0-9]+\.json$/.test(p)),'utf8'));
  assert.deepEqual(bundle.package,container);assert.equal(bundle.mediaType,'application/vc+jwt');
  const manifest=JSON.parse(container.manifestJson),identity=JSON.parse(container.files['identity.json']);
  const importInput={bundle,issuerPin:{issuer:manifest.subjectId,kid:manifest.keyId,publicKeyPem:identity.genesisProof.publicKeyPem},
   audience:manifest.subjectId,expectedSubject:manifest.subjectId};
  const vcImported=await choose('galaxy_trust_native_import_vc',importInput);
  assert.equal(vcImported.integrity,'valid');assert.equal(vcImported.networkRequests,0);assert.equal(vcImported.importedBusinessFacts,0);
  assert.equal(vcImported.currentRevocationChecked,false);assert.equal(vcImported.onlineAccessGranted,false);
  const vcReplay=await call('galaxy_trust_native_execute',{operationId:vcPrepared.operationId});
  assert.equal(vcReplay.state,'completed');assert.deepEqual(vcReplay.receipt.files,vcExported.files);
  assert.deepEqual((await call('galaxy_trust_native_recover',{action:'last-vc-export'})).bundle,bundle);
  const wrongPin={...importInput,issuerPin:{...importInput.issuerPin,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})}};
  const wrongPreview=await call('galaxy_trust_native_import_vc',wrongPin);
  assert.equal(wrongPreview.state,'user-choice-needs-browser');
  await fetch(wrongPreview.url,{method:'POST',headers:{Origin:new URL(wrongPreview.url).origin,'Content-Type':'application/x-www-form-urlencoded'},body:'action=allow'});
  const rejected=await rpc('tools/call',{name:'galaxy_trust_native_import_vc',arguments:wrongPin});
  assert.equal(rejected.result.isError,true,'a reviewed wrong issuer key still cannot validate the signature');
  const state=await call('galaxy_native_status');assert.equal(state.connected,false);assert.equal(stderr.includes('UNEXPECTED_NETWORK'),false);
  child.stdin.end();if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));child=null;await assert.rejects(fetch(reviewUrl));
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await rm(directory,{recursive:true,force:true});}
});
