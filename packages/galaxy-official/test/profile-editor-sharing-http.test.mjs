import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {profileEditorFixture} from './profile-editor-fixture.mjs';
import {profileStatementSchema} from '../src/shared/profile-schema.mjs';

const statement=(selfDeclared,visibility='Public',viewers=[],expiresAt=null,expectedRevision=0)=>({expectedRevision,selfDeclared,visibility,viewers,expiresAt});

test('new profile sharing is independent of natural submission/binding expiry, while finite sharing and legacy expiry remain exact',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor();let editor=owner.editor();
  const saved=await editor.save(statement({displayName:'Synthetic current person',about:'Original self description',projects:[{id:randomUUID(),kind:'project',title:'Plain introduction',summary:'No discovery claim',functions:[],discoverable:false}]}));
  assert.equal(saved.state,'acknowledged');
  let view=await f.publicProfile(owner.subjectId);assert.equal(view.selfDeclared.displayName,'Synthetic current person');assert.equal(view.selfDeclaredReadExpiresAt,f.now()+60);
  const own=await editor.ownerRead();assert.equal(own.sharing.expiresAt,null);assert.equal(own.sharing.mode,'declared-sharing');assert.equal(own.sharing.authorizationExpiresAt,f.now()+3600);
  f.advance(31*86400);
  view=await f.publicProfile(owner.subjectId);assert.equal(view.selfDeclared.displayName,'Synthetic current person','natural binding expiry does not revoke explicitly continuous sharing');
  await owner.reload({connectNew:true});editor=owner.editor();
  assert.equal((await editor.ownerRead()).revision,1);
  const until=f.now()+120;await editor.save(statement({about:'Finite replacement'},'Public',[],until,1));
  f.advance(121);assert.deepEqual((await f.publicProfile(owner.subjectId)).selfDeclared,{});
  const expired=await editor.ownerRead();assert.equal(expired.selfDeclared.about,'Finite replacement');assert.equal(expired.sharing.status,'expired');assert.equal(expired.sharing.expiresAt,until);
  const legacy={id:randomUUID(),expectedRevision:2,selfDeclared:{about:'Legacy short grant'}};
  const grant=await owner.runtime.api.authorizePayload(JSON.stringify(legacy),{action:'profile.publish',objectId:legacy.id,visibility:'Public',expiresAt:f.now()+120,confirmed:true});
  await owner.runtime.api.call('/v1/profiles/statements',grant);f.advance(121);
  assert.deepEqual((await f.publicProfile(owner.subjectId)).selfDeclared,{});
  const legacyOwner=await editor.ownerRead();assert.equal(legacyOwner.selfDeclared.about,'Legacy short grant');assert.equal(legacyOwner.sharing.mode,'legacy-consent');assert.equal(legacyOwner.sharing.status,'expired');
 }finally{await f.close();}
});

test('profile audience changes, exact consent revocation and source device revocation close current display without losing own edit text',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor(),allowed=await f.actor(),other=await f.actor(),editor=owner.editor();
  await editor.save(statement({displayName:'Synthetic public name',about:'Public original'}));
  await editor.save(statement({displayName:'Synthetic selected name',about:'Selected replacement'},'Private',[allowed.subjectId],null,1));
  assert.deepEqual((await f.publicProfile(owner.subjectId)).selfDeclared,{});
  assert.equal((await allowed.runtime.api.call('/v1/history/query',{subjectId:owner.subjectId,limit:1})).selfDeclared.about,'Selected replacement');
  assert.deepEqual((await other.runtime.api.call('/v1/history/query',{subjectId:owner.subjectId,limit:1})).selfDeclared,{});
  const own=await editor.ownerRead(),consent=(await f.db.query('SELECT consent_id FROM profile_statements WHERE id=$1',[own.statement.id])).rows[0].consent_id;
  await owner.runtime.api.call('/v1/consents/'+consent+'/revoke',{});
  assert.deepEqual((await allowed.runtime.api.call('/v1/history/query',{subjectId:owner.subjectId,limit:1})).selfDeclared,{});
  assert.equal((await editor.ownerRead()).selfDeclared.about,'Selected replacement');
  assert.equal((await editor.ownerRead()).sharing.status,'revoked');
  await editor.save(statement({about:'Current third version'},'Public',[],null,2));
  const device=(await owner.runtime.status()).identity.deviceId;
  const code=await owner.runtime.prepareRecovery();await owner.runtime.saveRecovery({operationId:code.operationId,confirmed:true});
  const prepared=await owner.runtime.deviceManagement.prepareRevoke({deviceId:device});
  await owner.runtime.deviceManagement.confirm(prepared,{confirmed:true});
  assert.deepEqual((await f.publicProfile(owner.subjectId)).selfDeclared,{},'revoked original signer cannot keep displaying a continuous statement');
 }finally{await f.close();}
});

test('sharing/Consent audience mismatch is rejected, unselected viewers get no self declaration, and foreign exact receipt reveals no original content',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor(),other=await f.actor(),payload=profileStatementSchema.parse({id:randomUUID(),expectedRevision:0,selfDeclared:{about:'Synthetic original'},sharing:{visibility:'Private',viewers:[other.subjectId],expiresAt:null}});
  const grant=await owner.runtime.api.authorizePayload(JSON.stringify(payload),{action:'profile.publish',objectId:payload.id,visibility:'Public',expiresAt:f.now()+3600,confirmed:true});
  await assert.rejects(owner.runtime.api.call('/v1/profiles/statements',grant),/profile_sharing_mismatch/);
  const editor=owner.editor(),saved=await editor.save(statement({about:'Owner only'},'Private'));
  assert.equal(saved.state,'acknowledged');assert.deepEqual((await other.runtime.api.call('/v1/history/query',{subjectId:owner.subjectId})).selfDeclared,{});
  assert.equal((await other.editor().receiptFor(saved)).state,'absent');
  assert.throws(()=>profileStatementSchema.parse({...payload,selfDeclared:{projects:[{id:randomUUID(),kind:'project',title:'Synthetic opted discovery',summary:'Actual description',discoverable:true,functions:[]}]}}));
 }finally{await f.close();}
});

test('explicit binding revocation and real identity recovery stop the original sharing; current owner can still edit their last raw statement',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor();let editor=owner.editor();await editor.save(statement({about:'Original binding source'}));
  const oldBinding=owner.runtime.api.snapshot().bindingId;
  await owner.runtime.api.call('/v1/bindings/'+oldBinding+'/revoke',{});
  assert.deepEqual((await f.publicProfile(owner.subjectId)).selfDeclared,{});
  await owner.runtime.connect({confirmed:true});editor=owner.editor();
  assert.equal((await editor.ownerRead()).selfDeclared.about,'Original binding source');
  assert.equal((await editor.ownerRead()).sharing.status,'revoked');
  await editor.save(statement({about:'Before actual same-identity recovery'},'Public',[],null,1));
  const recovery=await owner.runtime.prepareRecovery();await owner.runtime.saveRecovery({operationId:recovery.operationId,confirmed:true});
  const restored=await f.actor({initialize:false}),result=await restored.runtime.recover(recovery.code,{confirmed:true});
  await restored.runtime.confirmRecoveredCode({operationId:result.operationId,confirmed:true});await restored.runtime.connect({confirmed:true});
  assert.equal(restored.subjectId,owner.subjectId);
  assert.deepEqual((await f.publicProfile(owner.subjectId)).selfDeclared,{});
  const current=await restored.editor().ownerRead();assert.equal(current.selfDeclared.about,'Before actual same-identity recovery');assert.equal(current.sharing.status,'revoked');
  assert.equal(current.revision,2);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM profile_statements WHERE subject_id=$1',[owner.subjectId])).rows[0].n,2);
 }finally{await f.close();}
});

test('a real pending deletion closes external display, cancellation restores only the same still-valid original sharing',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor(),editor=owner.editor();await editor.save(statement({about:'Owner original before a deletion request'}));
  const selected=await owner.runtime.privacy.prepareDeletion({action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'});
  const request=await owner.runtime.privacy.submitDeletion(selected,{confirmed:true});assert.equal(request.state,'requested');
  assert.deepEqual((await f.publicProfile(owner.subjectId)).selfDeclared,{});
  assert.equal((await editor.ownerRead()).selfDeclared.about,'Owner original before a deletion request');
  const cancel=await owner.runtime.privacy.prepareDeletion({action:'cancel',requestId:request.id,expectedRevision:request.revision});
  await owner.runtime.privacy.submitDeletion(cancel,{confirmed:true});
  assert.equal((await f.publicProfile(owner.subjectId)).selfDeclared.about,'Owner original before a deletion request');
 }finally{await f.close();}
});
