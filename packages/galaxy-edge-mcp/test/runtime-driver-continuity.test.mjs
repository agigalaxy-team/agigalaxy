import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexAppServerDriver } from '../src/native-v2/host-adapters/codex-app-server.mjs';
import { createJsonRpcStdio } from '../src/native-v2/host-adapters/json-rpc-stdio.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const readerFeatures = ['shell_tool', 'unified_exec', 'view_image', 'code_mode', 'js_repl', 'apps', 'plugins', 'multi_agent'];
function codexFixture({ interruptTerminal = true } = {}) {
  const calls = [], listeners = new Set(), disconnects = new Set();
  let thread = 0, turn = 0, original;
  const rpc = {
    calls, readState: 'inProgress', resumedId: null,
    subscribe: listener => listeners.add(listener), onDisconnect: listener => disconnects.add(listener), notify() {},
    terminal(state, locator = original) {
      for (const listener of listeners) listener({ method: 'turn/completed', params: {
        threadId: locator.threadId, turn: { id: locator.turnId, status: state, items: [{ type: 'agentMessage', text: 'withheld analysis' }] },
      } });
    },
    disconnect() { for (const listener of disconnects) listener(); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'initialize') return {};
      if (method === 'model/list') return { data: [{ id: 'selected', model: 'selected-model' }] };
      if (method === 'config/read') return { config: { web_search: 'disabled', mcp_servers: {}, features: Object.fromEntries(readerFeatures.map(name => [name, false])) } };
      if (method === 'thread/start') return { thread: { id: 'owned-thread-' + ++thread } };
      if (method === 'thread/resume') return { thread: { id: rpc.resumedId ?? params.threadId } };
      if (method === 'turn/start') {
        original = { threadId: params.threadId, turnId: 'owned-turn-' + ++turn };
        return { turn: { id: original.turnId, status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') { if (interruptTerminal) rpc.terminal('interrupted', params); return {}; }
      if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: original.turnId, status: rpc.readState }] } };
      throw Error('unexpected protocol method');
    }, async close() { rpc.disconnect(); },
  };
  const driver = createCodexAppServerDriver({ rpc, completionTimeoutMs: 100, cancelTimeoutMs: 10 });
  const input = { watchId: randomUUID(), scopeKey: 'exact-owner/grant/generation', model: 'selected-model', cwd: process.cwd(),
    purpose: 'read authorized room changes', work: { workId: randomUUID(), roomId: randomUUID(), items: [] } };
  return { rpc, driver, input };
}

test('Codex original locator journal failure after dispatch requests exact interruption and withholds output', async () => {
  const f = codexFixture();
  try {
    const result = await f.driver.run({ ...f.input, onState: async state => { if (state.turnId) throw Error('local journal unavailable'); } });
    assert.equal(f.rpc.calls.filter(call => call.method === 'turn/interrupt').length, 1);
    assert.equal(result.state, 'interrupted');
    assert.equal(result.output, undefined);
    assert.equal(result.hostTurnDispatches, 1);
    assert.deepEqual(f.rpc.calls.find(call => call.method === 'turn/interrupt').params, { threadId: result.threadId, turnId: result.turnId });
    assert.equal(f.driver.status(f.input.watchId, { scopeKey: f.input.scopeKey }).modelRunning, false);
  } finally { await f.driver.close(); }
});

test('Codex journal failure with interrupt ACK alone retains original unknown and only late exact terminal resolves it', async () => {
  const f = codexFixture({ interruptTerminal: false });
  try {
    const result = await f.driver.run({ ...f.input, onState: async state => { if (state.turnId) throw Error('local journal unavailable'); } });
    assert.equal(f.rpc.calls.filter(call => call.method === 'turn/interrupt').length, 1);
    assert.equal(result.state, 'unknown');
    assert.equal(result.output, undefined);
    assert.equal(f.driver.status(f.input.watchId, { scopeKey: f.input.scopeKey }).modelRunning, null);
    const before = f.rpc.calls.filter(call => call.method === 'turn/start').length;
    f.rpc.terminal('completed'); f.rpc.readState = 'completed';
    const receipt = await f.driver.reconcile(result);
    assert.equal(receipt.state, 'completed'); assert.equal(receipt.output, undefined);
    assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, before);
  } finally { await f.driver.close(); }
});

test('Codex disconnect preserves original thread and turn in returned unknown metadata', async () => {
  const f = codexFixture(); let locator;
  try {
    const running = f.driver.run({ ...f.input, onState: async state => { if (state.turnId) locator = state; } });
    await tick(); f.rpc.disconnect();
    const result = await running;
    assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'host-disconnected');
    assert.equal(result.threadId, locator.threadId); assert.equal(result.turnId, locator.turnId);
    assert.equal(result.output, undefined); assert.equal(result.hostTurnDispatches, 1);
  } finally { await f.driver.close(); }
});

test('Codex resume cannot dispatch into a host-returned thread outside the recorded original locator', async () => {
  const f = codexFixture();
  try {
    const first = f.driver.run(f.input); await tick(); f.rpc.terminal('completed'); await first;
    f.rpc.resumedId = 'unowned-thread';
    const result = await f.driver.run({ ...f.input, work: { ...f.input.work, workId: randomUUID() } });
    assert.equal(result.hostTurnDispatches, 0); assert.equal(result.output, undefined);
    assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { await f.driver.close(); }
});

function processDouble({ exitAfterKill = false } = {}) {
  const child = new EventEmitter(); let killCalls = 0;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.stdin.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) {
    const request = JSON.parse(line); if (request.id !== undefined) child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
  } });
  child.kill = () => { killCalls++; if (exitAfterKill) { child.signalCode = 'SIGTERM'; child.emit('close', null, 'SIGTERM'); } return true; };
  return { child, get killCalls() { return killCalls; } };
}

test('stdio close rejects when the owned process has not exited after graceful and kill waits', async () => {
  const f = processDouble();
  const rpc = createJsonRpcStdio({ command: process.execPath, spawnProcess: () => f.child, closeTimeoutMs: 10 });
  await rpc.request('handshake');
  const closed = rpc.close();
  assert.equal(closed, rpc.close());
  await assert.rejects(closed, /host_process_shutdown_unconfirmed/);
  assert.equal(f.killCalls, 1);
});

test('stdio refuses new RPC requests as soon as shutdown begins and confirms actual owned exit', async () => {
  const f = processDouble({ exitAfterKill: true });
  const rpc = createJsonRpcStdio({ command: process.execPath, spawnProcess: () => f.child, closeTimeoutMs: 10 });
  await rpc.request('handshake');
  const closed = rpc.close();
  await assert.rejects(rpc.request('turn/start'), /host_disconnected/);
  await closed; assert.equal(f.killCalls, 1);
});

test('stdio does not attempt a fresh response to host permission requests while its streams drain', async () => {
  const f = processDouble({ exitAfterKill: true });
  const rpc = createJsonRpcStdio({ command: process.execPath, spawnProcess: () => f.child, closeTimeoutMs: 10 });
  await rpc.request('handshake'); const closed = rpc.close(); await tick();
  assert.doesNotThrow(() => f.child.stdout.write(JSON.stringify({ id: 'late-request', method: 'item/commandExecution/requestApproval', params: {} }) + '\n'));
  await closed;
});

test('real owned Node app-server stops the original turn after locator journal failure and drains process exit', async () => {
  // This executable speaks only local JSON protocol. It imports no model
  // SDK/provider and cannot create a real Codex session or paid model turn.
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-driver-continuity-')), file = join(directory, 'fixture.mjs');
  let child, driver;
  try {
    await writeFile(file, `import readline from 'node:readline';
      const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line); if(m.id===undefined)return; let result;
        if(m.method==='initialize')result={};
        else if(m.method==='model/list')result={data:[{id:'selected',model:'selected-model'}]};
        else if(m.method==='config/read')result={config:{web_search:'disabled',mcp_servers:{},features:${JSON.stringify(Object.fromEntries(readerFeatures.map(name => [name, false])))}}};
        else if(m.method==='thread/start')result={thread:{id:'owned-node-thread'}};
        else if(m.method==='turn/start')result={turn:{id:'owned-node-turn',status:'inProgress'}};
        else if(m.method==='turn/interrupt'){
          if(m.params.threadId!=='owned-node-thread'||m.params.turnId!=='owned-node-turn')process.exit(4);
          send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:m.params.turnId,status:'interrupted',items:[]}}});result={};
        }else process.exit(5);
        send({id:m.id,result});
      });`);
    const rpc = createJsonRpcStdio({ command: process.execPath, args: [file], cwd: directory, closeTimeoutMs: 1000,
      spawnProcess: (command, args, options) => { assert.equal(options.shell, false); return child = spawn(command, args, options); } });
    driver = createCodexAppServerDriver({ rpc, completionTimeoutMs: 1000, cancelTimeoutMs: 1000 });
    const result = await driver.run({ watchId: randomUUID(), scopeKey: 'original-scope', model: 'selected-model', cwd: directory,
      work: { workId: randomUUID(), roomId: randomUUID(), items: [] }, purpose: 'controlled local protocol only',
      onState: async state => { if (state.turnId) throw Error('injected journal failure'); } });
    assert.equal(result.state, 'interrupted'); assert.equal(result.output, undefined); assert.equal(result.hostTurnDispatches, 1);
    assert.equal(result.threadId, 'owned-node-thread'); assert.equal(result.turnId, 'owned-node-turn');
    await driver.close(); assert.equal(child.exitCode, 0);
  } finally {
    await driver?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
