// Independent SDK wire clients against a caller-owned disposable Go HTTP server.
import {createPrivateKey,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {CompactSign} from 'jose';
import {createConnectionClient} from '../../packages/galaxy-client/src/node/connection.mjs';
import {createReceiptStatusClient,createReceiptStatusDeviceSigner} from '../../packages/galaxy-client/src/clients/receipt-status.mjs';
import {digest} from '../../packages/galaxy-contracts/src/digest.mjs';
import {consentSchema} from '../../packages/galaxy-contracts/src/consents-schema.mjs';
if(process.argv[2]==='consent-schema'){let text='';for await(const chunk of process.stdin)text+=chunk;console.log(JSON.stringify(JSON.parse(text).map(v=>consentSchema.safeParse(v).success)));process.exit(0)}
const dir=process.env.GALAXY_GO_TEST_DEVICE_DIR,rel=dir&&relative(resolve(tmpdir()),resolve(dir));
if(!dir||!isAbsolute(dir)||!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('disposable directory required');
const origin=new URL(process.env.GALAXY_GO_TEST_DEVICE_ORIGIN??'');if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:')throw Error('loopback HTTP required');
const state=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8')),ownerKey=createPrivateKey(state.ownerPrivate),endpoint='https://device.example.invalid',now=()=>2000000000;
const trustedKeys=new Map([['fixture',{publicKeyPem:state.hubPublic,notBefore:now()-100,notAfter:now()+100000}]]);
const sign=(payload,typ)=>new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(ownerKey);
const mode=process.argv[2];
if(mode==='client'||mode==='client-consent'){
 const paths=[];const client=createConnectionClient({endpoint,trustedKeys,now,assertCurrent:async()=>true,sign,send:async(url,{bodyJson})=>{const path=new URL(url).pathname;paths.push(path);const res=await fetch(origin.origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:bodyJson});const result=await res.json();if(!res.ok)throw Error(JSON.stringify(result));return result;}});
 const preview=client.prepare({subjectId:state.genesis.id,genesisProof:state.genesis.genesisProof,installationId:state.installationId,scopes:mode==='client-consent'?['binding','history','consent']:['binding','history'],control:{deviceId:state.deviceId,keyId:digest(state.publicKeyPem),epoch:1}});
 const result=await client.execute(preview,preview.confirmation),credential=result.takeCredential();await writeFile(join(dir,'credential.txt'),credential,{mode:0o600});await writeFile(join(dir,'connection.json'),JSON.stringify({bindingId:result.bindingId}),{mode:0o600});console.log(JSON.stringify({subjectId:result.subjectId,bindingId:result.bindingId,deviceId:result.control.deviceId,controlEpoch:result.control.epoch,paths}));
}else if(mode==='receipt-client'){
 const operation=JSON.parse(await readFile(join(dir,'receipt-locator.json'),'utf8')),context={subjectId:state.genesis.id,control:{deviceId:state.deviceId,keyId:digest(state.publicKeyPem),epoch:1}};
 const cryptoKey=await crypto.subtle.importKey('pkcs8',ownerKey.export({format:'der',type:'pkcs8'}),{name:'Ed25519'},false,['sign']);
 const signer=createReceiptStatusDeviceSigner({endpoint,trustedKeys,now,getContext:async()=>context,getPrivateKey:async()=>cryptoKey});let calls=0;
 const client=createReceiptStatusClient({endpoint,trustedKeys,now,getContext:async()=>context,signReceiptStatus:signer,fetch:async(url,init)=>{calls++;if(init.credentials!=='omit'||init.headers.Authorization||init.headers.Cookie)throw Error('receipt used ordinary authentication');return fetch(origin.origin+new URL(url).pathname,init)}});const result=await client.query(operation);console.log(JSON.stringify({result,calls}));
}else if(mode==='js-consent-create'){
 const token=await readFile(join(dir,'credential.txt'),'utf8'),connection=JSON.parse(await readFile(join(dir,'connection.json'),'utf8'));
 const payloadJson=JSON.stringify({title:'original JavaScript grant'}),intent={version:1,id:randomUUID(),subjectId:state.genesis.id,bindingId:connection.bindingId,endpoint,objectId:'original-js-query',action:'history.query',purpose:'operational',recipient:endpoint,fields:['title'],visibility:'Private',viewers:[state.genesis.id],payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:now(),expiresAt:now()+600};
 const signedIntent=await sign(JSON.stringify(intent),'galaxy-consent+jws'),response=await fetch(origin.origin+'/v1/consents',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({signedIntent})});if(!response.ok)throw Error('consent HTTP '+response.status);const grant=await response.json();console.log(JSON.stringify({id:grant.consentId,subjectId:intent.subjectId,action:intent.action,objectId:intent.objectId,recipient:endpoint,payloadJson}));
}else throw Error('unknown client mode');
