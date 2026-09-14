import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { initializeGalaxyIntegration, createCaseDraft, getLocalSnapshot } from '../src/local-store.mjs';
import { withLocalRead } from '../src/storage/write-lock.mjs';

test('synthetic offline backup restores identity and prior facts into an isolated store without merging later state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-restore-drill-'));
  try {
    const live = join(directory, 'live'), restored = join(directory, 'restored');
    await initializeGalaxyIntegration(live, { profile: 'coding-case', source: 'restore-test' });
    await createCaseDraft(live, { title: 'Before backup', failureSummary: 'Synthetic restore fixture only' });
    const before = await getLocalSnapshot(live);
    // An operator backup includes the private key, held only in this temporary
    // drill. Public exports deliberately omit it and cannot restore identity.
    const files = ['galaxy-id.json', 'galaxy-id-private-key.pem', 'galaxy-id-public-key.pem', 'galaxy-local-state.json'];
    const backup = await withLocalRead(live, async () => Promise.all(files.map(async name => ({ name, bytes: await readFile(join(live, name)) }))));
    await createCaseDraft(live, { title: 'After backup', failureSummary: 'Must not leak into restored checkpoint' });
    await mkdir(restored);
    for (const file of backup) await writeFile(join(restored, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
    const recovered = await getLocalSnapshot(restored);
    assert.deepEqual(recovered.identity, before.identity);
    assert.deepEqual(recovered.state, before.state);
    assert.equal(recovered.state.cases.length, 1);
    assert.equal((await getLocalSnapshot(live)).state.cases.length, 2);
    for (const file of backup) assert.equal(createHash('sha256').update(await readFile(join(restored, file.name))).digest('hex'),
      createHash('sha256').update(file.bytes).digest('hex'));
    const key = createPrivateKey(await readFile(join(restored, 'galaxy-id-private-key.pem')));
    assert.equal(createPublicKey(key).export({ type: 'spki', format: 'pem' }), recovered.identity.genesisProof.publicKeyPem);
    await createCaseDraft(restored, { title: 'After recovery', failureSummary: 'New write after restored checkpoint' });
    assert.equal((await getLocalSnapshot(restored)).identity.id, before.identity.id);
    assert.equal((await getLocalSnapshot(restored)).state.cases.length, 2);
  } finally {
    const child = relative(tmpdir(), directory); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true });
  }
});
