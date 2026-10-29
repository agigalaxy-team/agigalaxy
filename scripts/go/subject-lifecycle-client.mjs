// Independent takeout/deletion SDK client against a disposable Go HTTP server.
import assert from 'node:assert/strict';
import {createPrivateKey} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {CompactSign} from 'jose';
import {createConnectionClient} from '../../packages/galaxy-client/src/node/connection.mjs';
import {createDataExportClient} from '../../packages/galaxy-client/src/node/data-export.mjs';
import {createDeletionClient,createDeletionStatusClient} from '../../packages/galaxy-client/src/node/deletion.mjs';
import {ownerExportDatasets} from '../../packages/galaxy-contracts/src/data-export-schema.mjs';
import {digest} from '../../packages/galaxy-contracts/src/digest.mjs';
const dir=process.env.GALAXY_GO_TEST_DEVICE_DIR,rel=dir&&relative(resolve(tmpdir()),resolve(dir));if(!dir||!isAbsolute(dir)||!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('temporary fixture required');
const origin=new URL(process.env.GALAXY_GO_TEST_DEVICE_ORIGIN??'');if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:')throw Error('loopback only');
const state=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8')),ownerKey=createPrivateKey(state.ownerPrivate),endpoint='https://device.example.invalid',now=()=>2000000000;
const trustedKeys=new Map([['fixture',{publicKeyPem:state.hubPublic,notBefore:now()-100,notAfter:now()+100000}]]),sign=(p,t)=>new CompactSign(new TextEncoder().encode(p)).setProtectedHeader({alg:'Ed25519',typ:t}).sign(ownerKey);
const send=async(url,{bodyJson,credential})=>{const response=await fetch(origin.origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:bodyJson});const result=await response.json();if(!response.ok){const e=Error(result.error);e.status=response.status;throw e}return result};
const mode=process.argv[2];
if(mode==='client'){
 const scopes=['binding','history','data-export','data-delete'],client=createConnectionClient({endpoint,trustedKeys,now,assertCurrent:async()=>true,sign,send});
 const preview=client.prepare({subjectId:state.genesis.id,genesisProof:state.genesis.genesisProof,installationId:state.installationId,scopes,control:{deviceId:state.deviceId,keyId:digest(state.publicKeyPem),epoch:1}}),connected=await client.execute(preview,preview.confirmation),credential=connected.takeCredential();await writeFile(join(dir,'credential.txt'),credential,{mode:0o600});
 const actor={subjectId:connected.subjectId,bindingId:connected.bindingId,scopes,credential,bindingExpiresAt:connected.bindingExpiresAt,expiresAt:connected.expiresAt},sessions={readAuthorization:async()=>actor,isAuthorizationCurrent:async()=>true,matchesAuthorization:()=>true};
 const exporter=createDataExportClient({endpoint,sessions,send,now}),spec=await exporter.specification();assert.deepEqual(spec.datasets,ownerExportDatasets);
 const ticket=await exporter.create({datasets:['identity','reading-bookmarks','bindings']}),first=await exporter.page({id:ticket.id,dataset:'reading-bookmarks',limit:1});assert.equal(first.items.length,1);assert.ok(first.nextAfter);await exporter.page({id:ticket.id,dataset:'identity'});await exporter.page({id:ticket.id,dataset:'bindings'});
 let requestSigned;const deletion=createDeletionClient({endpoint,sessions,signIntent:async(p,t)=>{const signed=await sign(p,t);if(JSON.parse(p).action==='request')requestSigned=signed;return signed},send,now});
 const request=await deletion.prepare({action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'}),receipt=await deletion.execute(request,request.confirmation);assert.equal(receipt.physicalDeletionPerformed,false);assert.equal(receipt.serviceWideDeletionComplete,false);
 const detail=await deletion.read({id:receipt.id});assert.equal(detail.events.length,1);assert.equal(detail.events[0].signer_control_chain.events.length,1);
 const cancellation=await deletion.prepare({action:'cancel',requestId:receipt.id,expectedRevision:receipt.revision});await deletion.execute(cancellation,cancellation.confirmation);assert.equal((await deletion.read({id:receipt.id})).events.length,2);assert.equal((await deletion.query()).items.length,1);const replay=await send(endpoint+'/v1/deletion-requests/submit',{bodyJson:JSON.stringify({signed:requestSigned}),credential});assert.equal(replay.state,'cancelled');assert.equal(replay.revision,2);
 await writeFile(join(dir,'resume.json'),JSON.stringify({ticket,after:first.nextAfter,requestId:receipt.id,bindingId:connected.bindingId}),{mode:0o600});
}else if(mode==='resume'){
 const saved=JSON.parse(await readFile(join(dir,'resume.json'),'utf8')),credential=await readFile(join(dir,'credential.txt'),'utf8');const read=await send(endpoint+'/v1/data-exports/page',{bodyJson:JSON.stringify({id:saved.ticket.id,dataset:'reading-bookmarks',after:saved.after,limit:1}),credential});assert.equal(read.items.length,1);assert.equal(read.nextAfter,null);const {sha256,...snapshot}=read;assert.equal(digest(JSON.stringify(snapshot)),sha256);
}else if(mode==='status'){
 const saved=JSON.parse(await readFile(join(dir,'resume.json'),'utf8')),client=createDeletionStatusClient({endpoint,readSubjectId:async()=>state.genesis.id,signIntent:sign,send,now}),preview=await client.prepare({requestId:saved.requestId}),status=await client.execute(preview,preview.confirmation);assert.equal(status.state,'cancelled');assert.equal(status.holderProofVerified,true);
}else throw Error('unknown client mode');
console.log(JSON.stringify({mode,ok:true}));
