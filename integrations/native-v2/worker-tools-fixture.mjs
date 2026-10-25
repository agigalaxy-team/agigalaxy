import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { createNativeChoice, nativeResult } from '../../packages/galaxy-edge-mcp/src/native-v2/interaction/choice.mjs';
import { referenceWorkerProcessFixture } from '../../packages/galaxy-official/test/worker-pack-process-v2-workflow.mjs';
import { registerNativeWorkerTools } from './worker-tools.mjs';
import { workerComponentResult } from './compact-app/worker-result.mjs';

const require = createRequire(new URL('../../packages/galaxy-official/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const { NodeStreamableHTTPServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/node')).href);

// The peer process, SDK, HTTP services, signed Consent and PGlite are real.
// Host local storage and the synchronous native reference fence are explicit
// contract fixtures. No physical MCP Apps host or model is started here.
export async function workerToolsFixture({ flowTransform = flow => flow, reviewHook, now, peerTrustLifetimeMs } = {}) {
  const x = await referenceWorkerProcessFixture(peerTrustLifetimeMs===undefined?{}:{peerTrustLifetimeMs});
  let lifecycle = {}, closed = false;
  const runtime = { ...x.runtime, receiptStatus: { captureLease() {
    const s = runtime.api.snapshot(), captured = lifecycle;
    const assertCurrent = () => { const latest = runtime.api.snapshot();
      if (closed || captured !== lifecycle || (s === null) !== (latest === null)
        || s && ['subjectId', 'bindingId', 'generation'].some(k => s[k] !== latest?.[k])) throw Error('synthetic_native_reference_changed'); };
    assertCurrent(); return { subjectId: s?.subjectId ?? null, endpoint: runtime.api.endpoint,
      bindingId: s?.bindingId ?? null, generation: s?.generation ?? null, assertCurrent };
  } } };
  const choices = new Map(), choice = createNativeChoice({ identity: () => runtime.api.snapshot()?.subjectId ?? '',
    website: 'https://worker-review.example', store: { get: async k => choices.get(k), put: async(k,v) => choices.set(k,v) } });
  const server = new McpServer({ name: 'synthetic-worker-native-factory', version: '1' }, { requestState: { verify: choice.verify } });
  const tools = registerNativeWorkerTools(server, { flow: flowTransform(x.flow), runtime,
    ...(now ? { now } : {}),
    review: async(name,input,ctx,run) => { if (reviewHook) await reviewHook(input);
      return choice.run(server,name,input,ctx,run); } });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
  const http = createServer((req,res) => { void transport.handleRequest(req,res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  let sdk;
  const close = async () => { closed = true; lifecycle = {}; choice.close(); await tools.close();
    if (sdk) await sdk.close(); await server.close(); if (http.listening) { http.closeAllConnections(); await new Promise(r => http.close(r)); }
    await x.close(); };
  try {
    await server.connect(transport); await new Promise(r => http.listen(0,'127.0.0.1',r));
    sdk = new Client({ name: 'synthetic-worker-owner', version: '1' });
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
    const raw = (name,args={}) => sdk.callTool({ name, arguments: args });
    const call = async (name,args={}) => { const result = await raw(name,args), data = workerComponentResult(result);
      assert.equal(result.isError ?? false,false,JSON.stringify(data)); return data; };
    const choose = async (preview, answer = 'allow') => {
      const input = { handle: preview.handle, previewHash: preview.previewHash };
      const first = await call('galaxy_worker_host_execute',input);
      if (first.kind === 'galaxy-worker-panel') return first;
      assert.equal(first.state,'user-choice-needs-browser');
      const html = await (await fetch(first.url)).text();
      assert.ok(!html.includes('<pre>'));
      const exact = await (await fetch(first.url+'?download=1')).json();
      assert.equal(exact.input.preview.associationId,preview.associationId);
      assert.equal(exact.input.preview.payloadHash,preview.payloadHash);
      const response = await fetch(first.url,{ method: 'POST', headers: { Origin: new URL(first.url).origin,
        'Content-Type': 'application/x-www-form-urlencoded' },body: 'action='+answer });
      assert.equal(response.status,200);
      return call('galaxy_worker_host_execute',input);
    };
    return { ...x, runtime, server, tools, sdk, call, raw, choose, rotateReference: () => { lifecycle = {}; },
      prepare: async input => (await call('galaxy_worker_host_prepare',input)).preview,
      rawChoice: (name,input,ctx,run) => choice.run(server,name,input,ctx,run),
      nativeResult, close };
  } catch (error) { await close(); throw error; }
}
