import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLocalGalaxyId, getLocalSnapshot, createCaseDraft, resetGalaxyIntegration } from '../packages/galaxy-core/src/local-store.mjs';

// Runs under Node or a host's actual Bun runtime; never touches a user store.
const directory = await mkdtemp(join(tmpdir(), 'galaxy-runtime-test-'));
try {
  assert.equal((await getLocalSnapshot(directory)).identity, null);
  assert.deepEqual(await readdir(directory), []);
  const initial = await initializeLocalGalaxyId(directory);
  await Promise.all(Array.from({ length: 12 }, (_, i) => createCaseDraft(directory,
    { title: `runtime-${i}`, failureSummary: 'Synthetic runtime fixture' })));
  const snapshot = await getLocalSnapshot(directory);
  assert.equal(snapshot.identity.id, initial.identity.id);
  assert.equal(snapshot.state.cases.length, 12);
  const names = await readdir(directory);
  const contents = await Promise.all(names.map(name => readFile(join(directory, name))));
  await getLocalSnapshot(directory);
  assert.deepEqual(await readdir(directory), names);
  for (let i = 0; i < names.length; i++) assert.deepEqual(await readFile(join(directory, names[i])), contents[i]);
  await resetGalaxyIntegration(directory);
  assert.equal((await getLocalSnapshot(directory)).identity, null);
  console.log(JSON.stringify({ check: 'core-runtime', runtime: process.versions.bun ? 'bun' : 'node',
    version: process.versions.bun ?? process.versions.node, concurrentWrites: 12, outcome: 'passed' }));
} finally { await rm(directory, { recursive: true, force: true }); }
