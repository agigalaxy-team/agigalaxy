import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { configurationExample } from './configuration-v2-workflow.mjs';
import { startReferenceProcess } from './worker-pack-process-v2-workflow.mjs';
import { createNativeRuntime } from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';
import { createNativeWorkerPackAdapter } from '../../galaxy-edge-mcp/src/native-v2/worker-pack-adapter.mjs';
import { createNativeChoice } from '../../galaxy-edge-mcp/src/native-v2/choice.mjs';
import { createNativeA2aHostV2 } from '../../galaxy-a2a/src/host-flow-v2.mjs';
import { createWorkerPackHostFlowV2 } from '../../galaxy-a2a/src/worker-pack-flow-v2.mjs';
import { createReferenceWorkerManifest } from '../../../integrations/reference-worker-pack/manifest.mjs';
import { registerNativeWorkerTools } from '../../../integrations/native-v2/worker-tools.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const { NodeStreamableHTTPServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/node')).href);
const hash = text => createHash('sha256').update(text).digest('hex');
const peerEndpoint = 'https://reference-worker.example.org/a2a';
async function cleanup(directory) {
  const root = await realpath(tmpdir()), target = await realpath(resolve(directory)), child = relative(root, target);
  assert.ok(isAbsolute(target) && child && child !== '..' && !child.startsWith('..\\')
    && !child.startsWith('../') && !isAbsolute(child), 'Native Worker cleanup must stay below the temporary root');
  assert.ok(basename(target).startsWith('galaxy-native-worker-') && basename(target).length > 'galaxy-native-worker-'.length);
  await rm(target, { recursive: true, force: true });
}

// Actual native runtime/device keys, NativeFS, canonical HTTP/JWS, SDK MCP,
// loopback user-choice and the fixed child/A2A SDK. Fault hooks delay or discard
// actual completed I/O; none supplies an identity, lease, Consent or receipt.
export async function nativeWorkerFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-native-worker-'));
  let f, apiServer, processWorker, runtime, composition, httpHook, storeHook;
  const requests = [], controls = { loseResultAck: false, loseUseAck: false }, result = { outerApiCalls: 0 };
  async function closeComposition() {
    if (!composition) return;
    const current = composition; composition = null;
    current.choice.close(); await current.tools.close(); current.adapter.close();
    await current.sdk.close(); await current.server.close();
    if (current.http.listening) { current.http.closeAllConnections(); await new Promise(r => current.http.close(r)); }
  }
  async function close() {
    let stopped;
    try { await closeComposition(); runtime?.close(); }
    finally {
      try { if (apiServer?.listening) { apiServer.closeAllConnections(); await new Promise(r => apiServer.close(r)); } await f?.db.close(); }
      finally { try { stopped = await processWorker?.close(); } finally { await cleanup(directory); } }
    }
    return stopped;
  }
  try {
    f = await serviceFixture(browserScopes);
    apiServer = createApi({ ...f, rateLimit: 2000 }); await new Promise(r => apiServer.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${apiServer.address().port}`, endpoint = f.access.endpoint;
    const transport = async (url, options = {}) => {
      assert.equal(new URL(url).origin, endpoint);
      const path = new URL(url).pathname, input = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      requests.push(path);
      const response = await fetch(origin + path, options);
      if (httpHook) await httpHook(path, input, response);
      if (path === '/v2/cases/events' && input && JSON.parse(input.payloadJson).kind === 'result-recorded' && controls.loseResultAck) {
        assert.equal(response.status, 200); controls.loseResultAck = false; throw Error('Synthetic Result ACK lost after real native-owner commit');
      }
      if (path === '/v2/builders/pack-uses/events' && controls.loseUseAck) {
        assert.equal(response.status, 200); controls.loseUseAck = false; throw Error('Synthetic PackUse ACK lost after real native-owner commit');
      }
      return response;
    };
    const config = { dataDirectory: join(directory, 'native'), endpoint, website: 'https://galaxy.example.org',
      trustedKeys: f.bindings.trustedKeys, fetch: transport, now: () => f.now };
    runtime = await createNativeRuntime(config); await runtime.initialize({ profile: 'minimal' }, { confirmed: true }); await runtime.connect({ confirmed: true });
    const subjectId = (await runtime.status()).identity;
    processWorker = await startReferenceProcess();
    const source = 'https://reference-worker.example.org/releases/0.1.0/worker.mjs', builderId = randomUUID(), manifestId = randomUUID();
    const declaration = builderDeclaration('worker', subjectId);
    declaration.name = 'Selected reference arithmetic Worker'; declaration.scope = 'Synthetic arithmetic; fixed user-host process';
    declaration.release.buildHash = processWorker.sourceHash; declaration.release.artifact = source;
    declaration.release.dependencies = [{ name: '@a2a-js/sdk/package.json', version: '1.1.0', sha256: processWorker.sdkHash }];
    declaration.configuration = { id: 'reference-node-a2a-1', summary: 'Fixed Node process and selected numerical input', modelFamily: 'none',
      tools: ['A2A 1.0 JSONRPC'], taskTypes: ['arithmetic-reference'], maxConcurrentTasks: 1 };
    declaration.capabilities = [{ id: 'arithmetic-reference', claim: 'Finite arithmetic reference', limitations: 'Not independent value or capability certification' }];
    const publish = async (path, event, action, visibility = 'Private') => {
      const prepared = await runtime.workerAuthorization.prepareAuthorization(JSON.stringify(event), {
        action, objectId: event.operationId ?? event.eventId ?? event.id, visibility, confirmed: true });
      const authorization = await runtime.workerAuthorization.submitAuthorization(prepared, { confirmed: true });
      return runtime.workerAuthorization.call(path, authorization);
    };
    await publish('/v1/builders/events', { id: randomUUID(), builderId, kind: 'declare', expectedRevision: 0, declaration }, 'builder.publish', 'Public');
    const builder = await runtime.workerAuthorization.call('/v1/builders/read', { builderId });
    await publish('/v2/builders/support/events', { id: manifestId, builderId, kind: 'pack-manifest', expectedRevision: builder.revision,
      declarationId: builder.declarationId, declarationHash: builder.declarationHash,
      manifest: createReferenceWorkerManifest({ source, sourceHash: processWorker.sourceHash,
        licenseSource: 'https://www.apache.org/licenses/LICENSE-2.0' }) }, 'builder.publish', 'Public');
    const pack = await runtime.workerAuthorization.call('/v2/builders/pack/manifest', { builderId, manifestId });
    assert.equal(pack.manifest.sha256, processWorker.sourceHash); assert.equal(pack.manifest.automaticActivation, false);
    assert.equal((await processWorker.observations()).starts, 0, 'Signed registration/selection never runs a Worker');
    const configuration = configurationExample({ subjectId });
    configuration.observedAt = new Date(f.now * 1000).toISOString();
    configuration.conditions.runtime = { name: 'Node', version: process.versions.node };
    configuration.conditions.tools = [{ name: '@a2a-js/sdk', version: '1.1.0' }];
    configuration.conditions.environment = { name: 'isolated-nativefs-reference', version: '0.1.0' };
    configuration.conditions.limitations = 'Actual native process and protocol; synthetic owner/inputs, no model or third-party operator';
    await publish('/v2/configurations/events', configuration, 'configuration.publish');
    const workers = [{ id: 'reference', peerId: 'reference', pack: { builderId, manifestId, manifestHash: pack.manifestHash },
      sourceHash: processWorker.sourceHash, version: '0.1.0' }];
    async function createComposition() {
      // This narrow fault wrapper still reads/writes the actual physical store.
      // Any accidental use of the auto-connect outer call fails the experiment.
      const adapterRuntime = { ...runtime, api: { ...runtime.api, call: () => { result.outerApiCalls++; throw Error('outer native auto-connect call must not be used'); } },
        store: { ...runtime.store,
          get: async key => { const value = await runtime.store.get(key); if (storeHook) await storeHook('get', key, value); return value; },
          put: async (key, value) => { await runtime.store.put(key, value); if (storeHook) await storeHook('put', key, value); },
        } };
      const adapter = createNativeWorkerPackAdapter({ runtime: adapterRuntime, subjectId, now: () => f.now });
      const a2a = createNativeA2aHostV2({ runtime: adapter.runtime, directory: join(directory, 'a2a'),
        peers: [{ id: 'reference', endpoint: peerEndpoint, tenant: '', peerPrincipal: 'explicit-local-peer',
          agentCard: processWorker.card, cardHash: hash(JSON.stringify(processWorker.card)), trustExpiresAt: Date.now() + 600000 }],
        readPeerAuthorization: async input => ({ subjectId: input.subjectId, peerPrincipal: 'explicit-local-peer' }),
        post: (...args) => processWorker.post(...args) });
      const flow = createWorkerPackHostFlowV2({ runtime: adapter.runtime, a2a, packUses: adapter.packUses, workers });
      const choice = createNativeChoice({ identity: () => runtime.api.snapshot()?.subjectId ?? '', website: config.website, store: runtime.store });
      const server = new McpServer({ name: 'nativefs-reference-worker-integration', version: '1' }, { requestState: { verify: choice.verify } });
      const tools = registerNativeWorkerTools(server, { flow, runtime: adapter.runtime, review: (name, input, ctx, run) => choice.run(server, name, input, ctx, run) });
      const mcpTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
      const http = createServer((req, res) => { void mcpTransport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
      await server.connect(mcpTransport); await new Promise(r => http.listen(0, '127.0.0.1', r));
      const sdk = new Client({ name: 'nativefs-owner-protocol-test', version: '1' });
      await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
      composition = { adapter, a2a, flow, choice, server, tools, http, sdk };
    }
    await createComposition();
    const raw = (name, args = {}) => composition.sdk.callTool({ name, arguments: args });
    const call = async (name, args) => { const response = await raw(name, args), data = JSON.parse(response.content[0].text);
      assert.equal(response.isError ?? false, false, JSON.stringify(data)); return data; };
    const prepare = async input => (await call('galaxy_worker_host_prepare', input)).preview;
    const choose = async (preview, answer = 'allow') => {
      const input = { handle: preview.handle, previewHash: preview.previewHash };
      const first = await call('galaxy_worker_host_execute', input);
      if (first.kind === 'galaxy-worker-panel') return first;
      assert.equal(first.state, 'user-choice-needs-browser');
      const html = await (await fetch(first.url)).text(); assert.ok(html.includes(preview.associationId));
      const response = await fetch(first.url, { method: 'POST', headers: { Origin: new URL(first.url).origin,
        'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=' + answer });
      assert.equal(response.status, 200);
      return call('galaxy_worker_host_execute', input);
    };
    const chooseRaw = async preview => {
      const input = { handle: preview.handle, previewHash: preview.previewHash }, first = await call('galaxy_worker_host_execute', input);
      assert.equal(first.state, 'user-choice-needs-browser');
      assert.equal((await fetch(first.url, { method: 'POST', headers: { Origin: new URL(first.url).origin,
        'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=allow' })).status, 200);
      return raw('galaxy_worker_host_execute', input);
    };
    const fact = async purpose => {
      const caseId = randomUUID();
      await publish('/v2/cases/events', { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0,
        actorId: subjectId, localRef: randomUUID(), title: 'NativeFS真实参考过程', summary: purpose, synthetic: true,
        source: { kind: 'local', reference: randomUUID() } }, 'case.teaser.publish');
      const attempt = { schemaVersion: 2, kind: 'attempt-start', eventId: randomUUID(), caseId, expectedVersion: 1,
        actorId: subjectId, role: 'implementation', strategy: purpose, configurationRef: { id: configuration.id, version: 1 },
        inputScopeSummary: 'Exactly selected numerical input', permissionScope: ['selected-context'] };
      await publish('/v2/cases/events', attempt, 'case.teaser.publish');
      return { action: 'start', workerId: 'reference', caseId, attemptId: attempt.eventId, attemptVersion: 1, purpose };
    };
    return { f, config, directory, subjectId, processWorker, requests, controls, result, configuration, pack, fact, raw, call, prepare, choose, chooseRaw,
      get runtime() { return runtime; }, get adapter() { return composition.adapter; }, get flow() { return composition.flow; },
      setHttpHook(value) { httpHook = value; }, setStoreHook(value) { storeHook = value; },
      async restart() { await closeComposition(); runtime.close(); runtime = await createNativeRuntime(config); await runtime.connect({ confirmed: true }); await createComposition(); },
      close };
  } catch (error) { await close(); throw error; }
}

export async function verifyNativeWorkerPack() {
  const x = await nativeWorkerFixture(), shutdown = {};
  try {
    const input = { ...await x.fact('原聊天明确选择一次求和'), text: JSON.stringify({ operation: 'sum', values: [1, 2, 3] }) };
    const discarded = await x.prepare(input); await x.call('galaxy_worker_host_abort_local', { handle: discarded.handle });
    assert.equal((await x.processWorker.observations()).starts, 0);
    const start = await x.prepare(input), started = await x.choose(start);
    const associationId = start.associationId;
    assert.equal(started.actionResult.result.peer.state, 'completed');
    assert.equal(Number((await x.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count), 0);
    assert.equal(x.requests.filter(v => v === '/v2/builders/pack-uses/events').length, 0);
    const result = await x.prepare({ action: 'result', associationId, summary: '实际参考三数求和输出6，不表示独立能力认证', reportedOutcome: 'succeeded' });
    x.controls.loseResultAck = true;
    const lostResult = await x.chooseRaw(result); assert.equal(lostResult.isError, true);
    await x.restart();
    const recovered = await x.call('galaxy_worker_host_read', { action: 'reconcile-result', associationId });
    assert.equal(recovered.actionResult.result.state, 'acknowledged'); assert.equal(recovered.actionResult.result.currentAccessGranted, false);
    assert.equal(x.requests.filter(v => v === '/v2/cases/events').length, 3, 'root, Attempt and one original Result');
    const use = await x.prepare({ action: 'use', associationId, visibility: 'Private', viewers: [] });
    x.controls.loseUseAck = true;
    const lostUse = await x.chooseRaw(use); assert.equal(lostUse.isError, true);
    await x.restart();
    const useReceipt = await x.call('galaxy_worker_host_read', { action: 'reconcile-use', associationId });
    assert.equal(useReceipt.actionResult.result.state, 'acknowledged');
    assert.equal(useReceipt.actionResult.result.currentReadPermissionConfirmed, false);
    assert.equal(x.requests.filter(v => v === '/v2/builders/pack-uses/events').length, 1);
    const source = await x.flow.read(associationId), useView = await x.adapter.packUses.get({ id: source.association.packUse.id });
    assert.deepEqual(useView.record.pack, { builderId: x.pack.builderId, manifestId: x.pack.manifestId, manifestHash: x.pack.manifestHash });
    assert.deepEqual(useView.record.configuration, { id: x.configuration.id, version: 1 });
    assert.equal(useView.sources.successfulReuseVerified, false);
    const working = await x.prepare({ ...await x.fact('明确选择延迟计算后停止'), text: JSON.stringify({ operation: 'sum', values: [4, 5], delayMs: 5000 }) });
    const workingResult = await x.choose(working); assert.equal(workingResult.actionResult.result.peer.state, 'working');
    const cancelPreview = await x.prepare({ action: 'cancel', associationId: working.associationId });
    await x.call('galaxy_worker_host_abort_local', { handle: cancelPreview.handle });
    assert.equal(x.processWorker.requests.filter(v => v === 'CancelTask').length, 0, 'aborting local preview is not remote cancel');
    const canceled = await x.choose(await x.prepare({ action: 'cancel', associationId: working.associationId }));
    assert.equal(canceled.actionResult.result.peer.state, 'canceled');
    const bad = await x.raw('galaxy_worker_host_prepare', { action: 'result', associationId: working.associationId, summary: '取消不声明成功', reportedOutcome: 'succeeded' });
    assert.equal(bad.isError, true);
    await x.choose(await x.prepare({ action: 'result', associationId: working.associationId, summary: '实际取消，计算未完成', reportedOutcome: 'inconclusive' }));
    await x.choose(await x.prepare({ action: 'use', associationId: working.associationId }));
    const canceledUse = await x.adapter.packUses.get({ id: (await x.flow.read(working.associationId)).association.packUse.id });
    assert.equal(canceledUse.sources.reportedOutcome, 'inconclusive');
    const failed = await x.prepare({ ...await x.fact('真实除零失败不升格'), text: JSON.stringify({ operation: 'quotient', values: [1, 0] }) });
    assert.equal((await x.choose(failed)).actionResult.result.peer.state, 'failed');
    const falseSuccess = await x.raw('galaxy_worker_host_prepare', { action: 'result', associationId: failed.associationId,
      summary: '失败不能成为成功事实', reportedOutcome: 'succeeded' }); assert.equal(falseSuccess.isError, true);
    await x.choose(await x.prepare({ action: 'result', associationId: failed.associationId, summary: '实际除零返回失败', reportedOutcome: 'failed' }));
    await x.choose(await x.prepare({ action: 'use', associationId: failed.associationId }));
    assert.equal((await x.adapter.packUses.get({ id: (await x.flow.read(failed.associationId)).association.packUse.id })).sources.reportedOutcome, 'failed');
    const unknownInput = { ...await x.fact('原Worker请求已执行但ACK未知'), text: JSON.stringify({ operation: 'sum', values: [7, 8] }) };
    const unknown = await x.prepare(unknownInput); x.processWorker.state.loseSendAck = true;
    const unknownResult = await x.chooseRaw(unknown); assert.equal(unknownResult.isError, true);
    assert.equal(JSON.parse(unknownResult.content[0].text).associationId, unknown.associationId);
    await x.restart();
    assert.equal((await x.flow.read(unknown.associationId)).peer.status, 'unknown');
    const repeated = await x.raw('galaxy_worker_host_prepare', unknownInput); assert.equal(repeated.isError, true);
    const noTaskId = await x.raw('galaxy_worker_host_read', { action: 'poll', associationId: unknown.associationId }); assert.equal(noTaskId.isError, true);
    assert.equal(x.processWorker.requests.filter(v => v === 'SendMessage').length, 4, 'unknown does not dispatch again');
    assert.equal((await x.processWorker.observations()).active, 0); assert.equal(x.result.outerApiCalls, 0);
    return { actualNativeRuntime: true, actualNativeFS: true, canonicalSignedHTTP: true, actualMcpSdk: true,
      actualLoopbackUserChoice: true, actualFixedChild: true, a2aProtocol: '1.0', sdk: '1.1.0',
      starts: (await x.processWorker.observations()).starts, resultLostAck: 'acknowledged', useLostAck: 'acknowledged',
      stoppedState: 'canceled', failedState: 'failed', unknownOriginalRetainedAfterRestart: true,
      outerAutoConnectCalls: x.result.outerApiCalls, automaticResultOrUsePublication: false,
      database: 'PGlite', syntheticOwnerAndInputs: true, externalAccountVerified: false, modelExecuted: false,
      actualAppsHostUI: false, thirdPartyOperatorVerified: false, successfulReuseVerified: false, shutdown };
  } finally { Object.assign(shutdown, await x.close()); }
}
