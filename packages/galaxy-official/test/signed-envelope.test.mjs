import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { signEnvelope, verifyEnvelope } from '../src/signed-envelope.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pin = { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  notBefore: 900, notAfter: 2000, revoked: false };
const base = { type: 'manifest', issuer: 'https://official.example.org',
  audience: 'https://official.example.org', now: 1000, maxAge: 300 };
const verify = { ...base, trustedKeys: new Map([['test-key', pin]]) };
const issue = { ...base, kid: 'test-key', privateKey, data: { schemaVersion: 1 }, id: 'fixture-manifest' };

test('signed object retains exact payload and enforces purpose, origin, lifetime and pins', async () => {
  const token = await signEnvelope(issue);
  assert.deepEqual((await verifyEnvelope(token, verify)).data, issue.data);
  for (const change of [{ type: 'proof' }, { issuer: 'https://foreign.example.org' },
    { audience: 'https://foreign.example.org' }, { now: 999 }, { now: 1300 }, { maxAge: 299 },
    { trustedKeys: new Map() }, { trustedKeys: new Map([['test-key', { ...pin, revoked: true }]]) },
    { trustedKeys: new Map([['test-key', { ...pin, notAfter: 1200 }]]) }]) {
    await assert.rejects(verifyEnvelope(token, { ...verify, ...change }));
  }
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ data: { schemaVersion: 999 } })).toString('base64url');
  await assert.rejects(verifyEnvelope(parts.join('.'), verify));
  await assert.rejects(verifyEnvelope('x'.repeat(65537), verify));
});

test('valid signatures with extra headers, wrong algorithm or excessive lifetime fail', async () => {
  for (const header of [{ alg: 'EdDSA', typ: 'galaxy-manifest+jwt', kid: 'test-key' },
    { alg: 'Ed25519', typ: 'galaxy-manifest+jwt', kid: 'test-key', jku: 'https://foreign.example.org' }]) {
    const token = await new SignJWT({ data: {} }).setProtectedHeader(header).setIssuer(base.issuer)
      .setAudience(base.audience).setIssuedAt(1000).setNotBefore(1000).setExpirationTime(1100)
      .setJti('fixture').sign(privateKey);
    await assert.rejects(verifyEnvelope(token, verify));
  }
  await assert.rejects(verifyEnvelope(await signEnvelope({ ...issue, maxAge: 301 }), verify));
  await assert.rejects(signEnvelope({ ...issue, issuer: 'http://official.example.org' }));
});
