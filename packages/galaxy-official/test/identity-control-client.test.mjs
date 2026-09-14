import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BindingService} from '../src/bindings.mjs';
import {AccessService} from '../src/access.mjs';
import {createConnectionClient} from '../src/connection-client.mjs';
import {IdentityControlService} from '../src/identity-control.mjs';
import {createApi} from '../src/http.mjs';
import {createIdentityControlClient} from '../../galaxy-core/src/domain/identity-control-client.mjs';
import {createDeviceMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {createBrowserGenesis} from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';

test('browser-compatible client uses actual HTTP, waits for confirmation, resumes lost response and cancels pending signing',async()=>{
  const db=new PGlite(),endpoint='https://official.example.org',now=2000000000,server=generateKeyPairSync('ed25519');
  let api;
  try{
    await migrate(db);
    const trustedKeys=new Map([['test',{publicKeyPem:server.publicKey.export({format:'pem',type:'spki'}),notBefore:now-1,notAfter:now+864000,revoked:false}]]);
    const bindings=new BindingService({db,endpoint,signingKey:server.privateKey,kid:'test',trustedKeys,now:()=>now});
    const access=new AccessService(bindings);
    const identityControl=new IdentityControlService({db,endpoint,allowedScopes:['binding'],now:()=>now});
    api=createApi({bindings,access,identityControl,rateLimit:300});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const local=`http://127.0.0.1:${api.address().port}`,journal=new Map(),store={get:async id=>structuredClone(journal.get(id)),put:async(id,value)=>{journal.set(id,structuredClone(value));}};
    let calls=0,signs=0,drop=false;
    const send=async(url,input)=>{calls++;const response=await fetch(local+new URL(url).pathname,{method:input.method??'POST',headers:{'Content-Type':'application/json'},body:input.bodyJson});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      if(drop&&url.endsWith('/commit')){drop=false;throw new Error('Synthetic lost HTTP response after committed write');}return result;};
    const device=await createDeviceMaterial(),genesis=await createBrowserGenesis({publicKeyPem:device.publicKeyPem,originCode:'5'});
    const request={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:genesis.id,expectedEpoch:0,previousEventHash:null,
      signerKeyId:await identityKeyId(device.publicKeyPem),genesisProof:genesis.genesisProof,newDevice:{deviceId:device.deviceId,publicKeyPem:device.publicKeyPem,scopes:['manage-identity','binding']}};
    const options={endpoint,send,store,now:()=>now,signController:async challenge=>{signs++;return signIdentityPayload(challenge,device.privateKey);},signNewDevice:challenge=>signIdentityPayload(challenge,device.privateKey)};
    const client=createIdentityControlClient(options),preview=await client.prepare(request);
    assert.equal(signs,0);await assert.rejects(client.confirm(preview),/Confirm/);assert.equal(signs,0);
    drop=true;await assert.rejects(client.confirm(preview,{confirmed:true}),/lost HTTP/);assert.equal(signs,1);
    const restarted=createIdentityControlClient(options),result=await restarted.status(request.operationId);assert.equal(result.state,'committed');assert.equal(result.epoch,1);
    assert.deepEqual(await restarted.retry(request.operationId,{confirmed:true}),result);assert.equal(signs,1,'retry sends the same saved signatures');
    const connection=createConnectionClient({endpoint,trustedKeys,send,now:()=>now,assertCurrent:async()=>true,
      sign:(payload,type)=>signIdentityPayload(payload,device.privateKey,{type})});
    const bindPreview=connection.prepare({subjectId:genesis.id,genesisProof:genesis.genesisProof,installationId:randomUUID(),scopes:['binding'],
      control:{deviceId:device.deviceId,keyId:request.signerKeyId,epoch:1}});
    const bound=await connection.execute(bindPreview,bindPreview.confirmation);
    assert.equal((await access.authenticate(bound.takeCredential())).deviceId,device.deviceId);
    const before=calls;await assert.rejects(client.prepare({...request,operationId:randomUUID(),recoveryCode:'galaxy-recovery-v1:secret'}),/public identity/);assert.equal(calls,before);
    const changed=createIdentityControlClient({...options,send:async(url,input)=>{const result=await send(url,input);const challenge=JSON.parse(result.challenge);challenge.request.newDevice.scopes=[];return {...result,challenge:JSON.stringify(challenge)};}});
    await assert.rejects(changed.prepare({...request,operationId:randomUUID()}),/changed/);assert.equal(signs,1);
    let release,entered;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const waiting=createIdentityControlClient({...options,signController:async challenge=>{entered();await gate;return signIdentityPayload(challenge,device.privateKey);}});
    const another=await createDeviceMaterial(),addition={version:2,kind:'authorize-device',operationId:randomUUID(),subjectId:genesis.id,expectedEpoch:1,previousEventHash:result.chainHead,
      signerKeyId:request.signerKeyId,newDevice:{deviceId:another.deviceId,publicKeyPem:another.publicKeyPem,scopes:['binding']}};
    const pending=await waiting.prepare(addition),confirm=waiting.confirm(pending,{confirmed:true});await started;
    assert.equal((await waiting.cancel(pending)).state,'canceled');release();await assert.rejects(confirm,/canceled/);
    assert.equal((await identityControl.publicState(genesis.id)).devices.length,1);
    assert.equal((await db.query('SELECT state FROM identity_control_operations WHERE id=$1',[addition.operationId])).rows[0].state,'requested','local cancellation creates no signed mutation');
  }finally{if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await db.close();}
});
