import test from 'node:test';
import assert from 'node:assert/strict';
import {outcomeLifecycleFixture,approveOutcomeCopy} from './outcome-material-lifecycle-continuity-workflow.mjs';

test('approved independent copy survives temporary source expiry, while actual approval revocation withholds body and preserves exact original receipt',{timeout:60000},async t=>{
 const x=await outcomeLifecycleFixture();try{
  const original=await approveOutcomeCopy(x);
  await x.f.db.query('UPDATE chat_attachments SET uploaded_at=$2,expires_at=$3 WHERE id=$1',[x.attachmentId,
   new Date((x.f.now-30*86400-1)*1000).toISOString(),new Date((x.f.now-1)*1000).toISOString()]);
  const source=await x.post('/v2/outcome-materials/source',{kind:'attachment',id:x.attachmentId,version:1});assert.equal(source.status,404);
  const retained=await x.post('/v2/outcome-materials/read',{id:original.materialId,version:1});
  assert.equal(retained.status,200);assert.equal(retained.body.contentAvailable,true);assert.equal(retained.body.authorization,'current');
  assert.deepEqual(Buffer.from(retained.body.bytesBase64,'base64'),x.bytes);
  await x.f.consents.revoke(x.f.actor,original.approvalConsentId);
  const unavailable=await x.post('/v2/outcome-materials/read',{id:original.materialId,version:1});
  assert.equal(unavailable.status,200);assert.equal(unavailable.body.contentAvailable,false);assert.equal(unavailable.body.bytesBase64,undefined);
  // Existing canonical receipt (also exposed by ordinary MCP); no new HTTP
  // receipt route is implied by this read-lifecycle test.
  const receipt=await x.materials.operationReceipt(x.f.actor,{operationId:original.approvalId,payloadHash:original.approvalHash});
  assert.equal(receipt.operationId,original.approvalId);assert.equal(receipt.state,'recorded');
  assert.equal(receipt.material.contentAvailable,false);assert.equal(receipt.material.materialId,original.materialId);
  assert.equal((await x.contract.store.get({key:'outcome-materials/'+original.materialId})).length,x.bytes.length,
   'denying a read does not silently discard the original copy/operation locator');
  t.diagnostic('independent copy: original temporary source expired; exact approval Consent controls current body; original receipt retained');
 }finally{await x.close();}
});

test('exact requester Consent expiring during independent copy storage await withholds its late bytes even while copy TTL remains live',{timeout:60000},async t=>{
 const x=await outcomeLifecycleFixture();try{
  const original=await approveOutcomeCopy(x,{requestGrantSeconds:10,copyPermissionSeconds:300});
  const get=x.contract.store.get.bind(x.contract.store);let crossed=false;
  x.contract.store.get=async input=>{const bytes=await get(input);if(!crossed&&input.key.startsWith('outcome-materials/')){crossed=true;x.f.now+=11;}return bytes;};
  const response=await x.post('/v2/outcome-materials/read',{id:original.materialId,version:1});
  assert.equal(crossed,true);assert.equal(response.status,200);assert.equal(response.body.state,'available','copy TTL itself is still live');
  assert.equal(response.body.contentAvailable,false);assert.equal(response.body.reason,'consent_required');assert.equal(response.body.bytesBase64,undefined);
  const receipt=await x.materials.operationReceipt(x.f.actor,{operationId:original.requestId,payloadHash:original.requestHash});
  assert.equal(receipt.state,'recorded');assert.equal(receipt.operationId,original.requestId);assert.equal(receipt.material.contentAvailable,false);
  t.diagnostic('late copy read: actual exact requester Consent expired, no body/current assertion; original operation ID/hash remains recorded');
 }finally{await x.close();}
});
