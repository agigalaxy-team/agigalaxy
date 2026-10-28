// Isolated original-JS control/binding/client interop for the Go session authority.
process.stdin.setEncoding('utf8');
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {generateKeyPairSync,randomUUID,createPrivateKey} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {CompactSign} from '../../packages/galaxy-official/node_modules/jose/dist/webapi/index.js';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {createGalaxyGenesis} from '../../packages/galaxy-core/src/galaxy-guid.mjs';
import {IdentityControlService} from '../../packages/galaxy-official/src/identity/control.mjs';
import {BindingService} from '../../packages/galaxy-official/src/identity/bindings.mjs';
import {AccessService} from '../../packages/galaxy-official/src/security/access.mjs';
import {createConnectionClient} from '../../packages/galaxy-official/src/clients/connection.mjs';
import {issueKeyring} from '../../packages/galaxy-official/src/security/trust-keyring.mjs';
import {ConsentService} from '../../packages/galaxy-official/src/consents/consents.mjs';
import {ConsentReader} from '../../packages/galaxy-official/src/consents/consent-reader.mjs';
import {verifyIdentityControlChain} from '../../packages/galaxy-official/src/verification/identity-control.mjs';
import {createReceiptStatusClient,createReceiptStatusDeviceSigner} from '../../packages/galaxy-official/src/clients/receipt-status.mjs';
import {verifyKeyring} from '../../packages/galaxy-official/src/verification/keyring.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
import {consentSchema} from '../../packages/galaxy-official/src/shared/consents-schema.mjs';
if(process.argv[2]==='consent-schema'){let text='';for await(const chunk of process.stdin)text+=chunk;console.log(JSON.stringify(JSON.parse(text).map(v=>consentSchema.safeParse(v).success)));process.exit(0)}
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated test database required');
const dir=process.env.GALAXY_GO_TEST_DEVICE_DIR;if(!isAbsolute(dir??''))throw Error('absolute disposable test directory required');
const db=new pg.Pool({connectionString:address.href,max:2}),endpoint='https://device.example.invalid',now=()=>2000000000;
const sign=(privateKey,payload,typ)=>new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(privateKey);
try{
 if(process.argv[2]==='setup'){
  await migrate(db,{roles:['api']});const owner=generateKeyPairSync('ed25519'),hub=generateKeyPairSync('ed25519');
  const publicKeyPem=owner.publicKey.export({format:'pem',type:'spki'}),hubPublic=hub.publicKey.export({format:'pem',type:'spki'}),genesis=createGalaxyGenesis({publicKeyPem,issuedAtMs:now()*1000,originCode:'5'}),deviceId=randomUUID();
  const control=new IdentityControlService({db,endpoint,now,allowedScopes:['binding','history']});const request={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:genesis.id,expectedEpoch:0,previousEventHash:null,signerKeyId:digest(publicKeyPem),genesisProof:genesis.genesisProof,newDevice:{deviceId,publicKeyPem,scopes:['manage-identity','binding','history']}};
  const challenge=await control.challenge(request),signature=await sign(owner.privateKey,challenge.challenge,'galaxy-identity-control-v2+jws');if(process.env.GALAXY_GO_TEST_SKIP_BOOTSTRAP!=='true')await control.commit({operationId:request.operationId,controllerSignature:signature,newDeviceProof:signature});
  const state={genesis,deviceId,publicKeyPem,hubPublic,ownerPrivate:owner.privateKey.export({format:'pem',type:'pkcs8'}),hubPrivate:hub.privateKey.export({format:'pem',type:'pkcs8'}),installationId:randomUUID()};
  const publicKeys={version:1,endpoint,sequence:1,keys:[{kid:'fixture',publicKeyPem:hubPublic,notBefore:now()-100,notAfter:now()+100000,revoked:false}]};
  await writeFile(join(dir,'root-pins.json'),JSON.stringify(publicKeys));
  const ring=await issueKeyring({endpoint,keys:publicKeys.keys,sequence:1,rootKid:'fixture',rootPrivateKey:hub.privateKey,now:now()});await writeFile(join(dir,'keyring.json'),JSON.stringify(ring));
  await writeFile(join(dir,'fixture.json'),JSON.stringify(state),{mode:0o600});await writeFile(join(dir,'hub-private.pem'),state.hubPrivate,{mode:0o600});console.log(JSON.stringify({subjectId:genesis.id,deviceId,publicKeyPem,hubPublic}));
 }else{
  const state=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8')),ownerKey=createPrivateKey(state.ownerPrivate),trustedKeys=new Map([['fixture',{publicKeyPem:state.hubPublic,notBefore:now()-100,notAfter:now()+100000}]]);
  const binding=new BindingService({db,endpoint,signingKey:createPrivateKey(state.hubPrivate),kid:'fixture',trustedKeys,now,allowedScopes:['binding','history']}),access=new AccessService({db,endpoint,now,trustedKeys,sign:binding.sign.bind(binding)});
  if(process.argv[2]==='client'||process.argv[2]==='client-consent'){
   const origin=new URL(process.env.GALAXY_GO_TEST_DEVICE_ORIGIN??'');if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:')throw Error('loopback HTTP only');const paths=[];
   const client=createConnectionClient({endpoint,trustedKeys,now,assertCurrent:async()=>true,sign:(payload,type)=>sign(ownerKey,payload,type),send:async(url,{bodyJson})=>{const path=new URL(url).pathname;paths.push(path);const input=JSON.parse(bodyJson);const res=await fetch(origin.origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:bodyJson});const result=await res.json();if(!res.ok)throw Error(JSON.stringify(result));return result;}});
   const preview=client.prepare({subjectId:state.genesis.id,genesisProof:state.genesis.genesisProof,installationId:state.installationId,scopes:process.argv[2]==='client-consent'?['binding','history','consent']:['binding','history'],control:{deviceId:state.deviceId,keyId:digest(state.publicKeyPem),epoch:1}});const result=await client.execute(preview,preview.confirmation),credential=result.takeCredential();const actor=await access.authenticate(credential,'history');await writeFile(join(dir,'credential.txt'),credential,{mode:0o600});console.log(JSON.stringify({subjectId:actor.subjectId,bindingId:actor.bindingId,deviceId:actor.deviceId,controlEpoch:actor.controlEpoch,paths}));
  }else if(process.argv[2]==='js-consent-create'){
   const token=await readFile(join(dir,'credential.txt'),'utf8'),actor=await access.authenticate(token,'consent'),payloadJson=JSON.stringify({title:'original JavaScript grant'}),intent={version:1,id:randomUUID(),subjectId:actor.subjectId,bindingId:actor.bindingId,endpoint,objectId:'original-js-query',action:'history.query',purpose:'operational',recipient:endpoint,fields:['title'],visibility:'Private',viewers:[actor.subjectId],payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:now(),expiresAt:now()+600};const signed=await sign(ownerKey,JSON.stringify(intent),'galaxy-consent+jws');const grant=await new ConsentService(access).create(actor,signed);console.log(JSON.stringify({id:grant.consentId,subjectId:actor.subjectId,action:intent.action,objectId:intent.objectId,recipient:endpoint,payloadJson}));
  }else if(process.argv[2]==='consent-read'){
   const x=JSON.parse(await readFile(join(dir,'consent-locator.json'),'utf8'));const intent=await new ConsentReader({now}).require(db,{id:x.id,subjectId:state.genesis.id,action:x.action,objectId:x.objectId,recipient:endpoint,payloadJson:x.payloadJson});const evidence=(await db.query('SELECT signature_envelope,signed_payload_text,control_event_hash FROM consents WHERE id=$1',[x.id])).rows[0];console.log(JSON.stringify({intent,originalSignature:typeof evidence.signature_envelope==='string',payloadText:evidence.signed_payload_text,chainHead:evidence.control_event_hash}));
  }else if(process.argv[2]==='chain'){
   const control=new IdentityControlService({db,endpoint,now}),current=await control.publicState(state.genesis.id);await verifyIdentityControlChain(current);console.log(JSON.stringify({epoch:current.epoch,sequence:current.sequence,chainHead:current.chainHead}));
  }else if(process.argv[2]==='receipt-client'){
   const origin=new URL(process.env.GALAXY_GO_TEST_DEVICE_ORIGIN??'');if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1')throw Error('loopback required');const operation=JSON.parse(await readFile(join(dir,'receipt-locator.json'),'utf8')),context={subjectId:state.genesis.id,control:{deviceId:state.deviceId,keyId:digest(state.publicKeyPem),epoch:1}};
   const cryptoKey=await crypto.subtle.importKey('pkcs8',ownerKey.export({format:'der',type:'pkcs8'}),{name:'Ed25519'},false,['sign']);
   const signer=createReceiptStatusDeviceSigner({endpoint,trustedKeys,now,getContext:async()=>context,getPrivateKey:async()=>cryptoKey});let calls=0;
   const client=createReceiptStatusClient({endpoint,trustedKeys,now,getContext:async()=>context,signReceiptStatus:signer,fetch:async(url,init)=>{calls++;if(init.credentials!=='omit'||init.headers.Authorization||init.headers.Cookie)throw Error('receipt used ordinary authentication');return fetch(origin.origin+new URL(url).pathname,init)}});const result=await client.query(operation);console.log(JSON.stringify({result,calls}));
  }else if(process.argv[2]==='trust-check'){const document=JSON.parse(await readFile(join(dir,'keyring.json'),'utf8')),previousState=JSON.parse(await readFile(join(dir,'trust',digest(endpoint)+'.json'),'utf8'));const checked=await verifyKeyring(document,{endpoint,rootPins:trustedKeys,previousState,now:now()});console.log(JSON.stringify({sequence:checked.nextState.sequence,history:checked.nextState.history.length}));
  }else if(process.argv[2]==='js-session'){
   const token=await readFile(join(dir,'credential.txt'),'utf8'),actor=await access.authenticate(token,'history');console.log(JSON.stringify({subjectId:actor.subjectId,bindingId:actor.bindingId,scopes:actor.scopes}));
  }else throw Error('fixture command required');
 }
}finally{await db.end();}

