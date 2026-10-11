import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { nativeWorkerFixture } from './native-worker-pack-flow-workflow.mjs';
import { createConfiguredNativeWorkerHost } from '../../galaxy-edge-mcp/src/native-v2/worker-pack-host.mjs';
import { createNativeToolServer } from '../../galaxy-edge-mcp/src/native-v2/server.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const { NodeStreamableHTTPServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/node')).href);

/** Actual registered server over the existing real NativeFS/HTTP/child fixture.
 * No alternative business implementation or authorization result is supplied. */
export async function registeredNativeWorkerFixture() {
  const source = await nativeWorkerFixture();
  let server, sdk, http;
  const close = async () => {
    try { await sdk?.close(); await server?.close(); }
    finally { if (http?.listening) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); } await source.close(); }
  };
  try {
    const workerHost = createConfiguredNativeWorkerHost({ runtime: source.runtime, directory: join(source.directory, 'registered-browser-worker'),
      configuration: { workers: [{ id: 'reference', peerId: 'reference', pack: { builderId: source.pack.builderId,
        manifestId: source.pack.manifestId, manifestHash: source.pack.manifestHash }, sourceHash: source.processWorker.sourceHash, version: '0.1.0' }] },
      a2aConfiguration: { peers: [{ id: 'reference', endpoint: 'https://reference-worker.example.org/a2a', peerPrincipal: 'registered-browser-peer',
        agentCard: source.processWorker.card, cardHash: createHash('sha256').update(JSON.stringify(source.processWorker.card)).digest('hex'),
        trustExpiresAt: Date.now() + 600000, authentication: { mode: 'none' } }] },
      post: (...args) => source.processWorker.post(...args) });
    server = createNativeToolServer(source.runtime, { workerHost });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    http = createServer((req, res) => { void transport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    await server.connect(transport); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    sdk = new Client({ name: 'registered-native-worker-browser', version: '1' });
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
    const raw = (name, input) => sdk.callTool({ name, arguments: input });
    const call = async (name, input) => { const result = await raw(name, input);
      assert.equal(result.isError ?? false, false, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
    return { ...source, raw, call, flow: workerHost, prepare: async input => (await call('galaxy_worker_host_prepare', input)).preview, close };
  } catch (error) { await close(); throw error; }
}
