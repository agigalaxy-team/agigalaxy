import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveDataExport } from '../src/local-data-export.mjs';
import { verifyDataExportWorkflow } from './data-export-workflow.mjs';

test('own-data export joins API/client/host, scopes records, preserves historical Proofs and expires download tickets', () => verifyDataExportWorkflow());
test('canceled local export retains marked partial files and never reports completion', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'galaxy-export-cancel-')), control = new AbortController();
  try {
    await assert.rejects(saveDataExport({ download: async (_id, { onPage, signal }) => {
      await onPage({ dataset: 'identity', items: [{ id: 'synthetic' }] }); control.abort(); signal.throwIfAborted();
    } }, 'synthetic', parent, { signal: control.signal }), /incomplete/);
    const directory = join(parent, (await readdir(parent))[0]);
    assert.equal(JSON.parse(await readFile(join(directory, 'incomplete.json'), 'utf8')).complete, false);
    assert.ok((await readdir(directory)).includes('identity.ndjson.partial'));
    assert.ok(!(await readdir(directory)).includes('manifest.json'));
  } finally { await rm(parent, { recursive: true, force: true }); }
});
