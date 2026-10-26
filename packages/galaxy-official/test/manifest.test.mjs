import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ManifestService, verifyManifest } from '../src/manifest.mjs';
import { isPublicAddress, validatePublicUrl, fetchPublicJson } from "../src/infrastructure/public-fetch.mjs";
import { createApi } from '../src/http.mjs';

test('anonymous Manifest endpoint caches signed data without asserting a binding', async () => {
  const pair = generateKeyPairSync('ed25519');
  let now = 2000000000;
  const bindings = { endpoint: 'https://official.example.org', signingKey: pair.privateKey,
    kid: 'fixture', now: () => now, trustedKeys: new Map([['fixture', {
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      notBefore: now - 1, notAfter: now + 10000, revoked: false }]]) };
  const manifest = new ManifestService({ bindings, operator: 'Synthetic test operator', region: 'test', capabilities: ['binding', 'sessions'] });
  const api = createApi({ bindings, manifest });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${api.address().port}/.well-known/galaxy-network.json`;
    const response = await fetch(url);
    const document = await response.json();
    const options = { endpoint: bindings.endpoint, trustedKeys: bindings.trustedKeys, now };
    const verified = await verifyManifest(document, options);
    assert.equal(verified.state, 'verified'); assert.equal(verified.connected, false); assert.equal(verified.authorized, false);
    assert.equal((await fetch(url, { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
    await assert.rejects(verifyManifest(document, { ...options, endpoint: 'https://other.example.org' }));
    await assert.rejects(verifyManifest(document, { ...options, trustedKeys: new Map() }));
    await assert.rejects(verifyManifest(document, { ...options, now: now + 300 }));
    now += 61;
    assert.notEqual((await manifest.get()).etag, response.headers.get('etag'));
    bindings.trustedKeys.get('fixture').revoked = true;
    await assert.rejects(manifest.get());
    await assert.rejects(verifyManifest(document, { ...options, now }));
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
});

test('public reader rejects unsafe destinations before opening any socket', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1',
    '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const value of ['http://example.org', 'https://user:secret@example.org', 'https://localhost',
    'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]',
    'https://example.org:8080', 'https://example.org/?token=secret', 'https://example.org/#fragment']) {
    assert.throws(() => validatePublicUrl(value));
    await assert.rejects(fetchPublicJson(value));
  }
});
