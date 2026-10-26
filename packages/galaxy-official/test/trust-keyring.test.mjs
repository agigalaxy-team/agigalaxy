import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { issueKeyring, verifyKeyring } from "../src/security/trust-keyring.mjs";
import { signEnvelope, verifyEnvelope } from "../src/security/signed-envelope.mjs";
import { acceptKeyring } from "../src/security/trust-store.mjs";
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pinned root authorizes rotation and revocation; old and conflicting lists cannot restore trust', async () => {
  const root = generateKeyPairSync('ed25519');
  const old = generateKeyPairSync('ed25519');
  const next = generateKeyPairSync('ed25519');
  const endpoint = 'https://official.example.org';
  const now = 2000000000;
  const key = (pair, kid, revoked = false) => ({ kid, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    notBefore: now - 1, notAfter: now + 200000, revoked });
  const rootPins = new Map([['root', key(root, 'root')]]);
  const issue = (sequence, keys) => issueKeyring({ endpoint, sequence, keys, rootKid: 'root', rootPrivateKey: root.privateKey, now });
  const first = await issue(1, [key(old, 'old')]);
  const accepted = await verifyKeyring(first, { endpoint, rootPins, now });
  await assert.rejects(verifyKeyring(first, { endpoint, rootPins: new Map(), now }));
  await assert.rejects(verifyKeyring(first, { endpoint, rootPins, now: now + 86400 }));
  const second = await issue(2, [key(old, 'old', true), key(next, 'next')]);
  const rotated = await verifyKeyring(second, { endpoint, rootPins, now, previousState: accepted.nextState });
  const verify = { type: 'manifest', issuer: endpoint, audience: endpoint, trustedKeys: rotated.keys, now };
  const token = pair => signEnvelope({ type: 'manifest', issuer: endpoint, audience: endpoint,
    kid: pair === old ? 'old' : 'next', privateKey: pair.privateKey, now, data: {} });
  await verifyEnvelope(await token(next), verify);
  await assert.rejects(verifyEnvelope(await token(old), verify));
  await assert.rejects(verifyEnvelope(await token(next), { ...verify, now: now + 86400 }));
  const laterToken = await signEnvelope({ type: 'manifest', issuer: endpoint, audience: endpoint,
    kid: 'next', privateKey: next.privateKey, now: now + 86399, data: {} });
  await assert.rejects(verifyEnvelope(laterToken, { ...verify, now: now + 86400 }), /expired signing key/);
  await assert.rejects(verifyKeyring(first, { endpoint, rootPins, now, previousState: rotated.nextState }), /rollback/);
  for (const invalid of [await issue(2, [key(next, 'next')]), await issue(3, [key(old, 'old')]),
    await issue(3, [key(next, 'old')])]) {
    await assert.rejects(verifyKeyring(invalid, { endpoint, rootPins, now, previousState: rotated.nextState }));
  }
  assert.deepEqual((await verifyKeyring(second, { endpoint, rootPins, now, previousState: rotated.nextState })).nextState, rotated.nextState);
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-trust-test-'));
  try {
    await acceptKeyring(first, { endpoint, rootPins, now, directory });
    await acceptKeyring(second, { endpoint, rootPins, now, directory });
    await assert.rejects(acceptKeyring(first, { endpoint, rootPins, now, directory }), /rollback/);
    await acceptKeyring(second, { endpoint, rootPins, now, directory });
    assert.equal((await readdir(directory)).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
