import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {capsuleWebContinuityFixture} from '../../galaxy-official/test/capsule-web-continuity-fixture.mjs';
import {createCapsuleWebClient} from "../src/features/capsules/capsule-workspace-client.mjs";
import {ServiceError} from '../../galaxy-official/src/shared/service-error.mjs';

const writes=f=>({consents:f.requests.filter(r=>r.path==='/v1/consents').length,
  publications:f.requests.filter(r=>r.path==='/v2/capsules/events').length,
  revokes:f.requests.filter(r=>/^\/v1\/consents\/[^/]+\/revoke$/.test(r.path)).length});
const current=f=>f.author.runtime.getLocal(`capsule-operations:${f.author.runtime.api.endpoint}:${f.author.identity.subjectId}`);
async function prepare(f){const selected=await f.author.client.resolvePublication(f.payload,{visibility:'Private'});
  assert.equal(selected.preview.readyForPublication,true);return f.author.client.prepare('publication',selected.payload,{visibility:'Private'});}
async function publish(f){const preview=await prepare(f),receipt=await f.author.client.execute(preview,{confirmed:true});return{preview,receipt,
  target:{type:'publication',operationId:preview.operationId,payloadHash:preview.payloadHash,consentId:receipt.consentId}};}

test('Private preview automatically reuses a compatible current license, reports its exact coverage, and never treats reading as public permission',async t=>{
  const f=await capsuleWebContinuityFixture();t.after(()=>f.close());const before=writes(f),input=JSON.stringify(f.payload);
  const selected=await f.author.client.resolvePublication(f.payload,{visibility:'Private'});
  assert.equal(JSON.stringify(f.payload),input);assert.deepEqual(selected.permissionRefs,[f.permission.id]);
  assert.equal(selected.preview.readyForPublication,true);assert.equal(selected.preview.readyForPublicPublication,false);
  assert.ok(selected.preview.sourceCoverage.dependencies.every(item=>item.covered));
  assert.ok(selected.preview.sourceCoverage.dependencies.some(item=>item.authorId===f.sourceAuthor.identity.subjectId&&item.permissionIds.includes(f.permission.id)));
  const publicly=await f.author.client.resolvePublication(f.payload,{visibility:'Public'});
  assert.equal(publicly.preview.readyForPublication,false);assert.equal(publicly.preview.reason,'capsule_source_permission_required');
  assert.deepEqual(publicly.permissionRefs,[]);assert.deepEqual(writes(f),before);
  const revoke={schemaVersion:2,kind:'revoke',id:randomUUID(),permissionId:f.permission.id,reason:'Synthetic source owner stops this one license.'};
  await f.sourceAuthor.write('/v2/capsules/permissions',revoke,'capsule.permission',{viewers:[f.author.identity.subjectId]});
  const unavailable=await f.author.client.resolvePublication({...f.payload,permissionRefs:[f.permission.id]},{visibility:'Private'});
  assert.deepEqual(unavailable.unavailablePermissionIds,[f.permission.id]);assert.equal(unavailable.preview.readyForPublication,false);
  const exact=await f.author.client.permission(f.permission.id);assert.equal(exact.revoked,true);
});

test('selected-message preview returns only exact currently readable text; retracting or reaching TTL hides it without copying body into a published method',async t=>{
  const f=await capsuleWebContinuityFixture();t.after(()=>f.close());
  const ref={kind:'selected-message',id:f.message.messageId,version:1},payload={...f.payload,sourceRefs:[f.otherRef,ref],permissionRefs:[f.permission.id]};
  const visible=await f.author.client.preview(payload,{visibility:'Private'}),selected=visible.sourceCoverage.sources.find(item=>item.ref.kind==='selected-message');
  assert.equal(selected.authorId,f.sourceAuthor.identity.subjectId);assert.match(selected.reading.text,/准确消息片段/);
  assert.equal(selected.reading.roomId,f.roomId);assert.equal(selected.reading.publicationPermission,false);
  assert.equal(visible.readyForPublication,false); // Current room read is not a publication license.
  await f.sourceAuthor.runtime.api.call(`/v2/chat/rooms/${f.roomId}/messages/${f.message.messageId}/retract`,{});
  const unavailable=await f.author.client.preview(payload,{visibility:'Private'});
  assert.equal(unavailable.readyForPublication,false);assert.equal(unavailable.sourceCoverage,undefined);assert.equal(JSON.stringify(unavailable).includes('准确消息片段'),false);
  const another=await f.sourceAuthor.runtime.chat.send(f.roomId,'[本地合成] A second exact TTL-bound message.',{confirmed:true}),ttlRef={kind:'selected-message',id:another.messageId,version:1};
  // Only this isolated TTL-boundary test shortens stored message metadata. It
  // does not claim that the normal room UI selects a two-second retention.
  await f.f.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[another.messageId,new Date((f.now()+2)*1000).toISOString()]);
  let advanced=false;f.hooks.beforeArchiveRead=async()=>{if(!advanced){advanced=true;f.advance(3);}};
  // Authorization at the start is real; expiry while the transport awaits must
  // not return the already selected text. This advances only an isolated clock.
  const expired=await f.author.client.preview({...payload,sourceRefs:[f.otherRef,ttlRef]},{visibility:'Private'});
  assert.equal(expired.readyForPublication,false);assert.equal(expired.sourceCoverage,undefined);
  assert.equal(JSON.stringify(expired).includes('TTL-bound'),false);
});

test('lost publication ACK is reconciled before sending and receipt locators survive journal cleanup',async t=>{
  const f=await capsuleWebContinuityFixture();t.after(()=>f.close());let lose=true,locator;
  const preview=await prepare(f);f.hooks.afterResponse=async(path,response)=>{if(lose&&path==='/v2/capsules/events'&&response.ok){lose=false;throw Error('synthetic lost original publication ACK');}};
  await assert.rejects(f.author.client.execute(preview,{confirmed:true,onJournal:async value=>{locator=value;
    assert.equal((await current(f)).active.payloadHash,value.payloadHash);assert.equal(writes(f).publications,0);}}),/lost original publication ACK/);
  const original=(await current(f)).active,before=writes(f),receipt=await f.author.client.resumePending();
  assert.equal(receipt.state,'acknowledged');assert.deepEqual(writes(f),before);assert.equal((await current(f)).active,null);
  assert.equal((await f.author.client.receiptFor(locator)).state,'acknowledged');
  const rows=(await f.f.db.query('SELECT payload_text,payload_hash,consent_id FROM capsule_events WHERE id=$1',[preview.operationId])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].payload_text,original.payloadJson);assert.equal(rows[0].payload_hash,original.payloadHash);assert.equal(rows[0].consent_id,original.submission.consentId);
});

test('definite publication rejection blocks automatic business POST while exact receipts continue; human continuation keeps the original JSON, Consent and deadline',async t=>{
  const f=await capsuleWebContinuityFixture();t.after(()=>f.close());const service=f.f.owner.capsules.v2,actual=service.publish.bind(service);let blocked=true;
  service.publish=(...args)=>{if(blocked)throw new ServiceError('capsule_source_permission_required',403);return actual(...args);};
  const preview=await prepare(f);await assert.rejects(f.author.client.execute(preview,{confirmed:true}),{code:'capsule_source_permission_required',status:403});
  const original=(await current(f)).active,before=writes(f);
  for(let i=0;i<3;i++)assert.equal((await f.author.client.resumePending()).reason,'business-rejected');
  assert.deepEqual(writes(f),before);assert.equal((await current(f)).active.payloadJson,original.payloadJson);
  blocked=false;assert.equal((await f.author.client.resumePending()).reason,'business-rejected');
  const review=await f.author.client.reviewAuthorization(preview.operationId);assert.equal(review.state,'retry-original');
  assert.equal((await f.author.client.retry(preview.operationId,{confirmed:true})).state,'acknowledged');
  assert.equal(writes(f).publications,before.publications+1);assert.equal(writes(f).consents,before.consents);
  const row=(await f.f.db.query('SELECT payload_text,payload_hash,consent_id FROM capsule_events WHERE id=$1',[preview.operationId])).rows[0];
  assert.equal(row.payload_text,original.payloadJson);assert.equal(row.payload_hash,original.payloadHash);assert.equal(row.consent_id,original.submission.consentId);
  const consent=(await f.f.db.query('SELECT intent FROM consents WHERE id=$1',[row.consent_id])).rows[0];assert.equal(consent.intent.expiresAt,original.authorizationExpiresAt);
});

test('original Consent ACK takes priority over signature ageing and a stopped concurrent head causes zero automatic writes',async t=>{
  const f=await capsuleWebContinuityFixture();t.after(()=>f.close());let fail=true;
  f.hooks.afterResponse=async(path,response)=>{if(fail&&path==='/v1/consents'&&response.ok){fail=false;throw Error('synthetic lost Consent ACK');}};
  const preview=await prepare(f);await assert.rejects(f.author.client.execute(preview,{confirmed:true}),/lost Consent ACK/);
  const original=(await current(f)).active;f.advance(301);const accepted=await f.author.client.resumePending();assert.equal(accepted.state,'acknowledged');
  // The original Consent did reach the service. Its exact ACK takes priority
  // over the old transport signature, with no replacement Consent.
  assert.equal((await f.f.db.query('SELECT count(*) AS n FROM consents WHERE intent->>\'objectId\'=$1',[preview.operationId])).rows[0].n,1);
  assert.equal((await f.f.db.query('SELECT intent FROM consents WHERE id=$1',[original.prepared.intent.id])).rows[0].intent.expiresAt,original.authorizationExpiresAt);
  let release,entered;const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),api=f.author.runtime.api;
  const wrapped={...api,prepareAuthorization:async(...args)=>{const value=await api.prepareAuthorization(...args);entered();await held;return value;}},client=createCapsuleWebClient({...f.author.clientOptions,api:wrapped});
  const second=await client.prepare('publication',{...f.payload,id:randomUUID(),capsuleId:randomUUID(),permissionRefs:[f.permission.id]},{visibility:'Private'});
  const sending=client.execute(second,{confirmed:true});await started;const before=writes(f);
  await f.author.client.stopLocalRetry(second.operationId,{confirmed:true});release();await assert.rejects(sending,{code:'capsule_operation_changed'});
  assert.deepEqual(writes(f),before);assert.equal((await current(f)).active,null);assert.equal((await current(f)).stopped[0].operationId,second.operationId);
  assert.equal((await f.author.client.resumePending()).state,'none');assert.deepEqual(writes(f),before);
});

test('only transport signature ageing automatically renews a same-binding valid choice; absent Consent after binding change returns the exact original for review',async t=>{
  const f=await capsuleWebContinuityFixture();t.after(()=>f.close());let fail=true;
  f.hooks.beforeRequest=async path=>{if(fail&&path==='/v1/consents'){fail=false;throw Error('synthetic transport failed before Consent acceptance');}};
  const preview=await prepare(f);await assert.rejects(f.author.client.execute(preview,{confirmed:true}),/before Consent acceptance/);
  const original=(await current(f)).active,before=writes(f);f.advance(301);
  assert.equal((await f.author.client.resumePending()).state,'acknowledged');
  assert.equal(writes(f).consents,before.consents+1);assert.equal(writes(f).publications,before.publications+1);
  const row=(await f.f.db.query('SELECT payload_text,payload_hash,consent_id FROM capsule_events WHERE id=$1',[preview.operationId])).rows[0];
  assert.equal(row.payload_text,original.payloadJson);assert.equal(row.payload_hash,original.payloadHash);
  assert.notEqual(row.consent_id,original.prepared.intent.id);
  assert.equal((await f.f.db.query('SELECT intent FROM consents WHERE id=$1',[row.consent_id])).rows[0].intent.expiresAt,original.authorizationExpiresAt);
  const second=await f.author.client.prepare('publication',{...f.payload,id:randomUUID(),capsuleId:randomUUID(),permissionRefs:[f.permission.id]},{visibility:'Private'});
  fail=true;await assert.rejects(f.author.client.execute(second,{confirmed:true}),/before Consent acceptance/);
  const pending=(await current(f)).active;await f.author.runtime.connect({confirmed:true});const rebound=writes(f);
  assert.equal((await f.author.client.resumePending()).reason,'original-binding-changed');assert.deepEqual(writes(f),rebound);
  assert.equal((await current(f)).active.payloadJson,pending.payloadJson);
  const review=await f.author.client.reviewAuthorization(second.operationId);
  assert.equal(review.state,'reauthorization-required');assert.equal(review.expiresAt,pending.authorizationExpiresAt);
  assert.equal(review.payloadHash,pending.payloadHash);assert.equal(review.payloadJson,pending.payloadJson);
  assert.equal((await f.author.client.reauthorize(second.operationId,review,{confirmed:true})).state,'acknowledged');
  assert.equal(writes(f).publications,rebound.publications+1);
  assert.equal((await f.f.db.query('SELECT payload_text FROM capsule_events WHERE id=$1',[second.operationId])).rows[0].payload_text,pending.payloadJson);
});

test('visibility withdrawal preserves exact target and only reads after lost ACK; changed connection invalidates old preview and terminal receipt never means current body access',async t=>{
  const f=await capsuleWebContinuityFixture();t.after(()=>f.close());const published=await publish(f),preview=await f.author.visibility.prepare(published.target),before=writes(f);
  await f.author.runtime.connect({confirmed:true});await assert.rejects(f.author.visibility.execute(preview,{confirmed:true}),{code:'capsule_visibility_identity_changed'});assert.deepEqual(writes(f),before);
  const currentPreview=await f.author.visibility.prepare(published.target);let lose=true,locator;
  f.hooks.afterResponse=async(path,response)=>{if(lose&&path.endsWith('/revoke')&&response.ok){lose=false;throw Error('synthetic lost exact withdrawal ACK');}};
  await assert.rejects(f.author.visibility.execute(currentPreview,{confirmed:true,onJournal:value=>{locator=value;}}),/withdrawal ACK/);
  const after=writes(f);assert.equal((await f.author.visibility.resumePending(published.target.consentId)).state,'revoked');assert.deepEqual(writes(f),after);
  const receipt=await f.author.visibility.receiptFor(locator);assert.equal(receipt.state,'acknowledged');assert.equal(receipt.currentReadPermissionConfirmed,false);
  assert.equal(receipt.consentId,published.target.consentId);assert.equal(receipt.payloadHash,published.target.payloadHash);
  assert.equal(writes(f).consents,before.consents);assert.equal(writes(f).revokes,before.revokes+1);
  assert.equal((await f.f.db.query('SELECT count(*) AS n FROM capsule_events WHERE id=$1',[published.target.operationId])).rows[0].n,1);
});

test('definite withdrawal rejection stops automatic retries and explicit continuation uses the same original Consent without new authorization',async t=>{
  const f=await capsuleWebContinuityFixture();t.after(()=>f.close());const published=await publish(f),service=f.f.owner.consents,actual=service.revoke.bind(service);let blocked=true;
  service.revoke=(...args)=>{if(blocked)throw new ServiceError('consent_required',403);return actual(...args);};
  const preview=await f.author.visibility.prepare(published.target);await assert.rejects(f.author.visibility.execute(preview,{confirmed:true}),{status:403});
  const before=writes(f);for(let i=0;i<3;i++)assert.equal((await f.author.visibility.resumePending(published.target.consentId)).reason,'business-rejected');assert.deepEqual(writes(f),before);
  blocked=false;assert.equal((await f.author.visibility.resumePending(published.target.consentId)).reason,'business-rejected');
  const original=await f.author.visibility.reviewPending(published.target.consentId);assert.deepEqual(original.target,published.target);
  assert.equal((await f.author.visibility.resumePending(published.target.consentId,{explicitRetry:true})).state,'revoked');
  assert.equal(writes(f).revokes,before.revokes+1);assert.equal(writes(f).consents,before.consents);
});
