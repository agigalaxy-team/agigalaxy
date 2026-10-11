// Protocol-only fixture. This file never imports the Copilot SDK or calls a
// model. Its optional real Node child exercises owned-process lifecycle proof.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function completionEvents(prompt, messageId, content = 'authorized scoped analysis') {
  const user = { id: randomUUID(), parentId: null, type: 'user.message', data: { content: prompt, messageId } };
  const message = { id: randomUUID(), parentId: user.id, type: 'assistant.message', data: { content,
    originatingMessageId: messageId, reasoningText: 'private reasoning fixture', encryptedContent: 'do-not-return' } };
  const end = { id: randomUUID(), parentId: message.id, type: 'assistant.turn_end', data: { turnId: randomUUID() } };
  const receipt = { id: randomUUID(), parentId: end.id, type: 'session.completion_receipt', data: {
    schemaVersion: 1, attempt: 1, eventRange: { startEventId: user.id, endEventId: end.id }, sourceEventId: end.id,
    stopReason: 'natural', successfulToolCount: 0, failedToolCount: 0 } };
  return [user, message, end, receipt].map(event => ({ ...event, timestamp: new Date().toISOString() }));
}
function backend(options = {}) {
  const sessions = new Map();
  return { sessions, async request(method, input = {}) {
    if (method === 'start') return {};
    if (method === 'status') return { version: 'protocol-fixture-not-copilot', secret: 'do-not-return' };
    if (method === 'models') return [{ id: 'chosen-model', name: 'explicit fixture model' }];
    if (method === 'create') {
      if (sessions.has(input.sessionId)) throw Error('session_already_exists');
      sessions.set(input.sessionId, { options: input, events: [] }); return { sessionId: input.sessionId };
    }
    if (method === 'stop') return [];
    const session = sessions.get(input.sessionId); if (!session) throw Error('original_session_missing');
    if (method === 'resume') return { sessionId: input.sessionId };
    if (method === 'initialize') return {};
    if (method === 'tools') return { tools: options.tools === undefined ? [] : options.tools };
    if (method === 'events') return structuredClone(session.events);
    if (method === 'send') {
      const messageId = randomUUID(), events = completionEvents(input.prompt, messageId, options.output);
      session.events = options.complete === false ? events.slice(0, 1) : events;
      if (options.sendAckLost) throw Error('synthetic_lost_ack');
      return messageId;
    }
    if (method === 'abort') {
      if (options.abortTerminal !== false && session.events.length) {
        const abort = { id: randomUUID(), parentId: session.events.at(-1).id, timestamp: new Date().toISOString(), type: 'abort', data: { reason: 'remote_command' } };
        session.events.push(abort, { id: randomUUID(), parentId: abort.id, timestamp: new Date().toISOString(), type: 'session.idle', ephemeral: true, data: { aborted: true } });
      }
      return {};
    }
    throw Error('unexpected_fixture_method');
  } };
}

export function createCopilotProtocolFixture({ child = false, hook = null, publicExit = true, ...options } = {}) {
  const local = backend(options), calls = [], clients = [], processes = [];
  let requestId = 0;
  function createClient(config) {
    const metadata = { config, sessionOptions: [], stopCalls: 0 }; clients.push(metadata);
    let process, exit, exited = false;
    const pending = new Map();
    function launch() {
      if (process) return;
      process = spawn(globalThis.process.execPath, [fileURLToPath(import.meta.url), '--copilot-test-child'], {
        shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...globalThis.process.env } });
      processes.push(process);
      // Do not expose child diagnostics or authorized prompt/output as logs.
      process.stderr.resume();
      exit = new Promise(resolve => process.once('exit', code => {
        exited = true; for (const p of pending.values()) p.reject(Error('fixture_disconnected')); pending.clear(); resolve({ exited: true, code });
      }));
      process.on('message', message => {
        const p = pending.get(message.id); if (!p) return;
        pending.delete(message.id); if (message.error) p.reject(Error(message.error)); else p.resolve(message.result);
      });
      process.on('error', () => { for (const p of pending.values()) p.reject(Error('fixture_launch_failed')); pending.clear(); });
    }
    async function request(method, input) {
      calls.push(method); if (hook) await hook(method, input, metadata);
      if (!child) return local.request(method, input);
      launch(); if (exited) throw Error('fixture_disconnected');
      const id = ++requestId;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.send({ id, method, input }); });
    }
    function session(sessionId) {
      return { sessionId,
        rpc: { tools: { initializeAndValidate: () => request('initialize', { sessionId }), getCurrentMetadata: () => request('tools', { sessionId }) } },
        getEvents: () => request('events', { sessionId }),
        send: input => request('send', { ...input, sessionId }),
        abort: () => request('abort', { sessionId }), disconnect: async () => {} };
    }
    const client = {
      start: () => request('start'), getStatus: () => request('status'), listModels: () => request('models'),
      createSession: async input => { metadata.sessionOptions.push(input); const value = await request('create', input); return session(value.sessionId); },
      resumeSession: async (sessionId, input) => { metadata.sessionOptions.push(input); const value = await request('resume', { ...input, sessionId }); return session(value.sessionId); },
      stop: async () => { metadata.stopCalls++; return request('stop'); } };
    return { client, ...(publicExit ? { lifecycle: { waitForExit: async () => child ? await exit : { exited: true } } } : {}) };
  }
  return { createClient, calls, clients, sessions: local.sessions, processes,
    count: method => calls.filter(x => x === method).length,
    async cleanup() { for (const process of processes) if (process.exitCode === null) { const ended = new Promise(done => process.once('exit', done)); process.kill(); await ended; } } };
}

if (process.argv[2] === '--copilot-test-child') {
  const server = backend();
  process.on('message', async message => {
    try { process.send({ id: message.id, result: await server.request(message.method, message.input) }, () => {
      if (message.method === 'stop') process.exit(0);
    }); } catch (error) { process.send({ id: message.id, error: error.message }); }
  });
}
