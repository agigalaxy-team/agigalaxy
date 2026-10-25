import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { outcomeLifecycleFixture, approveOutcomeCopy } from './outcome-material-lifecycle-continuity-workflow.mjs';
import { outcomeMaterialToolDefinitions } from '../src/adapters/mcp/personal/tools/outcome-materials-v2.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');

// Actual signed HTTP/PGlite and production MCP factory. Storage, scanning and
// chat transport remain contract doubles; this is not an SDK or host claim.
test('ordinary MCP attachment reads expose metadata and exact HTTP retrieval, without binary', { timeout: 60000 }, async () => {
  const x = await outcomeLifecycleFixture();
  try {
    const original = await approveOutcomeCopy(x);
    const definitions = outcomeMaterialToolDefinitions({ outcomeMaterials: x.materials }, x.f.actor);
    const input = { id: original.materialId, version: 1 };
    const mcp = await definitions.galaxy_outcome_material_read.run(input);
    const http = await x.post('/v2/outcome-materials/read', input);
    assert.equal(http.status, 200);
    assert.deepEqual(Buffer.from(http.body.bytesBase64, 'base64'), x.bytes);
    assert.equal(Object.hasOwn(mcp, 'bytesBase64'), false);
    assert.equal(Object.hasOwn(mcp, 'content'), false);
    assert.equal(mcp.materialId, original.materialId);
    assert.equal(mcp.source.sha256, x.sha256);
    assert.equal(mcp.size, x.bytes.length);
    assert.equal(mcp.contentAvailable, true);
    assert.equal(mcp.authorization, 'current');
    assert.deepEqual(mcp.fileRetrieval, { via: 'existing-authorized-web-or-http', method: 'POST',
      path: '/v2/outcome-materials/read', input, currentAuthorizationRequired: true });
    // The locator carries no download capability. The original authorization
    // is checked again when the user explicitly uses the existing HTTP route.
    await x.f.consents.revoke(x.f.actor, original.approvalConsentId);
    const unavailable = await definitions.galaxy_outcome_material_read.run(input);
    assert.equal(unavailable.materialId, original.materialId);
    assert.equal(unavailable.contentAvailable, false);
    assert.equal(Object.hasOwn(unavailable, 'bytesBase64'), false);
    assert.equal(Object.hasOwn(unavailable, 'fileRetrieval'), false);
    const lateHttp = await x.post(mcp.fileRetrieval.path, mcp.fileRetrieval.input);
    assert.equal(lateHttp.status, 200);
    assert.equal(lateHttp.body.contentAvailable, false);
    assert.equal(lateHttp.body.bytesBase64, undefined);
  } finally { await x.close(); }
});

test('ordinary MCP preserves independently approved text and withholds it after its own permission expires', { timeout: 60000 }, async () => {
  const x = await outcomeLifecycleFixture();
  try {
    const original = await approveOutcomeCopy(x);
    const parent = await x.materials.inspect(x.f.actor, { id: original.materialId, version: 1 });
    const messages = new Map();
    x.f.chat.transport.send = async input => {
      messages.set(input.messageId, { archiveId: input.messageId, revision: 1, text: input.text });
      return { archiveId: input.messageId };
    };
    x.f.chat.transport.read = async input => input.ids.map(id => messages.get(id)).filter(Boolean);
    const text = 'Synthetic explicitly selected text; no binary content';
    const message = await x.f.chat.send(x.f.actor, x.roomId, { clientMessageId: randomUUID(), text });
    const materialId = randomUUID(), requestId = randomUUID();
    const source = { kind: 'message', id: message.messageId, version: 1, sha256: hash(text), roomId: x.roomId };
    const request = { id: requestId, materialId, kind: 'request', source, caseId: parent.caseId,
      purpose: 'Exact synthetic retained text', title: 'Retained text', audience: { visibility: 'Private', viewers: [] },
      uses: ['evidence'], retention: 'with-related-result; independently-authorized-copy',
      requestExpiresAt: new Date((x.f.now + 300) * 1000).toISOString() };
    const authorizedRequest = await x.f.authorize(request, 'outcome.material', { objectId: requestId });
    const requested = await x.post('/v2/outcome-materials/request', authorizedRequest);
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    const approvalId = randomUUID();
    const approval = { id: approvalId, materialId, kind: 'approve', expectedRevision: 1,
      requestHash: hash(authorizedRequest.payloadJson), source, license: 'authored-content', basis: 'authored-content',
      scope: 'Exactly this synthetic text', expiresAt: new Date((x.f.now + 10) * 1000).toISOString(),
      independentRetention: true, temporarySourceExpiryRevokesCopy: false };
    const authorizedApproval = await x.f.authorize(approval, 'outcome.material', { objectId: approvalId });
    const approved = await x.post('/v2/outcome-materials/approve', authorizedApproval);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const read = outcomeMaterialToolDefinitions({ outcomeMaterials: x.materials }, x.f.actor).galaxy_outcome_material_read;
    const current = await read.run({ id: materialId, version: 1 });
    assert.equal(current.content, text);
    assert.equal(current.contentAvailable, true);
    assert.equal(Object.hasOwn(current, 'bytesBase64'), false);
    assert.equal(Object.hasOwn(current, 'fileRetrieval'), false);
    x.f.now += 11;
    const expired = await read.run({ id: materialId, version: 1 });
    assert.equal(expired.state, 'permission-expired');
    assert.equal(expired.contentAvailable, false);
    assert.equal(Object.hasOwn(expired, 'content'), false);
    assert.equal(Object.hasOwn(expired, 'fileRetrieval'), false);
  } finally { await x.close(); }
});
