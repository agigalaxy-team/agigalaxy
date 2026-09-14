import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGalaxyGenesis, verifyGalaxyGenesis } from '../src/galaxy-guid.mjs';
import { initializeLocalGalaxyId } from '../src/local-store.mjs';

const publicPem = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });

test('genesis opening binds exact ID to Ed25519 public key; tampering and foreign keys fail', () => {
  const genesis = createGalaxyGenesis({ publicKeyPem: publicPem(), issuedAtMs: 1788935753000 });
  assert.equal(verifyGalaxyGenesis(genesis.id, genesis.genesisProof), true);
  for (const change of [ { publicKeyPem: publicPem() }, { nonce: 'A'.repeat(43) },
    { version: 2 }, { privateKey: 'must-not-be-accepted' }, { nonce: `${genesis.genesisProof.nonce}=` } ]) {
    assert.equal(verifyGalaxyGenesis(genesis.id, { ...genesis.genesisProof, ...change }), false);
  }
  assert.equal(verifyGalaxyGenesis(genesis.id.slice(0, -1) + (genesis.id.endsWith('0') ? '1' : '0'), genesis.genesisProof), false);
  assert.equal(verifyGalaxyGenesis('legacy-id', genesis.genesisProof), false);
  assert.equal(verifyGalaxyGenesis(genesis.id, null), false);
});

test('new initialization persists proof; existing identity without opening is never silently replaced', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'galaxy-genesis-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { identity } = await initializeLocalGalaxyId(dir);
  assert.equal(verifyGalaxyGenesis(identity.id, identity.genesisProof), true);
  const keyBefore = await readFile(join(dir, 'galaxy-id-private-key.pem'));
  const legacy = { ...identity }; delete legacy.genesisProof;
  await writeFile(join(dir, 'galaxy-id.json'), JSON.stringify(legacy));
  const again = await initializeLocalGalaxyId(dir);
  assert.deepEqual(again.identity, legacy);
  assert.deepEqual(await readFile(join(dir, 'galaxy-id-private-key.pem')), keyBefore);
});
