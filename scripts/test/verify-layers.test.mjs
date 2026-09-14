import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLayer, outcome } from '../verify-layers.mjs';

test('layer evidence preserves subprocess failure and overdue completion; unrun layers cannot become full acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-layer-check-'));
  try {
    const failed = await runLayer({ id: 'failed', args: ['-e', 'console.log("synthetic failure"); process.exit(7)'] }, { directory });
    assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 7);
    assert.match(await readFile(failed.log, 'utf8'), /synthetic failure/);
    const updates = [];
    const slow = await runLayer({ id: 'slow', args: ['-e', 'setTimeout(() => {}, 100)'] },
      { directory, overdueMs: 10, onProgress: value => updates.push(value) });
    assert.equal(slow.status, 'passed'); assert.equal(slow.overdue, true);
    assert.ok(updates.some(row => row.overdue && row.status === 'running'));
    assert.equal(outcome([slow, { status: 'not-run' }, { status: 'manual' }]).automatedComplete, false);
    assert.equal(outcome([failed]).selectedPassed, false);
    assert.equal(outcome([slow, { status: 'blocked' }]).selectedPassed, false);
    assert.equal(outcome([slow]).releaseReady, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
