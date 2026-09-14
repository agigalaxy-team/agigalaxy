import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGalaxyGenesis, verifyGalaxyGenesis } from '../src/galaxy-guid.mjs';
import { emptyState, addAuditEvent, fingerprint } from '../src/domain/local-model.mjs';
import { localPaths } from '../src/storage/files.mjs';
import { withLocalWrite } from '../src/storage/write-lock.mjs';
import { publishInitialization } from '../src/storage/initialization.mjs';
import { initializeLocalGalaxyId, getLocalSnapshot, resetGalaxyIntegration } from '../src/local-store.mjs';

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const genesis = createGalaxyGenesis({ publicKeyPem });
  const identity = { id: genesis.id, genesisProof: genesis.genesisProof, publicKeyFingerprint: fingerprint(publicKeyPem), version: 2 };
  const state = emptyState();
  addAuditEvent(state, 'galaxy_id.initialized', identity.id, { localOnly: true });
  return { version: 1, identity, state, publicKeyPem, privateKeyPem };
}

test('initialization resumes the same identity after every journal/file publication boundary', async () => {
  for (const phase of ['journal', 'private-key', 'public-key', 'state', 'identity']) {
    const directory = await mkdtemp(join(tmpdir(), 'galaxy-init-recovery-'));
    try {
      const record = fixture();
      await assert.rejects(withLocalWrite(directory, () => publishInitialization(localPaths(directory), record,
        async current => { if (current === phase) throw new Error('fixture interruption'); })), /fixture interruption/);
      const names = await readdir(directory);
      await getLocalSnapshot(directory);
      assert.deepEqual(await readdir(directory), names, 'read does not resume initialization');
      const result = await initializeLocalGalaxyId(directory);
      assert.equal(result.identity.id, record.identity.id);
      assert.ok(verifyGalaxyGenesis(result.identity.id, result.identity.genesisProof));
      assert.equal(await readFile(localPaths(directory).privateKey, 'utf8'), record.privateKeyPem);
      assert.equal(result.state.auditEvents.length, 1);
      assert.ok(!(await readdir(directory)).includes('.galaxy-initialization.json'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('conflicting recovery material is preserved; explicit reset cancels pending publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-init-conflict-'));
  try {
    const record = fixture();
    const paths = localPaths(directory);
    await assert.rejects(withLocalWrite(directory, () => publishInitialization(paths, record,
      async phase => { if (phase === 'journal') throw new Error('fixture stop'); })), /fixture stop/);
    await writeFile(paths.publicKey, 'conflicting synthetic material');
    await assert.rejects(initializeLocalGalaxyId(directory), /Conflicting local initialization files/);
    assert.equal(await readFile(paths.publicKey, 'utf8'), 'conflicting synthetic material');
    assert.ok(!(await readdir(directory)).includes('galaxy-id-private-key.pem'), 'conflict preflight must precede missing writes');
    await writeFile(join(directory, 'unrelated'), 'keep');
    await resetGalaxyIntegration(directory);
    assert.deepEqual((await readdir(directory)).sort(), ['.galaxy-coordination.sqlite', 'unrelated']);
    const fresh = await initializeLocalGalaxyId(directory);
    assert.notEqual(fresh.identity.id, record.identity.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
