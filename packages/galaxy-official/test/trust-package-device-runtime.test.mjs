import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createNativeRuntime} from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {verifyTrustPackage} from "../src/verification/trust-package.mjs";
import {createTrustPackageDeviceAdapter} from "../src/clients/trust-package-device-adapter.mjs";

test('real native and WebCrypto device runtimes export offline self-claims before or after explicit connection without replacing identity',async()=>{
 const f=await serviceFixture([...browserScopes]),directory=await mkdtemp(join(tmpdir(),'galaxy-trust-runtime-'));
 let native,web,api,requests=0;
 try{
  api=createApi({...f,rateLimit:1000});await new Promise(r=>api.listen(0,'127.0.0.1',r));
  const address='http://127.0.0.1:'+api.address().port;
  const fetcher=(url,options)=>{requests++;const u=new URL(url);return fetch(address+u.pathname+u.search,options);};
  const config={endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys};
  const claim=()=>({claims:[{id:randomUUID(),text:'Synthetic newcomer offers a parser review, without a verified work history.',authority:'self-asserted',capabilityVerified:false}],
   selections:[],audience:{kind:'public'},expiresAt:f.now+3600});
  async function exportOffline(runtime,expectedId,epoch){
   const before=requests,preview=await runtime.trustPackages.prepare(claim());
   assert.equal(preview.state,'ready');
   await assert.rejects(runtime.trustPackages.exportPackage(preview),/trust_preview_required/);
   const result=await runtime.trustPackages.exportPackage(preview,{confirmed:true});
   const checked=await verifyTrustPackage(result.container,{now:f.now});
   assert.equal(requests,before,'self-claims use only local identity and signed cached history');
   assert.equal(checked.subjectId,expectedId);assert.equal(JSON.parse(result.container.manifestJson).epoch,epoch);
   assert.equal(checked.currentRevocationChecked,false);assert.equal(checked.capabilityVerified,false);
   assert.equal(result.remotePublished,false);assert.equal(result.localSaved,true);
   await assert.rejects(runtime.trustPackages.exportPackage(preview,{confirmed:true}),/trust_preview_required/);
   return result;
  }
  native=await createNativeRuntime({...config,dataDirectory:directory,website:'https://galaxy.example',fetch:fetcher,now:()=>f.now});
  await native.initialize({profile:'coding-case'},{confirmed:true});const id=(await native.status()).identity;
  await exportOffline(native,id,0);assert.equal(requests,0);
  await native.connect({confirmed:true});await native.disconnect();await exportOffline(native,id,1);
  await native.close();native=await createNativeRuntime({...config,dataDirectory:directory,website:'https://galaxy.example',fetch:fetcher,now:()=>f.now});
  await exportOffline(native,id,1);
  const records=new Map(),store={get:async key=>records.get(key),put:async(key,value)=>records.set(key,value),update:memoryAtomicUpdate(records)};
  web=await createExistingWebRuntime(config,{store,fetch:fetcher,now:()=>f.now});
  await web.connect({confirmed:true});const browserId=(await web.status()).identity.subjectId;
  await web.disconnect();await exportOffline(web,browserId,1);
  const before=requests;await web.trustPackages.refreshIdentity();assert.ok(requests>before,'refresh is an explicit network operation');
  await exportOffline(web,browserId,1);
  const adapter=createTrustPackageDeviceAdapter({endpoint:config.endpoint,getMaterial:()=>null,readIdentity:()=>null,writeIdentity:()=>{},fetchIdentity:()=>{throw Error('unexpected network');}});
  await assert.rejects(adapter.sign('unrelated','galaxy-identity-control-v2+jws',{}),/trust_signature_type_forbidden/);
 }finally{
  await native?.close();web?.close();if(api)await new Promise(r=>api.close(r));await f.db.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.split(sep).at(-1).startsWith('galaxy-trust-runtime-'));
  await rm(target,{recursive:true,force:true});
 }
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
