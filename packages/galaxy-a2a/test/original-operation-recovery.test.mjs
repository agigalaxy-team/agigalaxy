import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createA2aBridge } from '../src/protocol/bridge.mjs';
import { sdkPeer } from './sdk-peer.mjs';
import { registerNativeA2aTools } from '../../../integrations/native-v2/a2a-tools.mjs';

async function fixture(t) {
  const peer = await sdkPeer(); t.after(() => peer.close());
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-a2a-original-'));
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); return rm(directory, { recursive: true, force: true }); });
  const subjectId = 'GUID' + 'A'.repeat(28), caseId = randomUUID(), attemptId = randomUUID();
  const options = { endpoint: peer.endpoint, tenant: 'fixture', agentCard: peer.card, directory, subjectId,
    officialEndpoint: 'https://official.example.org', peerPrincipal: 'external-fixture-user',
    authorize: async () => ({ subjectId, peerPrincipal: 'external-fixture-user' }),
    cases: { get: async () => ({ caseId, version: 2, state: 'open', events: [{ kind: 'attempt', id: attemptId }] }) }, post: (...args) => peer.post(...args) };
  let accepted;
  const dropping = createA2aBridge({ ...options, post: async (...args) => {
    const file = join(directory, (await readdir(directory)).find(name => /^a2a-.*\.json$/.test(name)));
    const reserved = JSON.parse(await readFile(file, 'utf8')).links[0];
    assert.equal(reserved.status, 'dispatching');
    assert.equal(reserved.operations[0].originalMessage?.messageId, JSON.parse(args[1].bodyJson).params.message.messageId,
      'the original message locator must already be durable before actual peer HTTP dispatch');
    accepted = await peer.post(...args); throw Error('lost actual SDK ACK');
  } });
  const text = 'Synthetic selected original text: never persist raw request';
  const preview = await dropping.prepareStart({ caseId, attemptId, text });
  await assert.rejects(dropping.execute(preview, preview.confirmation), e => e.code === 'A2A_OUTCOME_UNKNOWN');
  const candidateTaskId = (accepted.result.task ?? accepted.result).id;
  const bridge = createA2aBridge(options), link = await bridge.get(preview.associationId);
  const query = { operationId: preview.operationId, requestHash: link.operations[0].requestHash, candidateTaskId };
  const file = join(directory, (await readdir(directory)).find(name => /^a2a-.*\.json$/.test(name)));
  return { peer, directory, options, preview, bridge, link, query, text, file };
}

test('unknown first SendMessage durably retains original message evidence and exact read recovery never resends', async t => {
  const f = await fixture(t), op = f.link.operations[0];
  assert.equal(op.originalMessage.messageId, f.preview.messageId);
  assert.match(op.originalMessage.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(op.originalMessage.taskId, null); assert.equal(op.originalMessage.contextId, null);
  assert.ok(!JSON.stringify(f.link).includes(f.text));
  const before = structuredClone(op), recovered = await f.bridge.reconcileTask(f.link.id, f.query);
  assert.equal(recovered.state, 'observed'); assert.equal(recovered.association.id, f.link.id);
  assert.equal(recovered.association.peer.taskId, f.query.candidateTaskId);
  assert.equal(recovered.association.peer.verification, 'peer-reported');
  assert.equal(recovered.remoteResent, false);
  assert.equal(recovered.association.operations.length, 1);
  const after = recovered.association.operations[0];
  for (const field of ['id', 'kind', 'requestHash', 'at', 'originalMessage']) assert.deepEqual(after[field], before[field]);
  assert.equal(after.outcome, 'observed');
  assert.deepEqual(f.peer.requests.map(r => r.body.method), ['SendMessage', 'GetTask']);
  await assert.rejects(f.bridge.prepareStart({ caseId: f.link.caseId, attemptId: f.link.attemptId, text: 'duplicate' }), /already dispatched/);
});

test('wrong original IDs, old journals, and unproven or altered Task history retain the same unknown reservation', async t => {
  const f = await fixture(t), original = await readFile(f.file, 'utf8');
  const noChange = async () => assert.deepEqual(await f.bridge.get(f.link.id), f.link);
  for (const query of [{ ...f.query, operationId: randomUUID() }, { ...f.query, requestHash: 'a'.repeat(64) }]) {
    await assert.rejects(f.bridge.reconcileTask(f.link.id, query), /original operation/i); await noChange();
  }
  assert.equal(f.peer.requests.length, 1, 'invalid original locators do not query a peer');
  const old = JSON.parse(original); delete old.links[0].operations[0].originalMessage;
  await writeFile(f.file, JSON.stringify(old));
  const legacy = await f.bridge.reconcileTask(f.link.id, f.query);
  assert.equal(legacy.state, 'unknown'); assert.equal(legacy.reason, 'original-message-unavailable');
  assert.equal(f.peer.requests.length, 1);
  await writeFile(f.file, original);
  for (const change of [
    task => { task.history = []; },
    task => { task.history[0].parts[0].text += ' altered'; },
    task => { task.history[0].role = 'ROLE_AGENT'; },
    task => { task.history[0].metadata = { synthetic: 'different-metadata' }; },
    task => { task.history.push(structuredClone(task.history[0])); },
    task => { task.history[0].taskId = 'different-task'; },
    task => { task.history[0].contextId = 'different-context'; },
    task => { task.id = 'different-task'; },
  ]) {
    const altered = createA2aBridge({ ...f.options, post: async (...args) => {
      const response = await f.peer.post(...args), task = response.result.task ?? response.result;
      change(task); return response;
    } });
    const result = await altered.reconcileTask(f.link.id, f.query);
    assert.equal(result.state, 'unknown'); assert.equal(result.remoteResent, false); await noChange();
  }
  assert.equal(f.peer.requests.filter(r => r.body.method === 'SendMessage').length, 1);
});

test('late original Task observation cannot overwrite a newer journal revision or lost local authority', async t => {
  const f = await fixture(t);
  let release, reached;
  const held = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let current = true;
  const delayed = createA2aBridge({ ...f.options, assertCurrent: () => { if (!current) throw Error('original authority changed'); },
    post: async (...args) => { const response = await f.peer.post(...args); reached(); await gate; return response; } });
  const old = delayed.reconcileTask(f.link.id, f.query); await held;
  const newer = await f.bridge.reconcileTask(f.link.id, f.query);
  release(); await assert.rejects(old, /association changed/);
  assert.deepEqual(await f.bridge.get(f.link.id), newer.association);
  const f2 = await fixture(t);
  let release2, reached2;
  const held2 = new Promise(resolve => { reached2 = resolve; }), gate2 = new Promise(resolve => { release2 = resolve; });
  const lost = createA2aBridge({ ...f2.options, assertCurrent: () => { if (!current) throw Error('original authority changed'); },
    post: async (...args) => { const response = await f2.peer.post(...args); reached2(); await gate2; return response; } });
  const pending = lost.reconcileTask(f2.link.id, f2.query); await held2; current = false; release2();
  await assert.rejects(pending, /authority changed/);
  assert.deepEqual(await f2.bridge.get(f2.link.id), f2.link);
});

test('native read recovery accepts only exact original operation inputs and uses no user-choice or business action', async () => {
  const definitions = new Map(), associationId = randomUUID(), operationId = randomUUID();
  let review = 0, received;
  const host = { read: async (...args) => { received = args; return { state: 'unknown', remoteResent: false }; }, peers: () => [] };
  const controller = registerNativeA2aTools({ registerTool: (name, options, run) => definitions.set(name, { options, run }) },
    { host, runtime: { status: async () => ({ identity: 'GUID' + 'A'.repeat(28) }) }, review: async () => { review++; } });
  try {
    const d = definitions.get('galaxy_a2a_read'), input = { peerId: 'peer', action: 'reconcile-task', associationId,
      operationId, requestHash: 'b'.repeat(64), candidateTaskId: 'externally-known-task' };
    const result = await d.run(d.options.inputSchema.parse(input));
    assert.equal(JSON.parse(result.content[0].text).state, 'unknown'); assert.equal(review, 0);
    assert.deepEqual(received, ['peer', 'reconcile-task', associationId,
      { operationId, requestHash: input.requestHash, candidateTaskId: input.candidateTaskId }]);
    for (const field of ['associationId', 'operationId', 'requestHash', 'candidateTaskId']) {
      const missing = { ...input }; delete missing[field]; assert.throws(() => d.options.inputSchema.parse(missing));
    }
    assert.throws(() => d.options.inputSchema.parse({ ...input, confirmed: true }));
    assert.throws(() => d.options.inputSchema.parse({ peerId: 'peer', action: 'get', associationId, candidateTaskId: 'guess' }));
    assert.equal(d.options.annotations.readOnlyHint, true);
  } finally { controller.close(); }
});
