import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApi } from '../../galaxy-official/src/http.mjs';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { createNativeA2aHostV2 } from '../src/host-flow-v2.mjs';
import { hash } from '../src/journal.mjs';
import { pythonPeer } from './python-peer.mjs';

test('actual v2 Official HTTP and independent Python SDK recover only proven original unknown Task after restart',
  { skip: !process.env.GALAXY_A2A_PYTHON, timeout: 120000 }, async t => {
  const sources = ['packages/galaxy-a2a/src/bridge.mjs', 'packages/galaxy-a2a/src/host-flow-v2.mjs', 'integrations/native-v2/a2a-tools.mjs'];
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(path))])));
  const peer = await pythonPeer(process.env.GALAXY_A2A_PYTHON); t.after(() => peer.close());
  const f = await serviceFixture(); t.after(() => f.db.close());
  const api = createApi({ ...f, rateLimit: 500, failureAudit: async () => 'stored' });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { api.close(r); api.closeAllConnections(); }));
  const origin = 'http://127.0.0.1:' + api.address().port, http = [], checks = [];
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-a2a-original-http-'));
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); return rm(directory, { recursive: true, force: true }); });
  let current = f.actor.subjectId, generation = 1, principal = 'synthetic-local', clock = Date.now();
  const call = async (path, input, options = {}) => {
    const response = await fetch(origin + path, { method: options.method ?? 'POST', signal: options.signal,
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + f.credential },
      ...(options.method === 'GET' ? {} : { body: JSON.stringify(input) }) });
    http.push({ path, method: options.method ?? 'POST', status: response.status });
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error ?? 'Official read failed'), { status: response.status });
    return value;
  };
  const runtime = { api: { endpoint: f.access.endpoint, call,
    snapshot: () => ({ subjectId: current, bindingId: f.actor.bindingId, generation }) },
    status: async () => ({ identity: current }), authorize: async () => { throw Error('Recovery must not authorize business writes'); } };
  const trustExpiresAt = clock + 600000;
  const options = { runtime, directory, peers: [{ id: 'python', endpoint: peer.endpoint, agentCard: peer.card,
    cardHash: hash(JSON.stringify(peer.card)), trustExpiresAt, peerPrincipal: 'synthetic-local' }], now: () => clock,
    readPeerAuthorization: async () => ({ subjectId: current, peerPrincipal: principal }), post: (...args) => peer.post(...args) };
  let host = createNativeA2aHostV2(options);
  async function attempt() {
    const caseId = randomUUID(), attemptId = randomUUID();
    const root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0,
      actorId: f.actor.subjectId, localRef: randomUUID(), title: 'Synthetic original A2A operation',
      summary: 'PRIVATE original Case is never sent to the independent peer', source: { kind: 'local', reference: randomUUID() }, synthetic: true };
    const rootGrant = await f.authorize(root, 'case.teaser.publish', { objectId: caseId });
    await call('/v2/cases/events', rootGrant);
    const event = { schemaVersion: 2, kind: 'attempt-start', eventId: attemptId, caseId, expectedVersion: 1,
      actorId: f.actor.subjectId, role: 'caller', strategy: 'One reviewed external send',
      inputScopeSummary: 'Only selected text', permissionScope: ['selected-text'] };
    const attemptGrant = await f.authorize(event, 'case.teaser.publish', { objectId: attemptId });
    await call('/v2/cases/events', attemptGrant);
    return { caseId, attemptId, attemptVersion: 1, rootGrant, attemptGrant };
  }
  async function unknown() {
    const { rootGrant, attemptGrant, ...ids } = await attempt(); let response;
    const losing = createNativeA2aHostV2({ ...options, post: async (...args) => { response = await peer.post(...args); throw Error('Lost actual Python accepted ACK'); } });
    const preview = await losing.prepare('python', 'send', { ...ids, text: 'Selected synthetic original operation' });
    await assert.rejects(losing.execute(preview, { confirmed: true }), e => e.code === 'A2A_OUTCOME_UNKNOWN');
    host = createNativeA2aHostV2(options);
    const link = await host.read('python', 'get', preview.associationId);
    assert.equal(link.status, 'unknown'); assert.equal(link.peer?.taskId ?? null, null);
    const task = response.result.task ?? response.result;
    return { ids, rootGrant, attemptGrant, preview, link, query: { operationId: preview.operationId,
      requestHash: link.operations[0].requestHash, candidateTaskId: task.id } };
  }
  const original = await unknown(), before = structuredClone(original.link.operations[0]);
  await assert.rejects(host.read('python', 'poll', original.link.id), /No observed/);
  await assert.rejects(host.prepare('python', 'send', { ...original.ids, text: 'must not resend' }), /already dispatched/);
  const remoteBefore = peer.requests.length, writesBefore = http.filter(r => r.path === '/v2/cases/events').length;
  const recovered = await host.read('python', 'reconcile-task', original.link.id, original.query);
  assert.equal(recovered.state, 'observed'); assert.equal(recovered.association.peer.taskId, original.query.candidateTaskId);
  assert.equal(recovered.association.peer.verification, 'peer-reported');
  assert.equal(recovered.association.operations.length, 1);
  for (const field of ['id', 'requestHash', 'at', 'originalMessage']) assert.deepEqual(recovered.association.operations[0][field], before[field]);
  assert.deepEqual(peer.requests.slice(remoteBefore).map(r => r.method), ['GetTask']);
  assert.equal(http.filter(r => r.path === '/v2/cases/events').length, writesBefore);
  checks.push('actual lost SendMessage ACK → v1 journal restart → bounded exact Python GetTask history recovery');
  const view = await call(`/v2/cases/${original.ids.caseId}/read`, {});
  assert.equal(view.attempts[0].status, 'running'); assert.equal(view.results.length, 0);
  assert.equal(view.resolution.status, 'unrecorded');
  checks.push('peer observation creates no Result, Verification, acceptance, Resolution or Attempt-end');
  const unproven = await unknown();
  const wrong = await host.read('python', 'reconcile-task', unproven.link.id,
    { ...unproven.query, candidateTaskId: original.query.candidateTaskId });
  assert.equal(wrong.state, 'unknown'); assert.deepEqual(await host.read('python', 'get', unproven.link.id), unproven.link);
  checks.push('another real authorized Task does not acquire the unknown original association');
  for (const mutate of [
    task => { task.contextId = 'unrelated-context'; },
    task => { task.history.find(m => m.messageId === unproven.preview.messageId).contextId = 'unrelated-context'; },
    task => { task.history.find(m => m.messageId === unproven.preview.messageId).taskId = 'unrelated-task'; },
  ]) {
    const mismatched = createNativeA2aHostV2({ ...options, post: async (...args) => {
      const response = await peer.post(...args); mutate(response.result.task ?? response.result); return response;
    } });
    assert.equal((await mismatched.read('python', 'reconcile-task', unproven.link.id, unproven.query)).state, 'unknown');
    assert.deepEqual(await host.read('python', 'get', unproven.link.id), unproven.link);
  }
  checks.push('Python-assigned route IDs are verified before normalization; unrelated returned Task/context stays unknown');
  let release, reached;
  const gate = new Promise(r => { release = r; }), held = new Promise(r => { reached = r; });
  const delayed = createNativeA2aHostV2({ ...options, post: async (...args) => { const response = await peer.post(...args); reached(); await gate; return response; } });
  const pending = delayed.read('python', 'reconcile-task', unproven.link.id, unproven.query); await held;
  current = 'GUID' + 'B'.repeat(28); generation++; current = f.actor.subjectId; generation++;
  release(); await assert.rejects(pending, /connection changed/);
  assert.deepEqual(await host.read('python', 'get', unproven.link.id), unproven.link);
  checks.push('A→B→A rejects held original Task observation and keeps exact unknown operation');
  async function heldReject(change, pattern, restore = () => {}) {
    let unlock, arrive;
    const wait = new Promise(r => { arrive = r; }), block = new Promise(r => { unlock = r; });
    const old = createNativeA2aHostV2({ ...options, post: async (...args) => { const response = await peer.post(...args); arrive(); await block; return response; } });
    const pending = old.read('python', 'reconcile-task', unproven.link.id, unproven.query); await wait;
    await change(); unlock(); await assert.rejects(pending, pattern);
    restore();
    assert.deepEqual(await host.read('python', 'get', unproven.link.id), unproven.link);
  }
  await heldReject(async () => { generation++; }, /connection changed/);
  checks.push('same subject/binding with newer generation rejects held result');
  await heldReject(async () => { principal = 'not-approved'; }, /authorization unavailable/, () => { principal = 'synthetic-local'; });
  await heldReject(async () => { clock = trustExpiresAt; }, /AgentCard trust/, () => { clock = trustExpiresAt - 1000; });
  checks.push('principal or Card expiry during held peer response rejects original observation without changing journal');
  const deniedCalls = peer.requests.length; principal = 'not-approved';
  await assert.rejects(host.read('python', 'reconcile-task', unproven.link.id, unproven.query), /authorization unavailable/);
  principal = 'synthetic-local'; assert.equal(peer.requests.length, deniedCalls);
  clock = trustExpiresAt;
  await assert.rejects(host.read('python', 'reconcile-task', unproven.link.id, unproven.query), /AgentCard trust/);
  clock = trustExpiresAt - 1000; assert.equal(peer.requests.length, deniedCalls);
  checks.push('principal and expired Card prevent remote query');
  let unlock, arrive;
  const wait = new Promise(r => { arrive = r; }), block = new Promise(r => { unlock = r; });
  const withdrawing = createNativeA2aHostV2({ ...options, post: async (...args) => { const response = await peer.post(...args); arrive(); await block; return response; } });
  const revoked = withdrawing.read('python', 'reconcile-task', unproven.link.id, unproven.query); await wait;
  await f.consents.revoke(f.actor, unproven.attemptGrant.consentId); unlock();
  await assert.rejects(revoked, /Attempt version, scope or actor changed/);
  assert.deepEqual(await host.read('python', 'get', unproven.link.id), unproven.link);
  assert.ok(http.some(r => r.path === `/v2/cases/${unproven.ids.caseId}/read` && r.status === 200));
  checks.push('actual original Attempt Consent revoked after remote response returns a current partial HTTP200 projection and rejects observation');
  const final = await unknown();
  let unblock, received;
  const responseReady = new Promise(r => { received = r; }), responseHeld = new Promise(r => { unblock = r; });
  const racing = createNativeA2aHostV2({ ...options, post: async (...args) => { const response = await peer.post(...args); received(); await responseHeld; return response; } });
  const oldRead = racing.read('python', 'reconcile-task', final.link.id, final.query); await responseReady;
  const newer = await host.read('python', 'reconcile-task', final.link.id, final.query);
  unblock(); await assert.rejects(oldRead, /association changed/);
  assert.deepEqual(await host.read('python', 'get', final.link.id), newer.association);
  checks.push('concurrent newer exact observation wins over late original revision');
  const dispatches = peer.requests.filter(r => r.method === 'SendMessage').length;
  assert.equal(dispatches, 3); assert.equal(peer.requests.filter(r => r.method === 'CancelTask').length, 0);
  const business = await f.db.query('SELECT kind,count(*)::int count FROM case_events GROUP BY kind ORDER BY kind');
  assert.deepEqual(business.rows.map(r => [r.kind, r.count]), [['attempt-start', 3], ['case-created', 3]]);
  for (const value of [f.actor.subjectId, original.ids.caseId, original.ids.attemptId, 'PRIVATE original Case'])
    assert.ok(!JSON.stringify(peer.requests).includes(value));
  checks.push('exactly three explicitly reviewed sends; recovery has zero business or remote execution writes and no private Galaxy context');
  for (const path of sources) assert.equal(hash(await readFile(path)), sourceHashes[path]);
  const report = { observedAt: new Date().toISOString(), originalTaskId: 'PREP-M21-STEP01', flowId: 'PREP-M21-FLOW01',
    scope: 'actual createApi authenticated v2 HTTP/PGlite + official Python SDK1.1.2 HelloWorld loopback HTTP + durable journal restart + native v2 host; synthetic binding metadata transitions; no physical host or real agent',
    checks, sourceHashes, http, peerMethods: peer.requests.map(r => r.method), dispatches, cancelRequests: 0,
    recoveryBusinessWrites: 0, modelCalls: 0, humanAcceptance: false, passed: true };
  if (process.env.GALAXY_A2A_RECOVERY_REPORT) await writeFile(process.env.GALAXY_A2A_RECOVERY_REPORT, JSON.stringify(report, null, 2) + '\n');
  t.diagnostic(JSON.stringify({ checks: checks.length, dispatches, sourceHashes }));
});
