import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createFailureAuditSpool } from '../src/infrastructure/failure-audit-spool.mjs';
import { verifyFailureSpool } from './failure-spool-workflow.mjs';

test('durable audit recovers outage and lost commit acknowledgement without duplicate rows', () => verifyFailureSpool());

test('queued failure survives forced process termination before delivery', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-failure-kill-'));
  const path = join(directory, 'queue.sqlite'), requestId = randomUUID();
  let child, spool;
  try {
    const source = `import {createFailureAuditSpool} from ${JSON.stringify(new URL('../src/infrastructure/failure-audit-spool.mjs', import.meta.url).href)};
      const spool=await createFailureAuditSpool({path:process.argv[1],endpoint:'https://fixture.example',write:()=>new Promise(()=>{})});
      const status=await spool.record({requestId:process.argv[2],status:503,route:'GET /readyz',actor:null});
      process.send({status});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', source, path, requestId],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    assert.equal((await once(child, 'message'))[0].status, 'queued');
    child.kill('SIGKILL'); await exited;
    const delivered = [];
    spool = await createFailureAuditSpool({ path, endpoint: 'https://fixture.example', write: async event => delivered.push(event) });
    await spool.flush();
    assert.equal(delivered.length, 1); assert.equal(delivered[0].requestId, requestId);
    assert.equal(spool.status().pending, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (spool) await spool.close(); await rm(directory, { recursive: true, force: true });
  }
});
