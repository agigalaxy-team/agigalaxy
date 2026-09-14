import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeLocalGalaxyId, getLocalSnapshot, getGalaxyCommandSurface } from '../src/local-store.mjs';

test('forced writer termination releases native lock and resumes the same identity at five boundaries', { timeout: 30000 }, async () => {
  for (const phase of ['journal', 'private-key', 'public-key', 'state', 'identity']) {
    const directory = await mkdtemp(join(tmpdir(), 'galaxy-killed-writer-'));
    let child;
    let closed;
    try {
      child = fork(fileURLToPath(new URL('./fixtures/interrupted-initializer.mjs', import.meta.url)), [directory, phase],
        { execPath: process.execPath, execArgv: [], silent: true, windowsHide: true });
      child.stdout.resume(); child.stderr.resume();
      closed = once(child, 'close');
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
      assert.equal(message.phase, phase);
      assert.equal(child.kill('SIGKILL'), true);
      await closed;
      const recovered = await initializeLocalGalaxyId(directory);
      assert.equal(recovered.identity.id, message.id);
      assert.equal(recovered.state.auditEvents.length, 1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('legacy file lock prevents an unsafe mixed-version upgrade and is never guessed stale', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-old-lock-'));
  try {
    const path = join(directory, '.galaxy-write.lock');
    const original = '{"pid":99999999,"createdAt":"2000-01-01"}';
    await writeFile(path, original);
    await assert.rejects(initializeLocalGalaxyId(directory), /Legacy Galaxy write lock/);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('forced reset termination preserves recovery status and resumes without deleting unknown files', { timeout: 30000 }, async () => {
  for (const phase of ['.galaxy-initialization.json', 'galaxy-id.json', 'galaxy-id-private-key.pem', 'galaxy-local-state.json']) {
    const directory = await mkdtemp(join(tmpdir(), 'galaxy-killed-reset-'));
    let child, closed;
    try {
      const old = await initializeLocalGalaxyId(directory);
      await writeFile(join(directory, 'unknown'), 'keep');
      child = fork(fileURLToPath(new URL('./fixtures/interrupted-reset.mjs', import.meta.url)), [directory, phase],
        { execPath: process.execPath, execArgv: [], silent: true, windowsHide: true });
      child.stdout.resume(); child.stderr.resume(); closed = once(child, 'close');
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
      assert.equal(message.phase, phase);
      child.kill('SIGKILL'); await closed;
      assert.equal((await getLocalSnapshot(directory)).recoveryRequired, true);
      assert.equal((await getGalaxyCommandSurface(directory)).state, 'recovery-required');
      const renewed = await initializeLocalGalaxyId(directory);
      assert.notEqual(renewed.identity.id, old.identity.id);
      assert.equal(await readFile(join(directory, 'unknown'), 'utf8'), 'keep');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
      await rm(directory, { recursive: true, force: true });
    }
  }
});
