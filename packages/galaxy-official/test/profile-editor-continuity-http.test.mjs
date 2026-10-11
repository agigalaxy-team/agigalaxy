import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {profileEditorFixture} from './profile-editor-fixture.mjs';
import {digest} from '../src/shared/digest.mjs';

const input=(expectedRevision=0,about='Synthetic editable text')=>({expectedRevision,selfDeclared:{displayName:'Synthetic profile owner',about},visibility:'Public',viewers:[],expiresAt:null});
const posts=(f,path)=>f.trace.filter(row=>row.path===path);
const key=runtime=>'profile-statements:'+runtime.api.endpoint;

test('lost statement or Consent acknowledgement survives normal reload with exact ID/hash and no duplicate statement or grant',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor();let editor=owner.editor(),locator;
  f.faults.dropProfile=true;
  await assert.rejects(editor.save(input(),{onJournal:value=>{locator=value;}}),/lost committed/);
  assert.deepEqual(Object.keys(locator).sort(),['expectedRevision','kind','operationId','payloadHash']);
  const pending=await editor.pending(),binding=owner.runtime.api.snapshot().bindingId;
  assert.equal(pending.operationId,locator.operationId);assert.equal(pending.payloadHash,digest(pending.payloadJson));
  assert.equal(pending.expiresAt,null);assert.equal(pending.authorizationExpiresAt,f.now()+3600);
  await owner.reload();editor=owner.editor();assert.equal(owner.runtime.api.snapshot().bindingId,binding);
  assert.equal((await editor.resumePending()).state,'acknowledged');assert.equal(await editor.pending(),null);
  assert.equal(posts(f,'/v1/profiles/statements').length,1);assert.equal(posts(f,'/v1/consents').length,1);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM profile_statements WHERE id=$1',[locator.operationId])).rows[0].n,1);
  f.faults.dropConsent=true;await assert.rejects(editor.save(input(1,'Second synthetic text')),/lost committed/);
  const second=await editor.pending();await owner.reload();editor=owner.editor();
  assert.equal((await editor.resumePending()).state,'acknowledged');assert.equal((await editor.receiptFor(second)).revision,2);
  assert.equal(posts(f,'/v1/consents').length,2,'the exact accepted Consent is reused after its lost response');
  assert.equal(posts(f,'/v1/profiles/statements').length,2);assert.equal((await editor.ownerRead()).selfDeclared.about,'Second synthetic text');
 }finally{await f.close();}
});

test('known revision conflict preserves original bytes, blocks automatic sends and only an explicit new revision can replace current text',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor(),editor=owner.editor();await editor.save(input());
  const intervening={id:randomUUID(),expectedRevision:1,selfDeclared:{about:'Actual intervening edit'},sharing:{visibility:'Public',viewers:[],expiresAt:null}};
  const submission=await owner.runtime.api.authorizePayload(JSON.stringify(intervening),{action:'profile.publish',objectId:intervening.id,visibility:'Public',expiresAt:f.now()+3600,confirmed:true});
  await owner.runtime.api.call('/v1/profiles/statements',submission);
  const result=await editor.save(input(1,'Retained stale-tab input'));
  assert.equal(result.reason,'profile_revision_conflict');assert.equal(result.canContinue,false);
  const original=await editor.pending(),before={statements:posts(f,'/v1/profiles/statements').length,consents:posts(f,'/v1/consents').length};
  await editor.resumePending();await editor.resumePending();
  assert.deepEqual({statements:posts(f,'/v1/profiles/statements').length,consents:posts(f,'/v1/consents').length},before);
  assert.equal((await editor.ownerRead()).selfDeclared.about,'Actual intervening edit');
  assert.equal((await editor.reviewAuthorization()).canContinue,false);
  const stopped=await editor.stopPending(original);assert.equal(stopped.reason,'stopped-local');
  const archived=await owner.runtime.getLocal(key(owner.runtime));
  assert.equal(archived.stopped[0].payloadJson,original.payloadJson);assert.equal(archived.stopped[0].payloadHash,original.payloadHash);
  const saved=await editor.save(input(2,'Explicitly continued retained input'));assert.equal(saved.revision,3);
  assert.equal((await editor.ownerRead()).selfDeclared.about,'Explicitly continued retained input');
 }finally{await f.close();}
});

test('only the internal submission deadline renews automatically on the original binding; changing binding requires the original-content choice',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor();let editor=owner.editor();
  // Reach a real accepted Consent, then lose connectivity before business write.
  let failBusiness=true;
  // The fixture transport can block only this endpoint, while other real
  // receipts continue. No API response or accepted status is fabricated.
  f.faults.blockProfile=()=>failBusiness;
  await assert.rejects(editor.save(input()),/offline profile/);
  const original=await editor.pending();assert.ok(original);
  f.advance(3601);await owner.reload();editor=owner.editor();failBusiness=false;
  const resumed=await editor.resumePending();assert.equal(resumed.state,'acknowledged');
  assert.equal(resumed.operationId,original.operationId);assert.equal(resumed.payloadHash,original.payloadHash);
  const row=(await f.db.query('SELECT payload_text FROM profile_statements WHERE id=$1',[original.operationId])).rows[0];
  assert.equal(row.payload_text,original.payloadJson);assert.equal(JSON.parse(row.payload_text).sharing.expiresAt,null);
  assert.equal(posts(f,'/v1/consents').length,2,'an expired submission grant is replaced on the same binding, without changing sharing');

  failBusiness=true;await assert.rejects(editor.save(input(1,'Same bytes after a binding change')),/offline profile/);
  const waiting=await editor.pending(),stored=(await owner.runtime.getLocal(key(owner.runtime))).active;
  await owner.runtime.api.call('/v1/consents/'+stored.prepared.intent.id+'/revoke',{});
  await owner.runtime.connect({confirmed:true});editor=owner.editor();
  const before=posts(f,'/v1/consents').length;
  assert.equal((await editor.resumePending()).reason,'authorization-unavailable');assert.equal(posts(f,'/v1/consents').length,before);
  const preview=await editor.reviewAuthorization();assert.equal(preview.state,'reauthorization-required');assert.equal(preview.payloadJson,waiting.payloadJson);assert.equal(preview.expiresAt,null);
  await assert.rejects(editor.reauthorize(structuredClone(preview),{confirmed:true}),/重新核对/);
  failBusiness=false;const continued=await editor.reauthorize(preview,{confirmed:true});
  assert.equal(continued.operationId,waiting.operationId);assert.equal(continued.payloadHash,waiting.payloadHash);assert.equal(continued.state,'acknowledged');
  assert.equal((await editor.ownerRead()).sharing.expiresAt,null);
 }finally{await f.close();}
});

test('original local slot is claimed atomically across editors and late receipt cannot complete a closed or disconnected view',async()=>{
 const f=await profileEditorFixture();try{
  const owner=await f.actor(),first=owner.editor(),second=owner.editor();
  f.faults.dropProfile=true;
  const saves=await Promise.allSettled([first.save(input()),second.save(input())]);
  assert.equal(saves.filter(result=>result.status==='rejected').length,2);
  assert.equal(posts(f,'/v1/profiles/statements').length,1);assert.equal(posts(f,'/v1/consents').length,1);
  const current=await first.pending();assert.ok(current);
  let release;f.faults.waitReceipt=new Promise(resolve=>{release=resolve;});
  const reading=first.resumePending();
  // Wait for the precise read to reach the transport before closing the view.
  while(f.faults.waitReceipt!==null)await new Promise(resolve=>setImmediate(resolve));
  first.close();await owner.runtime.disconnect();release();await assert.rejects(reading);
  const retained=await owner.runtime.getLocal(key(owner.runtime),owner.subjectId);assert.equal(retained.active.payloadJson,current.payloadJson);
  await owner.runtime.connect({confirmed:true});const editor=owner.editor();
  assert.equal((await editor.resumePending()).state,'acknowledged');assert.equal(posts(f,'/v1/profiles/statements').length,1);
 }finally{await f.close();}
});
