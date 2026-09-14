import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { getLocalSnapshot, listLocalHistory, exportLocalData, createCaseDraft, createDisclosurePlan, initializeLocalGalaxyId } from '../src/local-store.mjs';
import { writePrivateText } from '../src/storage/files.mjs';
import { withLocalWrite } from '../src/storage/write-lock.mjs';
import { createConnectionProfile, saveConnectionProfile, readConnectionProfile } from '../src/connection-profile.mjs';

test('snapshot, history and export neither initialize empty stores nor migrate legacy files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galaxy-read-test-'));
  try {
    const empty = join(root, 'not-created');
    assert.equal((await getLocalSnapshot(empty)).identity, null);
    assert.equal((await listLocalHistory(empty)).galaxyId, null);
    assert.equal((await exportLocalData(empty)).identity, null);
    assert.deepEqual(await readdir(root), []);
    const legacy = join(root, 'legacy');
    await mkdir(legacy);
    const identity = '{"id":"old-local-id","version":1}';
    const state = '{"version":1,"cases":[],"auditEvents":[]}';
    await writeFile(join(legacy, 'node.json'), identity);
    await writeFile(join(legacy, 'local-state.json'), state);
    assert.equal((await getLocalSnapshot(legacy)).identity.id, 'old-local-id');
    assert.equal((await listLocalHistory(legacy)).galaxyId.id, 'old-local-id');
    assert.equal((await exportLocalData(legacy)).identity.id, 'old-local-id');
    assert.deepEqual((await readdir(legacy)).sort(), ['local-state.json', 'node.json']);
    assert.equal(await readFile(join(legacy, 'node.json'), 'utf8'), identity);
    assert.equal(await readFile(join(legacy, 'local-state.json'), 'utf8'), state);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted initialization remnants are preserved instead of overwritten with a new identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galaxy-partial-test-'));
  try {
    for (const file of ['galaxy-id-private-key.pem', 'galaxy-id-public-key.pem', 'galaxy-local-state.json']) {
      const directory = join(root, file + '-fixture');
      await mkdir(directory);
      const bytes = 'synthetic interrupted content';
      await writeFile(join(directory, file), bytes);
      await assert.rejects(initializeLocalGalaxyId(directory), /initialization is incomplete/);
      assert.deepEqual((await readdir(directory)).filter(name => name !== '.galaxy-coordination.sqlite'), [file]);
      assert.equal(await readFile(join(directory, file), 'utf8'), bytes);
    }
    const destination = join(root, 'directory-cannot-be-replaced');
    await mkdir(destination);
    await writeFile(join(destination, 'keep'), 'unrelated');
    await assert.rejects(writePrivateText(destination, 'synthetic'));
    assert.ok(!(await readdir(root)).some(name => name.endsWith('.tmp')));
    assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'unrelated');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('connection-profile replacement waits for the shared Core write boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galaxy-profile-lock-test-'));
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let writing;
  let saving;
  try {
    writing = withLocalWrite(root, async () => { entered(); await hold; });
    await ready;
    const profile = createConnectionProfile({});
    saving = saveConnectionProfile(root, profile);
    assert.equal(await Promise.race([saving.then(() => 'saved'), delay(80, 'waiting')]), 'waiting');
    assert.equal(await readConnectionProfile(root), null);
    release(); await writing; await saving;
    assert.deepEqual(await readConnectionProfile(root), profile);
    assert.ok(!(await readdir(root)).includes('.galaxy-write.lock'));
  } finally {
    release(); await Promise.allSettled([writing, saving]);
    await rm(root, { recursive: true, force: true });
  }
});

test('same-process queued writers retain every event and continue after a rejected operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-queued-writers-'));
  try {
    await initializeLocalGalaxyId(directory);
    const results = await Promise.allSettled([
      createDisclosurePlan(directory, { caseId: 'missing' }),
      ...Array.from({ length: 24 }, (_, i) => createCaseDraft(directory, { title: `queued-${i}`, failureSummary: 'Synthetic queue' })),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.ok(results.slice(1).every(result => result.status === 'fulfilled'));
    const snapshot = await getLocalSnapshot(directory);
    assert.equal(new Set(snapshot.state.cases.map(item => item.title)).size, 24);
    assert.equal(snapshot.state.auditEvents.length, 25);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('independent Core writers retain one identity and all Case/audit updates; errors release the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galaxy-writer-test-'));
  const entry = new URL('../src/local-store.mjs', import.meta.url).href;
  const source = `const {initializeLocalGalaxyId,createCaseDraft}=await import(process.argv[1]);
    const directory=process.argv[2], label=process.argv[3];
    const initial=await initializeLocalGalaxyId(directory);
    for(let i=0;i<6;i++) await createCaseDraft(directory,{title:label+'-'+i,failureSummary:'Synthetic concurrent case'});
    console.log(JSON.stringify({id:initial.identity.id}));`;
  const children = [];
  try {
    const outputs = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, entry, root, String(index)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.resume();
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Writer exit ${code}`)));
    })));
    const snapshot = await getLocalSnapshot(root);
    assert.ok(outputs.every(output => output.id === snapshot.identity.id));
    assert.equal(snapshot.state.cases.length, 24);
    assert.equal(new Set(snapshot.state.cases.map(c => c.title)).size, 24);
    assert.equal(snapshot.state.auditEvents.filter(e => e.action === 'case.draft_created').length, 24);
    assert.equal(snapshot.state.auditEvents.filter(e => e.action === 'galaxy_id.initialized').length, 1);
    await assert.rejects(createDisclosurePlan(root, { caseId: 'missing' }), /not found/);
    await createCaseDraft(root, { title: 'after-error', failureSummary: 'Synthetic recovery' });
    assert.equal((await getLocalSnapshot(root)).state.cases.length, 25);
    assert.ok(!(await readdir(root)).includes('.galaxy-write.lock'));
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', resolve); child.kill();
    })));
    await rm(root, { recursive: true, force: true });
  }
});
