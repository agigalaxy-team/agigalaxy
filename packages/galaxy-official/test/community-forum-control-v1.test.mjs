import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {CompactSign} from 'jose';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {digest} from '../src/shared/digest.mjs';
import {cleanupProductV2Retention} from '../src/operations/lifecycle-retention-v2.mjs';

const material=()=>{const keys=generateKeyPairSync('ed25519');return {deviceId:randomUUID(),publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),sign:(payload,type='galaxy-identity-control-v2+jws')=>new CompactSign(Buffer.from(payload)).setProtectedHeader({alg:'Ed25519',typ:type}).sign(keys.privateKey)};};
async function controlOperation(f,request,signer,newSigner){
 const challenged=await f.owner.identityControl.challenge(request),commit={operationId:request.operationId,controllerSignature:await signer(challenged.challenge,'galaxy-identity-control-v2+jws'),...(newSigner?{newDeviceProof:await newSigner(challenged.challenge,'galaxy-identity-control-v2+jws')}:{})};
 return f.owner.identityControl.commit(commit);
}
async function bootstrap(f){
 const scopes=['manage-identity',...f.owner.actor.scopes],root={deviceId:randomUUID(),publicKeyPem:f.owner.genesis.genesisProof.publicKeyPem,scopes},subjectId=f.owner.actor.subjectId;
 await controlOperation(f,{operationId:randomUUID(),subjectId,kind:'bootstrap',expectedEpoch:0,previousEventHash:null,signerKeyId:digest(root.publicKeyPem),genesisProof:f.owner.genesis.genesisProof,newDevice:root},f.owner.signForTest,f.owner.signForTest);
 f.owner.actor=await f.owner.access.authenticate(f.owner.credential);return root;
}

test('ordinary device addition and real same-GUID recovery preserve prior publication; explicit old-binding withdrawal then stops it',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'control-author');const p=await f.post(),w=await f.write(f.owner,'create-post',p);assert.equal(w.status,200);const originalBinding=f.owner.actor.bindingId;
  const root=await bootstrap(f),second=material(),recovery=material(),nextRecovery=material(),third=material();let state=await f.owner.identityControl.publicState(f.owner.actor.subjectId);
  await controlOperation(f,{operationId:randomUUID(),subjectId:f.owner.actor.subjectId,kind:'authorize-device',expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:digest(root.publicKeyPem),newDevice:{deviceId:second.deviceId,publicKeyPem:second.publicKeyPem,scopes:root.scopes}},f.owner.signForTest,second.sign);
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).availability,'available');
  state=await f.owner.identityControl.publicState(f.owner.actor.subjectId);
  await controlOperation(f,{operationId:randomUUID(),subjectId:f.owner.actor.subjectId,kind:'set-recovery',expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:digest(root.publicKeyPem),recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true},f.owner.signForTest);
  state=await f.owner.identityControl.publicState(f.owner.actor.subjectId);
  const recovered=await controlOperation(f,{operationId:randomUUID(),subjectId:f.owner.actor.subjectId,kind:'recover',expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:digest(recovery.publicKeyPem),recoveryGeneration:1,newDevice:{deviceId:third.deviceId,publicKeyPem:third.publicKeyPem,scopes:root.scopes},nextRecoveryPublicKey:nextRecovery.publicKeyPem},recovery.sign,third.sign);
  assert.equal(recovered.epoch,2);assert.equal(recovered.dataRecovery,'separate/not-performed');
  await assert.rejects(f.owner.access.authenticate(f.owner.credential),error=>error.code==='access_denied');
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).payload.body,p.body);
  const before=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,forumPolicy:f.forum.policy,endpoint:f.owner.access.endpoint});assert.equal(before.removed.forumBodies,0);
  f.owner.signForTest=third.sign;await f.reconnect(f.owner,f.owner.actor.scopes,{deviceId:third.deviceId,keyId:digest(third.publicKeyPem),epoch:2});
  const permit=await f.ok(`/v2/community/permissions/${w.body.permissionId}`);assert.equal(permit.revocationKind,'recovery');assert.deepEqual(permit.stoppedReasons,[]);
  await f.owner.bindings.revoke(originalBinding,f.owner.actor.subjectId,randomUUID(),null,f.owner.actor);
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).availability,'unavailable');
  assert.deepEqual((await f.ok(`/v2/community/permissions/${w.body.permissionId}`)).stoppedReasons,['binding-explicitly-revoked']);
 }finally{await f.close();}
});

test('real explicit source-device revocation stops its publication while an independent reply retains its own permission',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'source-device');await f.login(f.responder,'independent-device');const root=await bootstrap(f),second=material();
  const p=await f.post(),w=await f.write(f.owner,'create-post',p),r=await f.reply(p);assert.equal(w.status,200);assert.equal((await f.write(f.responder,'create-reply',r)).status,200);
  let state=await f.owner.identityControl.publicState(f.owner.actor.subjectId);
  await controlOperation(f,{operationId:randomUUID(),subjectId:f.owner.actor.subjectId,kind:'authorize-device',expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:digest(root.publicKeyPem),newDevice:{deviceId:second.deviceId,publicKeyPem:second.publicKeyPem,scopes:root.scopes}},f.owner.signForTest,second.sign);
  state=await f.owner.identityControl.publicState(f.owner.actor.subjectId);
  await controlOperation(f,{operationId:randomUUID(),subjectId:f.owner.actor.subjectId,kind:'revoke-device',expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:digest(second.publicKeyPem),deviceId:root.deviceId},second.sign);
  assert.deepEqual(Object.keys(await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).sort(),['availability','checkedAt','locator']);
  assert.equal((await f.ok(`/v2/community/replies/${r.replyId}`,{authorization:false})).payload.body,r.body);
  const cleaned=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,forumPolicy:f.forum.policy,endpoint:f.owner.access.endpoint});assert.equal(cleaned.removed.forumBodies,1);
 }finally{await f.close();}
});

test('missing Consent scope is403 without disconnecting; current rebind queries/retries only original receipt and never renews its publication deadline',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'lease-scope');const p=await f.post();await f.reconnect(f.owner,['binding','assistance']);
  const denied=await f.write(f.owner,'create-post',p);assert.equal(denied.status,403);assert.equal(denied.body.error,'consent_scope_required');
  assert.equal((await f.owner.access.authenticate(f.owner.credential)).subjectId,f.owner.actor.subjectId);assert.equal((await f.db.query("SELECT count(*) n FROM consents WHERE intent->>'action' LIKE 'forum.%'")).rows[0].n,0);
  await f.reconnect(f.owner,['binding','consent','assistance']);const oldPrepared=await f.authorize(f.owner,'create-post',p);
  await f.reconnect(f.owner,['binding','consent','assistance']);assert.equal((await f.request('/v2/community/posts',{input:oldPrepared})).status,403);
  assert.equal((await f.db.query("SELECT count(*) n FROM consents WHERE intent->>'action' LIKE 'forum.%'")).rows[0].n,0);
  const w=await f.write(f.owner,'create-post',p);assert.equal(w.status,200);const count=(await f.db.query('SELECT count(*) n FROM consents')).rows[0].n;
  await f.reconnect(f.owner,['binding','consent','assistance']);const hash=digest(w.input.payloadJson),receipt=await f.ok('/v2/community/receipt',{input:{operationId:p.operationId,payloadHash:hash}});assert.equal(receipt.status,'acknowledged');
  assert.equal((await f.ok('/v2/community/receipt',{who:f.responder,input:{operationId:p.operationId,payloadHash:hash}})).status,'absent');
  assert.equal((await f.ok('/v2/community/posts',{input:w.input})).publishedUntil,p.publishedUntil);assert.equal((await f.db.query('SELECT count(*) n FROM consents')).rows[0].n,count);
  assert.equal((await f.request('/v2/community/posts',{input:{...w.input,payloadJson:JSON.stringify({...p,body:'Same operation changed'})}})).status,409);
 }finally{await f.close();}
});
