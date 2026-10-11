import test from 'node:test';
import assert from 'node:assert/strict';
import {outcomeLifecycleFixture,approveOutcomeCopy} from './outcome-material-lifecycle-continuity-workflow.mjs';

test('author inspection returns the current original filename without storage bytes and removes it after original revocation', {timeout:60000}, async()=>{
  const x=await outcomeLifecycleFixture();
  try{
    const selected=await approveOutcomeCopy(x),get=x.f.attachments.store.get;let reads=0;
    x.f.attachments.store.get=async()=>{reads++;throw Error('inspect must not fetch storage bytes');};
    const inspected=await x.post('/v2/outcome-materials/inspect',{id:selected.materialId,version:1});
    assert.equal(inspected.status,200);assert.equal(inspected.body.sourceName,'selected.txt');assert.equal(inspected.body.sourceMediaType,'text/plain');
    assert.equal(inspected.body.sourceContent,null);assert.equal(inspected.body.sourceContentReason,null);assert.equal(reads,0);
    assert.equal(inspected.body.bytesBase64,undefined);assert.equal(inspected.body.bytes,undefined);assert.ok(inspected.body.sourceReadExpiresAt>x.f.now);
    await x.f.attachments.revoke(x.f.actor,{attachmentId:x.attachmentId});
    const revoked=await x.post('/v2/outcome-materials/inspect',{id:selected.materialId,version:1});assert.equal(revoked.status,200);
    assert.equal(revoked.body.sourceName,null);assert.equal(revoked.body.sourceMediaType,null);assert.equal(revoked.body.sourceContentReason,'attachment_content_unavailable');
    assert.equal(reads,0);x.f.attachments.store.get=get;
    assert.equal((await x.post('/v2/outcome-materials/read',{id:selected.materialId,version:1})).body.contentAvailable,true,
      'original metadata permission does not erase an independently approved copy');
  }finally{await x.close();}
});
