import assert from 'node:assert/strict';
import {generateKeyPairSync,createPrivateKey,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {CompactSign} from '../../packages/galaxy-official/node_modules/jose/dist/webapi/index.js';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {createGalaxyGenesis} from '../../packages/galaxy-core/src/galaxy-guid.mjs';
import {IdentityControlService} from '../../packages/galaxy-official/src/identity/control.mjs';
import {createConnectionClient} from '../../packages/galaxy-official/src/clients/connection.mjs';
import {issueKeyring} from '../../packages/galaxy-official/src/security/trust-keyring.mjs';
import {createDataExportClient} from '../../packages/galaxy-official/src/clients/data-export.mjs';
import {createDeletionClient,createDeletionStatusClient} from '../../packages/galaxy-official/src/clients/deletion.mjs';
import {DataExportService} from '../../packages/galaxy-official/src/privacy/data-export.mjs';
import {DeletionService} from '../../packages/galaxy-official/src/privacy/deletion.mjs';
import {BindingService} from '../../packages/galaxy-official/src/identity/bindings.mjs';
import {AccessService} from '../../packages/galaxy-official/src/security/access.mjs';
import {exportSources} from '../../packages/galaxy-official/src/infrastructure/export-datasets.mjs';
import {ownerExportDatasets,exportViewScopes} from '../../packages/galaxy-official/src/shared/data-export-schema.mjs';
import {reviewDeletionRequest} from '../../packages/galaxy-official/src/operations/deletion-review.mjs';
import {lockDeletionTables,deletionTargets} from '../../packages/galaxy-official/src/operations/deletion-execute.mjs';
import {transaction} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const dir=process.env.GALAXY_GO_TEST_DEVICE_DIR;if(!isAbsolute(dir??''))throw Error('disposable absolute directory required');
const db=new pg.Pool({connectionString:address.href,max:2});
const endpoint='https://device.example.invalid',now=()=>2000000000,scopes=['binding','history','data-export','data-delete'];
const sign=(key,payload,typ)=>new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({alg:'Ed25519',typ}).sign(key);
try{
 if(process.argv[2]==='setup'){
  await migrate(db,{roles:['api']});const owner=generateKeyPairSync('ed25519'),hub=generateKeyPairSync('ed25519');
  const publicKeyPem=owner.publicKey.export({format:'pem',type:'spki'}),hubPublic=hub.publicKey.export({format:'pem',type:'spki'}),genesis=createGalaxyGenesis({publicKeyPem,issuedAtMs:now()*1000,originCode:'5'}),deviceId=randomUUID();
  const control=new IdentityControlService({db,endpoint,now,allowedScopes:scopes}),request={version:2,kind:'bootstrap',operationId:randomUUID(),subjectId:genesis.id,expectedEpoch:0,previousEventHash:null,signerKeyId:digest(publicKeyPem),genesisProof:genesis.genesisProof,newDevice:{deviceId,publicKeyPem,scopes:['manage-identity',...scopes]}};
  const challenge=await control.challenge(request),signature=await sign(owner.privateKey,challenge.challenge,'galaxy-identity-control-v2+jws');await control.commit({operationId:request.operationId,controllerSignature:signature,newDeviceProof:signature});
  const state={genesis,deviceId,publicKeyPem,hubPublic,ownerPrivate:owner.privateKey.export({format:'pem',type:'pkcs8'}),hubPrivate:hub.privateKey.export({format:'pem',type:'pkcs8'}),installationId:randomUUID()};
  const publicKeys={version:1,endpoint,sequence:1,keys:[{kid:'fixture',publicKeyPem:hubPublic,notBefore:now()-100,notAfter:now()+100000,revoked:false}]};
  await writeFile(join(dir,'root-pins.json'),JSON.stringify(publicKeys));await writeFile(join(dir,'keyring.json'),JSON.stringify(await issueKeyring({endpoint,keys:publicKeys.keys,sequence:1,rootKid:'fixture',rootPrivateKey:hub.privateKey,now:now()})));
  await writeFile(join(dir,'fixture.json'),JSON.stringify(state),{mode:0o600});await writeFile(join(dir,'hub-private.pem'),state.hubPrivate,{mode:0o600});
  for(const [i,id]of ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'].entries())await db.query(`INSERT INTO reading_bookmarks_v1(id,subject_id,reference_key,reference,saved,revision,created_at,saved_at,updated_at)VALUES($1,$2,$3,$4,true,1,now(),now(),now())`,[id,genesis.id,'fixture-'+i,JSON.stringify({kind:'forum-post',postId:randomUUID(),versionId:randomUUID()})]);
  console.log(JSON.stringify({subjectId:genesis.id}));
 }else{
  const state=JSON.parse(await readFile(join(dir,'fixture.json'),'utf8')),ownerKey=createPrivateKey(state.ownerPrivate),trustedKeys=new Map([['fixture',{publicKeyPem:state.hubPublic,notBefore:now()-100,notAfter:now()+100000}]]);
  const origin=new URL(process.env.GALAXY_GO_TEST_DEVICE_ORIGIN??'');if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:')throw Error('loopback only');
  const send=async(url,{bodyJson,credential})=>{const response=await fetch(origin.origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:bodyJson});const result=await response.json();if(!response.ok){const e=Error(result.error);e.status=response.status;throw e}return result};
  if(process.argv[2]==='limited'){
   const binding=new BindingService({db,endpoint,signingKey:createPrivateKey(state.hubPrivate),kid:'fixture',trustedKeys,now,allowedScopes:scopes}),access=new AccessService({db,endpoint,now,trustedKeys,sign:binding.sign.bind(binding)});
   const calls={'/v2/binding-challenges':input=>binding.challengeV2(input),'/v1/bindings':input=>binding.bind(input),'/v1/session-challenges':input=>access.challenge(input),'/v1/sessions':input=>access.activate(input)};
   const client=createConnectionClient({endpoint,trustedKeys,now,assertCurrent:async()=>true,sign:(p,t)=>sign(ownerKey,p,t),send:(url,{bodyJson})=>calls[new URL(url).pathname](JSON.parse(bodyJson))});
   const preview=client.prepare({subjectId:state.genesis.id,genesisProof:state.genesis.genesisProof,installationId:randomUUID(),scopes:['binding','data-export'],control:{deviceId:state.deviceId,keyId:digest(state.publicKeyPem),epoch:1}}),connected=await client.execute(preview,preview.confirmation);const credential=connected.takeCredential();await db.query(`UPDATE access_credentials SET scopes='["data-export"]'::jsonb WHERE token_hash=$1`,[digest(credential)]);await writeFile(join(dir,'limited-credential.txt'),credential,{mode:0o600});
  }else if(process.argv[2]==='maintenance'){
   const id=randomUUID(),bindingId=randomUUID(),intent={version:1,id,endpoint,subjectId:state.genesis.id,bindingId,issuedAt:now(),expiresAt:now()+300,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'},payload=JSON.stringify(intent),signature=await sign(ownerKey,payload,'galaxy-deletion-intent+jws');
   await db.query(`INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision)VALUES($1,$2,$3,$4,$5,$6,$7,'requested',1)`,[id,state.genesis.id,bindingId,state.publicKeyPem,payload,digest(payload),signature]);
   await db.query(`INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash,signature)VALUES($1,$1,1,'subject',$2,'request',$3,$4,$5)`,[id,state.genesis.id,payload,digest(payload),signature]);
   const approvalId=randomUUID();await reviewDeletionRequest(db,{version:1,id:approvalId,requestId:id,endpoint,expectedRevision:1,reviewerRef:'isolated-reviewer',decision:'approve',explanation:'isolated fixture only',plan:{policyId:'fixture-policy',policyVersion:'1',primary:{action:'delete-owned-data',notBefore:now(),basis:'fixture'},audit:{action:'retain-minimum',until:now()+100,basis:'fixture'},backups:{action:'expire-snapshots-and-replay-deletions',until:now()+200,basis:'fixture'},externalCopies:'outside-service-control'}});
   const original=await transaction(db,async tx=>{const inv=await lockDeletionTables(tx);return {keys:inv.keys,constraints:inv.constraints.length}});
   const command={version:1,id:randomUUID(),requestId:id,approvalId,endpoint,expectedRevision:2,executorRef:'isolated-executor'};
   await writeFile(join(dir,'maintenance.json'),JSON.stringify({command,original,targets:deletionTargets}));
  }else if(process.argv[2]==='client'){
   const client=createConnectionClient({endpoint,trustedKeys,now,assertCurrent:async()=>true,sign:(p,t)=>sign(ownerKey,p,t),send});
   const preview=client.prepare({subjectId:state.genesis.id,genesisProof:state.genesis.genesisProof,installationId:state.installationId,scopes,control:{deviceId:state.deviceId,keyId:digest(state.publicKeyPem),epoch:1}}),connected=await client.execute(preview,preview.confirmation),credential=connected.takeCredential();await writeFile(join(dir,'credential.txt'),credential,{mode:0o600});
   const binding=(await db.query('SELECT id,expires_at FROM bindings WHERE subject_id=$1 ORDER BY created_at DESC LIMIT 1',[state.genesis.id])).rows[0];
   const actor={subjectId:state.genesis.id,bindingId:binding.id,scopes,credential,bindingExpiresAt:Date.parse(binding.expires_at)/1000,expiresAt:now()+600};
   const sessions={readAuthorization:async()=>actor,isAuthorizationCurrent:async()=>true,matchesAuthorization:()=>true};
   const exporter=createDataExportClient({endpoint,sessions,send,now});const spec=await exporter.specification();assert.deepEqual(spec.datasets,ownerExportDatasets);
   const ticket=await exporter.create({datasets:['identity','reading-bookmarks','bindings']});const first=await exporter.page({id:ticket.id,dataset:'reading-bookmarks',limit:1});assert.equal(first.items.length,1);assert.ok(first.nextAfter);
   await exporter.page({id:ticket.id,dataset:'identity'});await exporter.page({id:ticket.id,dataset:'bindings'});
   let requestSigned;const deletion=createDeletionClient({endpoint,sessions,signIntent:async(p,t)=>{const signed=await sign(ownerKey,p,t);if(JSON.parse(p).action==='request')requestSigned=signed;return signed},send,now});
   const before=(await db.query('SELECT count(*)::int n FROM reading_bookmarks_v1')).rows[0].n;
   const request=await deletion.prepare({action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'});const receipt=await deletion.execute(request,request.confirmation);assert.equal(receipt.physicalDeletionPerformed,false);assert.equal(receipt.serviceWideDeletionComplete,false);
   const detail=await deletion.read({id:receipt.id});assert.equal(detail.events.length,1);assert.equal(detail.events[0].signer_control_chain.events.length,1);
   const cancellation=await deletion.prepare({action:'cancel',requestId:receipt.id,expectedRevision:receipt.revision});await deletion.execute(cancellation,cancellation.confirmation);assert.equal((await deletion.read({id:receipt.id})).events.length,2);assert.equal((await deletion.query()).items.length,1);const replay=await send(endpoint+'/v1/deletion-requests/submit',{bodyJson:JSON.stringify({signed:requestSigned}),credential});assert.equal(replay.state,'cancelled');assert.equal(replay.revision,2);
   assert.equal((await db.query('SELECT count(*)::int n FROM reading_bookmarks_v1')).rows[0].n,before);
   const storedCatalog=JSON.parse(await readFile(new URL('../../go/internal/subjectlifecycle/catalog.json',import.meta.url),'utf8'));
   assert.deepEqual(storedCatalog,{datasets:ownerExportDatasets,viewScopes:exportViewScopes,sources:Object.fromEntries(Object.entries(exportSources).map(([n,s])=>[n,{...s,transform:!!s.transform}]))});
   await writeFile(join(dir,'resume.json'),JSON.stringify({ticket,after:first.nextAfter,requestId:receipt.id,bindingId:binding.id}));
  }else if(process.argv[2]==='resume'){
   const saved=JSON.parse(await readFile(join(dir,'resume.json'),'utf8')),credential=await readFile(join(dir,'credential.txt'),'utf8');
   const read=await send(endpoint+'/v1/data-exports/page',{bodyJson:JSON.stringify({id:saved.ticket.id,dataset:'reading-bookmarks',after:saved.after,limit:1}),credential});assert.equal(read.items.length,1);assert.equal(read.nextAfter,null);const {sha256,...snapshot}=read;assert.equal(digest(JSON.stringify(snapshot)),sha256);
   const binding=new BindingService({db,endpoint,signingKey:createPrivateKey(state.hubPrivate),kid:'fixture',trustedKeys,now,allowedScopes:scopes}),access=new AccessService({db,endpoint,now,trustedKeys,sign:binding.sign.bind(binding)}),actor=await access.authenticate(credential,'data-export');
   const original=await new DataExportService(access).page(actor,{id:saved.ticket.id,dataset:'reading-bookmarks',after:saved.after,limit:1});assert.deepEqual(read.items,JSON.parse(JSON.stringify(original.items)));assert.equal(read.through,original.through);assert.equal(read.selectionCutoff,original.selectionCutoff);
   const originalDeletion=await new DeletionService(access).read(actor,{id:saved.requestId});assert.equal(originalDeletion.state,'cancelled');assert.equal(originalDeletion.events.length,2);
   await db.query('UPDATE access_credentials SET revoked_at=now() WHERE binding_id=$1',[saved.bindingId]);
  }else if(process.argv[2]==='status'){
   const saved=JSON.parse(await readFile(join(dir,'resume.json'),'utf8'));const client=createDeletionStatusClient({endpoint,readSubjectId:async()=>state.genesis.id,signIntent:(p,t)=>sign(ownerKey,p,t),send,now});const preview=await client.prepare({requestId:saved.requestId});const status=await client.execute(preview,preview.confirmation);assert.equal(status.state,'cancelled');assert.equal(status.holderProofVerified,true);
  }else throw Error('mode required');
  console.log(JSON.stringify({mode:process.argv[2],ok:true}));
 }
}finally{await db.end()}
