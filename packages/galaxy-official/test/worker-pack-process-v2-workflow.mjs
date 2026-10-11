import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildersContinuityFixture } from './builders-client-continuity-workflow.mjs';
import { configurationExample } from './configuration-v2-workflow.mjs';
import { createNativeA2aHostV2 } from '../../galaxy-a2a/src/host-flow-v2.mjs';
import { createWorkerPackHostFlowV2 } from '../../galaxy-a2a/src/worker-pack-flow-v2.mjs';
import { createReferenceWorkerManifest } from '../../../integrations/reference-worker-pack/manifest.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const endpoint = 'https://reference-worker.example.org/a2a';
async function cleanupJournal(directory) {
  const temporaryRoot = await realpath(tmpdir());
  const target = await realpath(resolve(directory));
  const child = relative(temporaryRoot, target);
  assert.ok(isAbsolute(target) && child && child !== '..' && !child.startsWith('..\\')
    && !child.startsWith('../') && !isAbsolute(child), 'Journal cleanup must remain under the temporary root');
  assert.ok(basename(target).startsWith('galaxy-reference-worker-journal-')
    && basename(target).length > 'galaxy-reference-worker-journal-'.length, 'Unexpected journal cleanup target');
  await rm(target, { recursive: true, force: true });
}
// Only this reviewed file and the current absolute Node executable may run.
// No model/tool/user value is interpreted as a command or executable path.
export async function startReferenceProcess() {
  const path = await realpath(fileURLToPath(new URL('../../../integrations/reference-worker-pack/worker.mjs', import.meta.url)));
  const executable = await realpath(process.execPath), sourceHash = hash(await readFile(path));
  const sdkHash = hash(await readFile(new URL('../../galaxy-a2a/node_modules/@a2a-js/sdk/package.json', import.meta.url)));
  const child = fork(path, [endpoint], { execPath: executable, execArgv: [], windowsHide: true,
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let closed = false, stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const first = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(Error('Reference process start timeout')), 8000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16384) { clearTimeout(timer); reject(Error('Unexpected reference stdout')); }
      if (buffer.includes('\n')) {
        clearTimeout(timer);
        try { resolve(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Reference process exited before ready: ' + stderr)); });
  }).catch(async error => { child.kill(); await exited; throw error; });
  assert.equal(first.endpoint, endpoint); assert.ok(first.port > 0 && first.port <= 65535);
  const requests = [], state = { loseSendAck: false, afterResponse: null };
  return { card: first.card, sourceHash, sdkHash, requests, state,
    async post(url, input) {
      assert.equal(url, endpoint); assert.equal(input.credential, undefined);
      const body = JSON.parse(input.bodyJson); requests.push(body.method);
      const response = await fetch(`http://127.0.0.1:${first.port}/a2a`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: input.bodyJson, signal: input.signal });
      assert.equal(response.status, 200); const output = await response.json();
      if (state.afterResponse) { const hook = state.afterResponse; state.afterResponse = null; await hook(); }
      if (body.method === 'SendMessage' && state.loseSendAck) { state.loseSendAck = false; throw Error('Synthetic lost peer ACK after real execution'); }
      return output;
    },
    async observations() {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const listener = message => { if (message?.kind === 'observations' && message.id === id) {
          clearTimeout(timer); child.off('message', listener); const { kind: _kind, id: _id, ...observation } = message; resolve(observation); } };
        const timer = setTimeout(() => { child.off('message', listener); reject(Error('Reference observation timeout')); }, 3000);
        child.on('message', listener); child.send({ kind: 'observations', id });
      });
    },
    async close() {
      if (closed) return; closed = true;
      if (child.connected) child.send({ kind: 'shutdown' }); else child.kill();
      const timeout = setTimeout(() => child.kill(), 5000);
      const [code, signal] = await exited; clearTimeout(timeout);
      assert.equal(code, 0, 'reference shutdown exit'); assert.equal(signal, null); assert.equal(stderr, '');
      return { exitCode: code, signal, stderrEmpty: true };
    } };
}

export async function referenceWorkerProcessFixture({peerTrustLifetimeMs=120000}={}) {
  if(!Number.isSafeInteger(peerTrustLifetimeMs)||peerTrustLifetimeMs<120000||peerTrustLifetimeMs>7200000)
    throw new RangeError('reference_fixture_peer_trust_lifetime_out_of_range');
  const processWorker = await startReferenceProcess(); let f, directory;
  try {
  f = await buildersContinuityFixture();
  directory = await mkdtemp(join(tmpdir(), 'galaxy-reference-worker-journal-'));
  const source = 'https://reference-worker.example.org/releases/0.1.0/worker.mjs';
  const declaration = f.event.declaration;
  declaration.name = 'Explicitly selected reference arithmetic Worker';
  declaration.scope = 'Synthetic selected arithmetic; user-host process';
  declaration.release.buildHash = processWorker.sourceHash;
  declaration.release.artifact = source;
  declaration.release.dependencies = [{ name: '@a2a-js/sdk/package.json', version: '1.1.0', sha256: processWorker.sdkHash }];
  declaration.configuration = { id: 'reference-node-a2a-1', summary: 'Fixed Node process and numerical input only',
    modelFamily: 'none', tools: ['A2A 1.0 JSONRPC'], taskTypes: ['arithmetic-reference'], maxConcurrentTasks: 1 };
  declaration.capabilities = [{ id: 'arithmetic-reference', claim: 'Finite arithmetic reference', limitations: 'No measured independent value or capability certification' }];
  await f.client.submit(f.event, { confirmed: true, visibility: 'Public' });
  const builder = await f.client.read(f.event.builderId, true), manifestId = randomUUID();
  await f.client.submit({ id: manifestId, builderId: f.event.builderId, kind: 'pack-manifest', expectedRevision: builder.entry.revision,
    declarationId: builder.entry.declarationId, declarationHash: builder.entry.declarationHash,
    manifest: createReferenceWorkerManifest({ source, sourceHash: processWorker.sourceHash,
      licenseSource: 'https://www.apache.org/licenses/LICENSE-2.0' }) }, { confirmed: true, visibility: 'Public' });
  const pack = await f.workerClient.manifest({ builderId: f.event.builderId, manifestId });
  assert.equal(pack.manifest.sha256, processWorker.sourceHash); assert.equal(pack.manifest.automaticActivation, false);
  await f.client.exportPack(f.event.builderId, manifestId);
  assert.equal((await processWorker.observations()).starts, 0, 'register/read/export never starts work');
  const baseApi = f.runtime.api, controls = { loseResultAck: false };
  const runtime = { ...f.runtime, api: { ...baseApi, async call(path, input, options) {
    const value = await baseApi.call(path, input, options);
    if (path === '/v2/cases/events' && controls.loseResultAck && JSON.parse(input.payloadJson).kind === 'result-recorded') {
      controls.loseResultAck = false; throw Error('Synthetic lost Result ACK after real commit');
    }
    return value;
  } }, status: async () => ({ identity: f.api.snapshot()?.subjectId }), authorize: input => f.api.authorizePayload(input.payloadJson,
    { action: input.action, objectId: input.objectId, id: input.requestId, visibility: input.visibility, viewers: input.viewers,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), confirmed: true }) };
  const peerTrustExpiresAt=Date.now()+peerTrustLifetimeMs;
  const a2a = createNativeA2aHostV2({ runtime, directory, peers: [{ id: 'reference', endpoint, tenant: '', peerPrincipal: 'local-owner',
    agentCard: processWorker.card, cardHash: hash(JSON.stringify(processWorker.card)), trustExpiresAt: peerTrustExpiresAt }],
    readPeerAuthorization: async input => ({ subjectId: input.subjectId, peerPrincipal: 'local-owner' }),
    post: (...args) => processWorker.post(...args) });
  const flow = createWorkerPackHostFlowV2({ runtime, a2a, packUses: f.workerClient, workers: [{ id: 'reference', peerId: 'reference',
    pack: { builderId: pack.builderId, manifestId: pack.manifestId, manifestHash: pack.manifestHash },
    sourceHash: processWorker.sourceHash, version: '0.1.0' }] });
  const publish = async (path, event, action) => f.api.call(path, await f.api.authorizePayload(event,
    { action, objectId: event.operationId ?? event.eventId ?? event.id, confirmed: true }));
  const config = configurationExample(f.f.actor);
  config.observedAt = new Date(f.f.now * 1000).toISOString();
  config.conditions.runtime = { name: 'Node', version: process.versions.node };
  config.conditions.tools = [{ name: '@a2a-js/sdk', version: '1.1.0' }];
  config.conditions.environment = { name: 'isolated-loopback-reference-process', version: '0.1.0' };
  config.conditions.limitations = 'Synthetic arithmetic inputs; actual process and protocol; no model or independent operator';
  await publish('/v2/configurations/events', config, 'configuration.publish');
  const fact = async purpose => {
    const caseId = randomUUID(), root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId,
      expectedVersion: 0, actorId: f.f.actor.subjectId, localRef: randomUUID(), title: '受控参考 Worker 过程',
      summary: purpose, synthetic: true, source: { kind: 'local', reference: randomUUID() } };
    await publish('/v2/cases/events', root, 'case.teaser.publish');
    const attempt = { schemaVersion: 2, kind: 'attempt-start', eventId: randomUUID(), caseId, expectedVersion: 1,
      actorId: f.f.actor.subjectId, role: 'implementation', strategy: purpose,
      configurationRef: { id: config.id, version: 1 }, inputScopeSummary: 'Explicit selected finite numerical command', permissionScope: ['selected-context'] };
    await publish('/v2/cases/events', attempt, 'case.teaser.publish');
    return { workerId: 'reference', caseId, attemptId: attempt.eventId, attemptVersion: 1, purpose };
  };
  return { f, runtime, flow, a2a, processWorker, fact, controls, config, pack,peerTrustLifetimeMs,peerTrustExpiresAt,
    async close() { flow.close(); let stopped; try { await f.close(); } finally {
      try { stopped = await processWorker.close(); } finally { await cleanupJournal(directory); } } return stopped; } };
  } catch (error) {
    try { if (f) await f.close(); } finally {
      try { await processWorker.close(); } finally { if (directory) await cleanupJournal(directory); }
    }
    throw error;
  }
}

export async function verifyReferenceWorkerProcess() {
  const x = await referenceWorkerProcessFixture(), { f, flow, processWorker } = x, shutdown = {};
  try {
    const selected = { ...await x.fact('用户确认一次求和参考执行'), text: JSON.stringify({ operation: 'sum', values: [1, 2, 3] }) };
    const discarded = await flow.prepareStart(selected); assert.equal(flow.abort(discarded).remoteCanceled, false);
    await assert.rejects(flow.execute(discarded, { confirmed: true }));
    assert.equal((await processWorker.observations()).starts, 0);
    const sent = await flow.execute(await flow.prepareStart(selected), { confirmed: true });
    assert.equal(sent.peer.state, 'completed'); assert.equal((await processWorker.observations()).starts, 1);
    assert.ok(JSON.stringify(sent.peer).includes('"value":6') || JSON.stringify(sent.peer).includes('\\"value\\":6'));
    assert.equal(Number((await f.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count), 0);
    assert.equal(f.calls.filter(path => path === '/v2/builders/pack-uses/events').length, 0, 'execution does not automatically publish use');
    const resultPreview = await flow.prepareResult(sent.id, { summary: '所选合成三数求和实际输出6；不是问题解决认证',
      reportedOutcome: 'succeeded', limitations: 'Synthetic reference, no independent third-party certification' });
    x.controls.loseResultAck = true;
    await assert.rejects(flow.execute(resultPreview, { confirmed: true }), /lost Result ACK/);
    await f.connect();
    const resultReceipt = await flow.reconcileResult(sent.id);
    assert.equal(resultReceipt.state, 'acknowledged'); assert.equal(resultReceipt.currentAccessGranted, false);
    const abandonedUse = await flow.prepareUse(sent.id, { visibility: 'Private' });
    assert.equal(flow.abort(abandonedUse).remoteCanceled, false);
    const preview = await flow.prepareUse(sent.id, { visibility: 'Public' });
    assert.equal(preview.operationId, abandonedUse.operationId);
    assert.equal(preview.preview.payloadHash, abandonedUse.preview.payloadHash);
    assert.equal(preview.preview.visibility, 'Private', 'abandoning a preview cannot silently widen the original audience');
    f.state.losePackUseAck = true;
    await assert.rejects(flow.execute(preview, { confirmed: true }), /Pack use ACK lost/);
    await f.connect(); const useReceipt = await flow.reconcileUse(sent.id);
    assert.equal(useReceipt.state, 'acknowledged'); assert.equal(useReceipt.currentReadPermissionConfirmed, false);
    assert.equal(f.calls.filter(path => path === '/v2/builders/pack-uses/events').length, 1);
    assert.equal((await processWorker.observations()).starts, 1);
    const id = (await flow.read(sent.id)).association.packUse.id, use = await f.workerClient.get({ id });
    assert.deepEqual(use.record.pack, { builderId: x.pack.builderId, manifestId: x.pack.manifestId, manifestHash: x.pack.manifestHash });
    assert.deepEqual(use.record.configuration, { id: x.config.id, version: 1 });
    assert.deepEqual(use.record.attempt, { id: selected.attemptId, version: 1 });
    assert.equal(use.sources.reportedOutcome, 'succeeded'); assert.equal(use.sources.successfulReuseVerified, false);
    assert.equal((await flow.prepareUse(sent.id)).state, 'acknowledged', 'accepted use never creates a replacement operation');

    const failed = await flow.execute(await flow.prepareStart({ ...await x.fact('明确选择除零失败参考'),
      text: JSON.stringify({ operation: 'quotient', values: [1, 0] }) }), { confirmed: true });
    assert.equal(failed.peer.state, 'failed');
    await assert.rejects(flow.prepareResult(failed.id, { summary: '不能把失败改写成功', reportedOutcome: 'succeeded' }), /cannot support a success/);
    await flow.execute(await flow.prepareResult(failed.id, { summary: '实际除零返回失败', reportedOutcome: 'failed' }), { confirmed: true });
    const failureUse = await flow.prepareUse(failed.id);
    await flow.execute(failureUse, { confirmed: true });
    const failureView = await f.workerClient.get({ id: (await flow.read(failed.id)).association.packUse.id });
    assert.equal(failureView.sources.reportedOutcome, 'failed'); assert.equal(failureView.sources.successfulReuseVerified, false);

    const beforeCancel = await processWorker.observations();
    const working = await flow.execute(await flow.prepareStart({ ...await x.fact('明确选择可停止延迟计算'),
      text: JSON.stringify({ operation: 'sum', values: [4, 5], delayMs: 5000 }) }), { confirmed: true });
    assert.equal(working.peer.state, 'working'); assert.equal((await processWorker.observations()).active, 1);
    assert.equal((await flow.read(working.id, { poll: true })).peer.peer.state, 'working');
    const cancel = await flow.prepareCancel(working.id); assert.equal(flow.abort(cancel).remoteCanceled, false);
    assert.equal(processWorker.requests.filter(method => method === 'CancelTask').length, 0);
    const canceled = await flow.execute(await flow.prepareCancel(working.id), { confirmed: true });
    assert.equal(canceled.peer.state, 'canceled'); const afterCancel = await processWorker.observations();
    assert.equal(afterCancel.active, 0); assert.equal(afterCancel.computations, beforeCancel.computations);
    assert.equal(afterCancel.cancellations, 1);
    await assert.rejects(flow.prepareResult(working.id, { summary: '取消不能声明成功', reportedOutcome: 'succeeded' }), /cannot support a success/);
    await flow.execute(await flow.prepareResult(working.id, { summary: '用户取消，计算未完成', reportedOutcome: 'inconclusive' }), { confirmed: true });
    await flow.execute(await flow.prepareUse(working.id), { confirmed: true });
    assert.equal((await f.workerClient.get({ id: (await flow.read(working.id)).association.packUse.id })).sources.reportedOutcome, 'inconclusive');

    const unknownInput = { ...await x.fact('实际派发后只保留未知原请求'), text: JSON.stringify({ operation: 'sum', values: [7, 8] }) };
    processWorker.state.loseSendAck = true; let unknownId;
    await assert.rejects(flow.execute(await flow.prepareStart(unknownInput), { confirmed: true }), error => {
      unknownId = error.associationId; return error.code === 'A2A_OUTCOME_UNKNOWN'; });
    assert.equal((await flow.read(unknownId)).peer.status, 'unknown');
    await assert.rejects(flow.prepareStart(unknownInput), /already dispatched/);
    await assert.rejects(flow.read(unknownId, { poll: true }), /No observed peer task ID/);
    await assert.rejects(flow.prepareResult(unknownId, { summary: '未知不能产生成功事实', reportedOutcome: 'succeeded' }), /terminal peer/);
    assert.ok((await flow.associations()).some(row => row.associationId === unknownId));
    assert.equal(processWorker.requests.filter(method => method === 'SendMessage').length, 4);
    assert.equal(processWorker.requests.filter(method => method === 'GetTask').length, 1);
    const observations = await processWorker.observations();
    assert.equal(observations.starts, 4); assert.equal(observations.computations, 3); assert.equal(observations.active, 0);
    assert.equal(observations.sdk, '1.1.0');
    return { actualProcess: true, a2aProtocol: '1.0', sdk: '1.1.0', workerVersion: '0.1.0', starts: observations.starts,
      successfulOutput: 6, failedState: failed.peer.state, canceledState: canceled.peer.state, cancellations: observations.cancellations,
      resultLostAckRecovered: resultReceipt.state, packUseLostAckRecovered: useReceipt.state, unknownOriginalRetained: true,
      successfulReuseVerified: false, modelExecuted: false, independentOperatorVerified: false,
      syntheticIdentityAndInputs: true, database: 'PGlite', localStore: 'Map', actualJournal: 'filesystem', sourceHash: processWorker.sourceHash, shutdown };
  } finally { Object.assign(shutdown, await x.close()); }
}
