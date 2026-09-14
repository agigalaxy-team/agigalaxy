import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerNativeA2aTools } from '../../../integrations/native-v2/a2a-tools.mjs';
import { createNativeChoice } from '../../galaxy-edge-mcp/src/native-v2/choice.mjs';

test('optional A2A tools use real loopback user review, show peer-reported source, and never repeat dispatched work', async t => {
  const subjectId = 'GUID' + 'A'.repeat(28), definitions = new Map(), local = new Map(), associationId = randomUUID();
  const runtime = { status: async () => ({ identity: subjectId }) };
  const server = { server: { getClientCapabilities: () => ({}) }, registerTool: (name, options, run) => definitions.set(name, { options, run }) };
  const choice = createNativeChoice({ identity: () => subjectId, website: 'https://synthetic.example', store: {
    get: async key => local.get(key), put: async (key, value) => local.set(key, value) } });
  t.after(() => choice.close());
  let executed = 0, aborted = 0;
  const host = { peers: () => [{ id: 'peer', endpoint: 'https://peer.example/a2a' }],
    read: async () => ({ id: associationId, peer: { state: 'completed', verification: 'peer-reported' } }),
    prepare: async () => Object.freeze({ kind: 'result', associationId, draft: { event: { eventId: randomUUID() },
      source: { endpoint: 'https://peer.example/a2a', verification: 'peer-reported', responseHash: 'a'.repeat(64) } } }),
    execute: async () => { executed++; return { verification: 'not-provided', resolution: 'separate' }; },
    abort: () => { aborted++; return { localStopped: true, remoteCanceled: false }; } };
  const controller = registerNativeA2aTools(server, { host, runtime, review: (name, input, ctx, fn) => choice.run(server, name, input, ctx, fn) });
  t.after(() => controller.close());
  const call = async (name, input) => { const d = definitions.get(name); return d.run(d.options.inputSchema.parse(input), { mcpReq: { envelope: {} } }); };
  assert.equal(definitions.size, 5);
  const prepared = JSON.parse((await call('galaxy_a2a_prepare', { peerId: 'peer', action: 'result', associationId, summary: 'Selected observation', reportedOutcome: 'inconclusive' })).content[0].text);
  const selected = { operationId: prepared.operationId };
  const pending = JSON.parse((await call('galaxy_a2a_execute', selected)).content[0].text);
  assert.equal(pending.state, 'user-choice-needs-browser'); assert.equal(executed, 0);
  const html = await (await fetch(pending.url)).text(); assert.ok(html.includes('peer-reported')); assert.ok(html.includes('https://peer.example/a2a'));
  const response = await fetch(pending.url, { method: 'POST', headers: { origin: new URL(pending.url).origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=allow' });
  assert.equal(response.status, 200);
  const accepted = await call('galaxy_a2a_execute', selected); assert.equal(JSON.parse(accepted.content[0].text).verification, 'not-provided'); assert.equal(executed, 1);
  const retried = JSON.parse((await call('galaxy_a2a_execute', selected)).content[0].text); assert.equal(retried.remoteResent, false); assert.equal(executed, 1);
  await call('galaxy_a2a_abort_local', selected); assert.equal(aborted, 1);
  assert.throws(() => definitions.get('galaxy_a2a_execute').options.inputSchema.parse({ ...selected, confirmed: true }));
});
