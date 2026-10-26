import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,randomBytes} from 'node:crypto';
import {CompactSign} from 'jose';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {BindingService,digest} from "../src/identity/bindings.mjs";
import {AccessService} from "../src/security/access.mjs";
import {ConsentService} from "../src/consents/consents.mjs";
import {DeletionService} from "../src/privacy/deletion.mjs";
import {deletionLedgerColumns,validateDeletionLedger} from '../src/operations/deletion-ledger.mjs';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {verifyNodeControlProof} from '../src/verification/node-control.mjs';
import {createSigningService} from "../src/security/signing-service.mjs";
import {IdentityControlService} from "../src/identity/control.mjs";
import {verifyIdentityControlChain} from '../src/verification/identity-control.mjs';
import {verifyTrustIdentity} from '../src/shared/trust-package-crypto.mjs';
import {createGalaxyGenesis} from '../../galaxy-core/src/galaxy-guid.mjs';
import {createRecoveryMaterial,identityKeyId} from '../../galaxy-core/src/domain/identity-material.mjs';

const pem=key=>key.export({type:'spki',format:'pem'});
const scopes=['binding','consent','case','data-delete','builders'];
const all=['manage-identity',...scopes];
const device=()=>{const keys=generateKeyPairSync('ed25519');return{deviceId:randomUUID(),publicKeyPem:pem(keys.publicKey),privateKey:keys.privateKey,scopes:all};};
const publicDevice=({deviceId,publicKeyPem,scopes})=>({deviceId,publicKeyPem,scopes});
const sign=(payload,key,type='galaxy-identity-control-v2+jws')=>new CompactSign(Buffer.from(payload)).setProtectedHeader({alg:'Ed25519',typ:type}).sign(key);


export async function verifyIdentityControlLifecycle(database=null,{migrateDatabase=true,runtimeDb=database}={}){
  const db=database??new PGlite();
  try {
    if(migrateDatabase)await migrate(db);let now=2000000000;
    const root=device(),second=device(),third=device(),server=generateKeyPairSync('ed25519');
    const genesis=createGalaxyGenesis({publicKeyPem:root.publicKeyPem,originCode:'5'});
    const serviceDb=runtimeDb??db;
    const bindings=new BindingService({db:serviceDb,endpoint:'https://official.example.org',signingKey:server.privateKey,kid:'test',allowedScopes:scopes,now:()=>now,
      trustedKeys:new Map([['test',{publicKeyPem:pem(server.publicKey),notBefore:now-1,notAfter:now+864000,revoked:false}]])});
    const access=new AccessService(bindings),consents=new ConsentService(access),deletion=new DeletionService(access),identity=new IdentityControlService({db:serviceDb,endpoint:bindings.endpoint,allowedScopes:scopes,now:()=>now});
    async function bindClient(client,control){
      const challenge=await bindings[control?'challengeV2':'challenge']({subjectId:genesis.id,genesisProof:genesis.genesisProof,installationId:randomUUID(),scopes,...(control?{control}:{})});
      const bound=await bindings.bind({challenge:challenge.challenge,clientSession:challenge.clientSession,signature:await sign(challenge.challenge,client.privateKey,'galaxy-binding-response+jws')});
      const token=randomBytes(32).toString('base64url'),session=await access.challenge({bindingId:bound.bindingId,credentialHash:digest(token)});
      await access.activate({...session,signature:await sign(session.challenge,client.privateKey,'galaxy-session-response+jws')});
      return {token,actor:await access.authenticate(token),bindingId:bound.bindingId};
    }
    const [first,parallel]=await Promise.all([bindClient(root),bindClient(root)]);
    assert.notEqual(first.bindingId,parallel.bindingId,'parallel bindings use the same subject lock order');
    // Genuine legacy record lacks an original JWS; upgrading must not fabricate it.
    const oldConsent=randomUUID();await db.query('INSERT INTO consents(id,subject_id,binding_id,intent,signature_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [oldConsent,genesis.id,first.bindingId,JSON.stringify({legacy:'record'}),'a'.repeat(64),new Date((now+3600)*1000).toISOString()]);
    async function operation(request,key,newKey){const challenge=await identity.challenge(request);return{operationId:request.operationId,controllerSignature:await sign(challenge.challenge,key),...(newKey?{newDeviceProof:await sign(challenge.challenge,newKey)}:{})};}
    const bootstrap={operationId:randomUUID(),subjectId:genesis.id,kind:'bootstrap',expectedEpoch:0,previousEventHash:null,signerKeyId:digest(root.publicKeyPem),genesisProof:genesis.genesisProof,newDevice:publicDevice(root)};
    const boot=await operation(bootstrap,root.privateKey,root.privateKey),bootReceipt=await identity.commit(boot);
    assert.equal(bootReceipt.epoch,1);assert.deepEqual(await identity.commit(boot),bootReceipt);
    const rootActor=await access.authenticate(first.token);assert.equal(rootActor.controlEpoch,1);
    const original=(await db.query('SELECT * FROM subjects WHERE id=$1',[genesis.id])).rows[0];assert.equal(original.public_key,root.publicKeyPem);assert.deepEqual(original.genesis_proof,genesis.genesisProof);
    assert.equal((await consents.list(rootActor)).items.find(c=>c.consentId===oldConsent).signatureEvidence,'legacy-verified-record');
    const recovery=await createRecoveryMaterial(genesis.id);
    let state=await identity.publicState(genesis.id);
    const set=await operation({operationId:randomUUID(),subjectId:genesis.id,kind:'set-recovery',expectedEpoch:state.epoch,previousEventHash:state.chainHead,
      signerKeyId:digest(root.publicKeyPem),recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true},root.privateKey);
    await identity.commit(set);state=await identity.publicState(genesis.id);assert.equal(state.recoveryReadiness,'registered-save-declared');
    const add=await operation({operationId:randomUUID(),subjectId:genesis.id,kind:'authorize-device',expectedEpoch:1,previousEventHash:state.chainHead,
      signerKeyId:digest(root.publicKeyPem),newDevice:publicDevice(second)},root.privateKey,second.privateKey);
    await assert.rejects(identity.commit({...add,newDeviceProof:add.controllerSignature}),/proof_invalid/);
    const added=await identity.commit(add),secondClient=await bindClient(second,{deviceId:second.deviceId,keyId:digest(second.publicKeyPem),epoch:1});
    assert.equal(added.epoch,1);state=await identity.publicState(genesis.id);assert.equal(state.recovery.generation,1,'ordinary device addition does not consume recovery');
    const intent={version:1,id:randomUUID(),subjectId:genesis.id,bindingId:secondClient.bindingId,endpoint:bindings.endpoint,objectId:randomUUID(),action:'case.teaser.publish',purpose:'operational',
      recipient:bindings.endpoint,fields:['title'],visibility:'Private',viewers:[],payloadHash:digest('{}'),policyVersion:'0.1',issuedAt:now,expiresAt:now+3600};
    const originalSigned=await sign(JSON.stringify(intent),second.privateKey,'galaxy-consent+jws');await consents.create(secondClient.actor,originalSigned);
    const persisted=(await db.query('SELECT * FROM consents WHERE id=$1',[intent.id])).rows[0];assert.equal(persisted.signature_envelope,originalSigned);assert.equal(persisted.signer_key_id,digest(second.publicKeyPem));
    const deletionRequest={version:1,id:randomUUID(),endpoint:bindings.endpoint,subjectId:genesis.id,bindingId:secondClient.bindingId,
      issuedAt:now,expiresAt:now+300,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};
    await deletion.submit(secondClient.actor,await sign(JSON.stringify(deletionRequest),second.privateKey,'galaxy-deletion-intent+jws'));
    const nextRecovery=await createRecoveryMaterial(genesis.id);
    const request={operationId:randomUUID(),subjectId:genesis.id,kind:'recover',expectedEpoch:1,previousEventHash:state.chainHead,
      signerKeyId:await identityKeyId(recovery.publicKeyPem),recoveryGeneration:1,newDevice:publicDevice(third),nextRecoveryPublicKey:nextRecovery.publicKeyPem};
    const recover=await operation(request,recovery.privateKey,third.privateKey);
    const duplicate=await operation({...request,operationId:randomUUID()},recovery.privateKey,third.privateKey);
    const outcomes=await Promise.allSettled([identity.commit(recover),identity.commit(duplicate)]);assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
    const receipt=outcomes.find(result=>result.status==='fulfilled').value,committedRecovery=outcomes[0].status==='fulfilled'?recover:duplicate;
    assert.equal(receipt.epoch,2);assert.equal(receipt.activeRecoveryGeneration,2);
    assert.deepEqual(await identity.status(committedRecovery),receipt);assert.deepEqual(await identity.commit(committedRecovery),receipt,'lost HTTP response uses same operation');
    await assert.rejects(access.authenticate(first.token),/access_denied/);await assert.rejects(access.authenticate(secondClient.token),/access_denied/);
    await assert.rejects(bindings.query(rootActor),/access_denied/);await assert.rejects(access.runAuthorized(secondClient.actor,'case',async()=>true),/access_denied/);
    const thirdClient=await bindClient(third,{deviceId:third.deviceId,keyId:digest(third.publicKeyPem),epoch:2});
    const cancellation={version:1,id:randomUUID(),endpoint:bindings.endpoint,subjectId:genesis.id,bindingId:thirdClient.bindingId,
      issuedAt:now,expiresAt:now+300,action:'cancel',requestId:deletionRequest.id,expectedRevision:1};
    const cancelled=await deletion.submit(thirdClient.actor,await sign(JSON.stringify(cancellation),third.privateKey,'galaxy-deletion-intent+jws'));
    assert.equal(cancelled.state,'cancelled');
    const deletedHistory=await deletion.read(thirdClient.actor,{id:deletionRequest.id});
    assert.equal(deletedHistory.request.publicKeyPem,second.publicKeyPem);assert.equal(deletedHistory.events[1].signer_public_key,third.publicKeyPem);
    const ledgerTables={};for(const [table,columns] of Object.entries(deletionLedgerColumns))ledgerTables[table]=JSON.parse(JSON.stringify((await db.query(`SELECT ${columns.join(',')} FROM ${table} ORDER BY id`)).rows));
    const ledger={version:1,schema:migrations.at(-1).version,endpoint:bindings.endpoint,capturedAt:now,tables:ledgerTables};
    await validateDeletionLedger(ledger);
    const alteredLedger=structuredClone(ledger);alteredLedger.tables.deletion_events.find(event=>event.id===cancellation.id).signer_public_key=second.publicKeyPem;
    await assert.rejects(validateDeletionLedger(alteredLedger),/controller mismatch/);
    await assert.rejects(bindings.revoke(thirdClient.bindingId,genesis.id,randomUUID(),null,rootActor),/access_denied/);
    await assert.rejects(bindings.revoke(thirdClient.bindingId,genesis.id,randomUUID()),/administrative_revoke_context_required/);
    assert.equal((await bindings.query(thirdClient.actor)).items.find(b=>b.bindingId===thirdClient.bindingId).state,'active');
    await assert.rejects(bindClient(root),/identity_control_stale/);
    assert.equal((await db.query('SELECT public_key FROM subjects WHERE id=$1',[genesis.id])).rows[0].public_key,root.publicKeyPem);
    assert.equal((await db.query('SELECT signature_envelope FROM consents WHERE id=$1',[intent.id])).rows[0].signature_envelope,originalSigned);
    state=await identity.publicState(genesis.id);assert.equal(state.recoveryReadiness,'registered-awaiting-save-declaration');
    const chain=await verifyIdentityControlChain(state);assert.equal(chain.epoch,2);assert.equal(chain.devices.length,1);assert.equal(chain.devices[0].publicKey,third.publicKeyPem);
    assert.deepEqual(await verifyTrustIdentity(state),chain,'offline WebCrypto adapter preserves the same recovered control history');
    const control={kind:'node-control',id:randomUUID(),builderId:randomUUID(),expectedRevision:1,ownerId:genesis.id,nodeId:genesis.id,
      declarationId:randomUUID(),declarationHash:digest('synthetic-node-declaration'),expiresAt:now+300};
    const controlPayloadJson=JSON.stringify(control),snapshot={version:1,id:control.id,builderId:control.builderId,ownerId:genesis.id,nodeId:genesis.id,
      declarationId:control.declarationId,declarationHash:control.declarationHash,control,controlPayloadJson,sourceEventHash:digest(controlPayloadJson),
      checkedAt:now,expiresAt:now+300,authority:'registry-attested-node-authorization',capabilityVerified:false,endpointControlVerified:false,
      maintenance:{delisted:false,securityIssue:false},statusPath:'/v1/builders/node-control/export'};
    const registrySigned=await createSigningService({endpoint:bindings.endpoint,signingKey:server.privateKey,kid:'test',trustedKeys:bindings.trustedKeys,now:()=>now},['node-control']).sign('node-control',snapshot,control.id,300);
    const nodeClaims={version:1,purpose:'node-control-portable-proof',endpoint:bindings.endpoint,builderId:control.builderId,controlId:control.id,
      ownerId:genesis.id,nodeId:genesis.id,declarationId:control.declarationId,declarationHash:control.declarationHash,registryHash:digest(registrySigned),issuedAt:now,expiresAt:now+300};
    const proof={version:2,registrySigned,nodeSigned:await sign(JSON.stringify(nodeClaims),third.privateKey,'galaxy-node-control-proof+jws'),
      genesisProof:genesis.genesisProof,signerKeyId:digest(third.publicKeyPem),controlEpoch:2,
      controlChain:{subjectId:genesis.id,genesisProof:genesis.genesisProof,events:state.events}};
    const proofOptions={endpoint:bindings.endpoint,builderId:control.builderId,controlId:control.id,trustedKeys:bindings.trustedKeys,now};
    assert.equal((await verifyNodeControlProof(proof,proofOptions)).nodeSignatureVerified,true);
    await assert.rejects(verifyNodeControlProof({...proof,signerKeyId:digest(second.publicKeyPem)},proofOptions),/current-control/);
    const changed=structuredClone(state);changed.events.at(-1).payload_text=changed.events.at(-1).payload_text.replace('recover','authorize-device');await assert.rejects(verifyIdentityControlChain(changed));
    const saved=await operation({operationId:randomUUID(),subjectId:genesis.id,kind:'declare-recovery-saved',expectedEpoch:2,previousEventHash:state.chainHead,
      signerKeyId:digest(third.publicKeyPem),recoveryGeneration:2,saveDeclaration:true},third.privateKey);await identity.commit(saved);
    assert.equal((await identity.publicState(genesis.id)).recoveryReadiness,'registered-save-declared');
    assert.ok(!JSON.stringify((await db.query('SELECT * FROM identity_control_operations')).rows).includes(recovery.code),'server contains public-only operations');
    now+=200;assert.deepEqual(await identity.status(committedRecovery),receipt,'committed receipt survives challenge expiry');
    return {sameGenesis:true,epoch:2,oldCredentialsDenied:true,publicOnlyRecovery:true,concurrentWinnerCount:outcomes.filter(o=>o.status==='fulfilled').length};
  }finally{if(!database)await db.close();}
}
