import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Resolve the repository's existing locked dependency. This does not install,
// execute downloaded code, load a model, or interpret arbitrary shell input.
const require = createRequire(new URL('../../packages/galaxy-a2a/package.json', import.meta.url));
const sdkPackage = JSON.parse(await readFile(new URL('../../packages/galaxy-a2a/node_modules/@a2a-js/sdk/package.json', import.meta.url)));
if (sdkPackage.version !== '1.1.0') throw new Error('Reference Worker requires the reviewed A2A SDK 1.1.0.');
const { AgentCard, Task, TaskState, Role } = await import(pathToFileURL(require.resolve('@a2a-js/sdk')).href);
const { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext } =
  await import(pathToFileURL(require.resolve('@a2a-js/sdk/server')).href);

export const REFERENCE_WORKER_VERSION = '0.1.0';

export async function startReferenceWorker({ endpoint } = {}) {
  const selected = new URL(endpoint);
  if (selected.protocol !== 'https:' || selected.username || selected.password || selected.search || selected.hash || selected.pathname !== '/a2a')
    throw new Error('Select an exact HTTPS A2A endpoint; the listener remains loopback only.');
  const card = AgentCard.fromJSON({ name: 'Galaxy reference arithmetic Worker', version: REFERENCE_WORKER_VERSION,
    description: 'User-controlled deterministic arithmetic reference; no model, professional certification or external inputs.',
    supportedInterfaces: [{ url: selected.href, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'] });
  const contexts = new Map(), active = new Map();
  let starts = 0, computations = 0, cancellations = 0, closed = false;
  const publish = (ctx, bus, state, observed) => bus.publish(AgentEvent.task(Task.fromJSON({ id: ctx.taskId, contextId: ctx.contextId,
    status: { state, timestamp: new Date().toISOString(), message: { messageId: randomUUID(), role: Role.ROLE_AGENT,
      parts: [{ text: JSON.stringify(observed), mediaType: 'text/plain' }] } },
    artifacts: state === TaskState.TASK_STATE_COMPLETED ? [{ artifactId: randomUUID(), name: 'Selected arithmetic output',
      parts: [{ text: JSON.stringify(observed), mediaType: 'text/plain' }] }] : [] })));
  const executor = {
    async execute(ctx, bus) {
      if (starts >= 128 || closed) throw new Error('Reference process capacity reached.');
      starts++; contexts.set(ctx.taskId, ctx);
      let command;
      try {
        command = JSON.parse(ctx.userMessage.parts[0]?.content?.value);
        const keys = Object.keys(command);
        if (keys.some(key => !['operation', 'values', 'delayMs'].includes(key)) || !['sum', 'quotient'].includes(command.operation)
          || !Array.isArray(command.values) || !command.values.length || command.values.length > 64
          || !command.values.every(value => typeof value === 'number' && Number.isFinite(value))
          || command.operation === 'quotient' && command.values.length !== 2
          || command.delayMs !== undefined && (!Number.isSafeInteger(command.delayMs) || command.delayMs < 0 || command.delayMs > 5000))
          throw new Error('Unsupported selected arithmetic input.');
      } catch {
        publish(ctx, bus, TaskState.TASK_STATE_FAILED, { state: 'failed', reason: 'unsupported-selected-input' }); return;
      }
      const compute = () => {
        active.delete(ctx.taskId); computations++;
        const value = command.operation === 'sum' ? command.values.reduce((a, b) => a + b, 0) : command.values[0] / command.values[1];
        publish(ctx, bus, Number.isFinite(value) ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_FAILED,
          Number.isFinite(value) ? { state: 'completed', operation: command.operation, value, inputCount: command.values.length,
            workerVersion: REFERENCE_WORKER_VERSION } : { state: 'failed', reason: 'non-finite-arithmetic-result' });
      };
      if (command.delayMs) {
        publish(ctx, bus, TaskState.TASK_STATE_WORKING, { state: 'working', selectedDelayMs: command.delayMs });
        active.set(ctx.taskId, setTimeout(compute, command.delayMs));
      } else compute();
    },
    async cancelTask(taskId, bus) {
      const ctx = contexts.get(taskId), timer = active.get(taskId);
      if (!ctx || !timer) throw new Error('No active reference computation to cancel.');
      clearTimeout(timer); active.delete(taskId); cancellations++;
      publish(ctx, bus, TaskState.TASK_STATE_CANCELED, { state: 'canceled', computationPerformed: false }); bus.finished();
    },
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor, undefined, undefined, undefined, undefined, undefined,
    { keepBusAliveStates: [TaskState.TASK_STATE_WORKING] });
  const rpc = new JsonRpcTransportHandler(handler);
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/.well-known/agent-card.json') {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(AgentCard.toJSON(card))); return;
      }
      if (request.method !== 'POST' || request.url !== '/a2a' || request.headers['a2a-version'] !== '1.0') {
        response.writeHead(400); response.end(); return;
      }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 32768) throw new Error('Input too large.'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await rpc.handle(body, new ServerCallContext({ requestedVersion: '1.0', tenant: '',
        user: { isAuthenticated: true, userName: 'local-owner' } }));
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, endpoint: selected.href, card: AgentCard.toJSON(card),
    observations: () => ({ starts, computations, cancellations, active: active.size, sdk: sdkPackage.version, workerVersion: REFERENCE_WORKER_VERSION }),
    async close() { if (closed) return; closed = true; for (const timer of active.values()) clearTimeout(timer); active.clear();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const worker = await startReferenceWorker({ endpoint: process.argv[2] });
  process.stdout.write(JSON.stringify({ port: worker.port, endpoint: worker.endpoint, card: worker.card }) + '\n');
  const shutdown = async () => { await worker.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  process.on('message', message => {
    if (message?.kind === 'observations') process.send?.({ kind: 'observations', id: message.id, ...worker.observations() });
    if (message?.kind === 'shutdown') void shutdown();
  });
}
