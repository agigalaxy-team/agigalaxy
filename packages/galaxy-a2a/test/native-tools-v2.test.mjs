import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerNativeA2aTools } from '../../../integrations/native-v2/a2a-tools.mjs';
import { createNativeChoice } from '../../galaxy-edge-mcp/src/native-v2/interaction/choice.mjs';

for (const scope of [
  { visibility: 'Public', viewers: [], label: '所有人' },
  { visibility: 'Private', viewers: ['GUID' + 'B'.repeat(28)], label: '自己与所选接收方' },
]) test(`optional A2A tools review ${scope.visibility} Result content and exact source through loopback without repeating dispatched work`, async t => {
  const subjectId = 'GUID' + 'A'.repeat(28), definitions = new Map(), local = new Map(), associationId = randomUUID();
  const runtime = { status: async () => ({ identity: subjectId }) };
  const server = { server: { getClientCapabilities: () => ({}) }, registerTool: (name, options, run) => definitions.set(name, { options, run }) };
  const choice = createNativeChoice({ identity: () => subjectId, website: 'https://synthetic.example', store: {
    get: async key => local.get(key), put: async (key, value) => local.set(key, value) } });
  t.after(() => choice.close());
  let executed = 0, aborted = 0, exactPreview;
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const host = { peers: () => [{ id: 'peer', endpoint: 'https://peer.example/a2a' }],
    read: async () => ({ id: associationId, peer: { state: 'completed', verification: 'peer-reported' } }),
    prepare: async (peerId, action, input) => {
      assert.equal(peerId, 'peer'); assert.equal(action, 'result'); assert.equal(input.associationId, associationId);
      const event = { schemaVersion: 2, kind: 'result-recorded', eventId: randomUUID(),
        summary: input.summary, reportedOutcome: input.reportedOutcome, limitations: input.limitations };
      exactPreview = Object.freeze({ kind: 'result', associationId, draft: { event,
        source: { endpoint: 'https://peer.example/a2a', verification: 'peer-reported', responseHash: 'a'.repeat(64) } },
        authorization: { requestId: randomUUID(), action: 'case.teaser.publish', objectId: event.eventId,
          payloadJson: JSON.stringify(event), visibility: input.visibility, viewers: input.viewers, expiresAt: input.expiresAt } });
      return exactPreview;
    },
    execute: async (preview, options) => {
      assert.equal(preview, exactPreview); assert.deepEqual(options, { confirmed: true });
      executed++; return { verification: 'not-provided', resolution: 'separate' };
    },
    abort: () => { aborted++; return { localStopped: true, remoteCanceled: false }; } };
  const controller = registerNativeA2aTools(server, { host, runtime, review: (name, input, ctx, fn) => choice.run(server, name, input, ctx, fn) });
  t.after(() => controller.close());
  const call = async (name, input) => { const d = definitions.get(name); return d.run(d.options.inputSchema.parse(input), { mcpReq: { envelope: {} } }); };
  assert.equal(definitions.size, 5);
  const prepared = JSON.parse((await call('galaxy_a2a_prepare', { peerId: 'peer', action: 'result', associationId,
    summary: 'Selected observation', reportedOutcome: 'inconclusive', limitations: 'Only covers this peer observation.',
    visibility: scope.visibility, viewers: scope.viewers, expiresAt })).content[0].text);
  const selected = { operationId: prepared.operationId };
  const pending = JSON.parse((await call('galaxy_a2a_execute', selected)).content[0].text);
  assert.equal(pending.state, 'user-choice-needs-browser'); assert.equal(executed, 0);
  const page = await fetch(pending.url); assert.equal(page.status, 200);
  const html = await page.text();
  for (const content of ['保留这次结果', 'Selected observation', '暂不能得出结论',
    'Only covers this peer observation.', '可见范围', scope.label, '<dt>有效至</dt>']) assert.ok(html.includes(content), content);
  for (const viewer of scope.viewers) assert.ok(html.includes(viewer));
  assert.equal(executed, 0);
  const sourceLink = html.match(/href="([^"]+\?download=1)" download="galaxy-operation.json"/);
  assert.ok(sourceLink, 'The full operation remains available from its actual source link');
  const source = await fetch(new URL(sourceLink[1], pending.url)); assert.equal(source.status, 200);
  const diagnostic = await source.json();
  assert.deepEqual(diagnostic, { operation: 'galaxy_a2a_execute', identity: subjectId,
    input: { operationId: selected.operationId, preview: prepared.preview } });
  assert.equal(diagnostic.input.preview.draft.source.verification, 'peer-reported');
  assert.equal(diagnostic.input.preview.draft.source.endpoint, 'https://peer.example/a2a');
  assert.equal(diagnostic.input.preview.draft.source.responseHash, 'a'.repeat(64));
  assert.equal(diagnostic.input.preview.authorization.visibility, scope.visibility);
  assert.deepEqual(diagnostic.input.preview.authorization.viewers, scope.viewers);
  assert.equal(diagnostic.input.preview.authorization.expiresAt, expiresAt); assert.equal(executed, 0);
  const response = await fetch(pending.url, { method: 'POST', headers: { origin: new URL(pending.url).origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=allow' });
  assert.equal(response.status, 200); assert.equal(executed, 0);
  const accepted = await call('galaxy_a2a_execute', selected); assert.equal(JSON.parse(accepted.content[0].text).verification, 'not-provided'); assert.equal(executed, 1);
  const retried = JSON.parse((await call('galaxy_a2a_execute', selected)).content[0].text); assert.equal(retried.remoteResent, false); assert.equal(executed, 1);
  await call('galaxy_a2a_abort_local', selected); assert.equal(aborted, 1);
  assert.throws(() => definitions.get('galaxy_a2a_execute').options.inputSchema.parse({ ...selected, confirmed: true }));
});
