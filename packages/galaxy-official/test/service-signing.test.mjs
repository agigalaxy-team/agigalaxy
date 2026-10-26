import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServices } from '../src/services.mjs';
import { verifyEnvelope } from "../src/security/signed-envelope.mjs";

test('production composition gives each service only its signing purposes and honors live revocation', async () => {
  const key = generateKeyPairSync('ed25519');
  const endpoint = 'https://official.example.org';
  const now = 2000000000;
  const trustedKeys = new Map([['test', { publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }),
    notBefore: now - 1, notAfter: now + 100000, revoked: false }]]);
  const services = createServices({ db: null, endpoint, signingKey: key.privateKey, kid: 'test',
    trustedKeys, now: () => now, operator: 'Fixture', region: 'test' });
  assert.equal(services.bindings.signingKey, undefined);
  assert.equal(services.access.signingKey, undefined);
  assert.equal(services.manifest.bindings, undefined);
  await assert.rejects(services.bindings.sign('proof', {}, 'x', 60), /signing_purpose_denied/);
  await assert.rejects(services.access.sign('binding-receipt', {}, 'x', 60), /signing_purpose_denied/);
  await assert.rejects(services.proofs.sign('session-challenge', {}, 'x', 60), /signing_purpose_denied/);
  const signed = await services.proofs.sign('proof', { capabilityVerified: false }, 'x', 60);
  const checked = await verifyEnvelope(signed, { type: 'proof', issuer: endpoint, audience: endpoint, trustedKeys, now, maxAge: 60 });
  assert.equal(checked.data.capabilityVerified, false);
  await services.manifest.get();
  trustedKeys.get('test').revoked = true;
  await assert.rejects(services.proofs.sign('proof', {}, 'x', 60), /signing_unavailable/);
  await assert.rejects(services.manifest.get(), /signing_unavailable/);
});
