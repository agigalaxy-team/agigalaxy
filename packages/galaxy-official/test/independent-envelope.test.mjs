import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyIndependent } from '../examples/verify-envelope-independent.mjs';
import { signEnvelope, verifyEnvelope } from '../src/signed-envelope.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const policy = { type: 'proof', kid: 'fixture-only', issuer: 'https://official.example.org',
  audience: 'https://official.example.org', now: 1000, maxAge: 300,
  notBefore: 900, notAfter: 2000, revoked: false };
const issue = { ...policy, privateKey: keys.privateKey, data: { label: '合成证据', value: 1 }, id: 'independent-example' };

test('production JOSE output verifies independently using only Node crypto and an external pin', async () => {
  const token = await signEnvelope(issue);
  const input = { token, publicKeyPem, policy };
  assert.deepEqual(verifyIndependent(input), { validSignature: true, authorized: false,
    id: issue.id, data: issue.data });
  // Repeated cryptographic verification is allowed: the database, not JWT,
  // implements challenge consumption and current binding/consent authorization.
  assert.equal(verifyIndependent(input).authorized, false);
  for (const delta of [{ type: 'manifest' }, { audience: 'https://other.example.org' },
    { issuer: 'https://other.example.org' }, { now: 999 }, { now: 1300 },
    { revoked: true }, { trustedUntil: 1000 }, { notAfter: 1200 }, { kid: 'unknown' }]) {
    assert.throws(() => verifyIndependent({ ...input, policy: { ...policy, ...delta } }));
  }
  const parts = token.split('.');
  parts[1] = Buffer.from('{"data":{"value":999}}').toString('base64url');
  assert.throws(() => verifyIndependent({ ...input, token: parts.join('.') }));
  assert.throws(() => verifyIndependent({ ...input, publicKeyPem: generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' }) }));
});

test('independently signed exact JSON bytes verify with production JOSE; confusion cases fail both', async () => {
  const header = { alg: 'Ed25519', typ: 'galaxy-proof+jwt', kid: policy.kid };
  // Intentional whitespace and ordering differ from the production serializer.
  const payload = { jti: issue.id, nbf: 1000, exp: 1300, iat: 1000,
    aud: policy.audience, iss: policy.issuer, data: issue.data };
  const mint = (h, p) => {
    const encoded = [JSON.stringify(h, null, 1), JSON.stringify(p, null, 2)]
      .map(s => Buffer.from(s).toString('base64url')).join('.');
    return `${encoded}.${sign(null, Buffer.from(encoded), keys.privateKey).toString('base64url')}`;
  };
  const options = { ...policy, trustedKeys: new Map([[policy.kid, { ...policy, publicKeyPem }]]) };
  const token = mint(header, payload);
  assert.deepEqual((await verifyEnvelope(token, options)).data, issue.data);
  assert.deepEqual(verifyIndependent({ token, publicKeyPem, policy }).data, issue.data);
  for (const [h, p] of [[{ ...header, alg: 'EdDSA' }, payload],
    [{ ...header, jku: 'https://other.example.org' }, payload],
    [header, { ...payload, aud: [policy.audience] }], [header, { ...payload, exp: 1301 }]]) {
    const invalid = mint(h, p);
    await assert.rejects(verifyEnvelope(invalid, options));
    assert.throws(() => verifyIndependent({ token: invalid, publicKeyPem, policy }));
  }
});

test('published synthetic fixture is independently verifiable and carries no authorization', () => {
  const fixture = JSON.parse(readFileSync(new URL('../examples/envelope-fixture.json', import.meta.url), 'utf8'));
  assert.equal(verifyIndependent(fixture).authorized, false);
});
