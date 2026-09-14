import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { withLocalRead, withLocalWrite } from '../src/storage/write-lock.mjs';
import { localPaths } from '../src/storage/files.mjs';
import { resetLocalFiles } from '../src/storage/reset.mjs';
import { initializeLocalGalaxyId, getLocalSnapshot, resetGalaxyIntegration } from '../src/local-store.mjs';

test('a shared snapshot keeps identity and state together while reset waits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-read-reset-'));
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let reading, resetting;
  try {
    const initial = await initializeLocalGalaxyId(directory);
    reading = withLocalRead(directory, async () => {
      const identity = JSON.parse(await readFile(localPaths(directory).identity, 'utf8'));
      entered(); await gate;
      const state = JSON.parse(await readFile(localPaths(directory).state, 'utf8'));
      return { identity, state };
    });
    await ready;
    resetting = resetGalaxyIntegration(directory);
    assert.equal(await Promise.race([resetting.then(() => 'reset'), delay(80, 'waiting')]), 'waiting');
    release();
    const read = await reading;
    assert.equal(read.identity.id, initial.identity.id);
    assert.equal(read.state.auditEvents[0].subjectId, initial.identity.id);
    await resetting;
    const after = await getLocalSnapshot(directory);
    assert.equal(after.identity, null);
    assert.equal(after.state.auditEvents.length, 0);
  } finally {
    release(); await Promise.allSettled([reading, resetting]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('a read overlapping first-time coordination creation retries under the new lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-first-reader-'));
  let calls = 0;
  try {
    await withLocalRead(directory, async () => {
      if (++calls === 1) await initializeLocalGalaxyId(directory);
    });
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('interrupted reset hides partial identity and resumes only the fixed managed-file list', async () => {
  for (const stopAt of ['.galaxy-initialization.json', 'galaxy-id.json', 'galaxy-id-private-key.pem', 'galaxy-local-state.json']) {
    const directory = await mkdtemp(join(tmpdir(), 'galaxy-reset-recovery-'));
    try {
      const original = await initializeLocalGalaxyId(directory);
      await writeFile(join(directory, 'unknown-user-file'), 'keep');
      await assert.rejects(withLocalWrite(directory, () => resetLocalFiles(localPaths(directory), async file => {
        if (file === stopAt) throw new Error('fixture reset interruption');
      })), /fixture reset interruption/);
      const pending = await getLocalSnapshot(directory);
      assert.equal(pending.identity, null);
      assert.equal(pending.recoveryRequired, true);
      const renewed = await initializeLocalGalaxyId(directory);
      assert.notEqual(renewed.identity.id, original.identity.id);
      assert.equal(renewed.state.auditEvents.length, 1);
      assert.equal(await readFile(join(directory, 'unknown-user-file'), 'utf8'), 'keep');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
