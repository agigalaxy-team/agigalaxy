import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeWorkerFixture } from './native-worker-pack-flow-workflow.mjs';
import { createConfiguredNativeWorkerHost } from '../../galaxy-edge-mcp/src/native-v2/worker-pack-host.mjs';
import { createNativeToolServer } from '../../galaxy-edge-mcp/src/native-v2/server.mjs';
import { nativeConfigSchema } from '../../galaxy-edge-mcp/src/native-v2/stdio.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const { NodeStreamableHTTPServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/node')).href);
const digest = value => createHash('sha256').update(value).digest('hex');

test('actual native server registers configured Worker tools lazily, keeps ordinary review complete, and shares the Apps resource without auto-connection', { timeout: 90000 }, async t => {
  const x = await nativeWorkerFixture();
  let server, http, sdk;
  try {
    const workers = { workers: [{ id: 'reference', peerId: 'reference', pack: {
      builderId: x.pack.builderId, manifestId: x.pack.manifestId, manifestHash: x.pack.manifestHash,
    }, sourceHash: x.processWorker.sourceHash, version: '0.1.0' }] };
    const a2a = { peers: [{ id: 'reference', endpoint: 'https://reference-worker.example.org/a2a',
      peerPrincipal: 'configured-synthetic-peer', agentCard: x.processWorker.card,
      cardHash: digest(JSON.stringify(x.processWorker.card)), trustExpiresAt: Date.now() + 600000,
      authentication: { mode: 'none' } }] };
    const config = { version: 2, endpoint: x.config.endpoint, website: x.config.website,
      dataDirectory: x.config.dataDirectory, trustedKeys: Object.fromEntries(x.config.trustedKeys), workerPacks: workers, a2a };
    assert.equal(nativeConfigSchema.parse(config).workerPacks.workers.length, 1);
    assert.throws(() => nativeConfigSchema.parse({ ...config, a2a: undefined }));
    assert.throws(() => nativeConfigSchema.parse({ ...config, workerPacks: { workers: [{ ...workers.workers[0], command: 'not-allowed' }] } }));
    assert.throws(() => createConfiguredNativeWorkerHost({ runtime: x.runtime, directory: x.directory,
      configuration: { workers: [{ ...workers.workers[0], peerId: 'unselected' }] }, a2aConfiguration: a2a }));
    await x.runtime.disconnect();
    const before = x.requests.length;
    let outerCalls = 0;
    const runtime = { ...x.runtime, api: { ...x.runtime.api, call: (...args) => {
      outerCalls++; return x.runtime.api.call(...args);
    } } };
    const workerHost = createConfiguredNativeWorkerHost({ runtime, directory: join(x.directory, 'configured-worker'),
      configuration: workers, a2aConfiguration: a2a, post: (...args) => x.processWorker.post(...args) });
    const html = '<!doctype html><title>Protocol registration fixture only</title>';
    const artifact = { html, manifest: { uri: 'ui://galaxy/worker-registration-test.html', sha256: digest(html) } };
    server = createNativeToolServer(runtime, { workerHost, compactArtifact: artifact });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    http = createServer((req, res) => { void transport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    await server.connect(transport); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    sdk = new Client({ name: 'ordinary-native-worker-registration', version: '1' });
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
    const tools = (await sdk.listTools()).tools.filter(tool => tool.name.startsWith('galaxy_worker_host_'));
    assert.equal(tools.length, 4);
    assert.ok(tools.every(tool => tool._meta?.ui?.resourceUri === artifact.manifest.uri));
    assert.equal((await sdk.readResource({ uri: artifact.manifest.uri })).contents[0].text, html);
    const raw = (name, args) => sdk.callTool({ name, arguments: args });
    const call = async (name, args) => { const result = await raw(name, args);
      assert.equal(result.isError ?? false, false, JSON.stringify(result)); assert.ok(result.structuredContent); return result.structuredContent; };
    assert.equal((await raw('galaxy_worker_host_read', { action: 'list' })).isError, true);
    assert.equal(x.requests.length, before, 'discovery and unconnected reads cannot connect');
    assert.equal((await x.processWorker.observations()).starts, 0);
    await x.runtime.connect({ confirmed: true });
    assert.equal((await call('galaxy_worker_host_read', { action: 'list' })).associations.length, 0);
    const input = { ...await x.fact('配置后的正式原生server完整接线'), text: JSON.stringify({ operation: 'sum', values: [20, 22] }) };
    const prepare = async value => (await call('galaxy_worker_host_prepare', value)).preview;
    const choose = async preview => {
      const input = { handle: preview.handle, previewHash: preview.previewHash };
      const pending = await call('galaxy_worker_host_execute', input);
      assert.equal(pending.state, 'user-choice-needs-browser');
      const response = await fetch(pending.url, { method: 'POST', headers: { Origin: new URL(pending.url).origin,
        'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=allow' });
      assert.equal(response.status, 200); return call('galaxy_worker_host_execute', input);
    };
    const preview = await prepare(input);
    assert.equal(preview.exact.payload.text, input.text, 'ordinary MCP has the entire selected material');
    const sent = await choose(preview); assert.equal(sent.actionResult.result.peer.state, 'completed');
    assert.equal((await x.processWorker.observations()).starts, 1);
    await choose(await prepare({ action: 'result', associationId: preview.associationId,
      summary: '合成实际输出42；独立于Pack使用许可', reportedOutcome: 'succeeded' }));
    await choose(await prepare({ action: 'use', associationId: preview.associationId }));
    assert.equal(Number((await x.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count), 1);
    assert.equal(x.requests.filter(path => path === '/v2/builders/pack-uses/events').length, 1);
    assert.equal(outerCalls, 0, 'Worker registration never uses the implicit-ensure API facade');
    const next = await prepare({ ...await x.fact('关闭保留原工作'), text: JSON.stringify({ operation: 'sum', values: [1, 1] }) });
    await server.close();
    assert.throws(() => workerHost.execute(next, { confirmed: true }), /connection_required/);
    assert.equal((await x.processWorker.observations()).starts, 1);
    t.diagnostic(JSON.stringify({ actualNativeServer: true, actualNativeFS: true, actualSdk: true, actualReferenceChild: true,
      ordinaryReviewComplete: true, resourceRegistered: true, physicalAppsRendering: false, starts: 1, resultWrites: 1, useWrites: 1,
      implicitConnectionCalls: outerCalls, synthetic: true, modelCalls: 0 }));
  } finally {
    await sdk?.close(); await server?.close();
    if (http?.listening) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
    await x.close();
  }
});
