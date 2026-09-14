import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { prepareServiceConfiguration } from './prepare-service-config.mjs';

test('selected website configuration cannot change endpoint, overwrite settings or initialize identity', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'galaxy-public-config-'));
  const output = join(folder, 'public.json'), dataDirectory = join(folder, 'not-created');
  const now = Math.floor(Date.now() / 1000), { publicKey } = generateKeyPairSync('ed25519');
  const source = { version: 1, endpoint: 'https://api.galaxy.invalid', operator: 'fixture', signingKeys: [{
    kid: 'fixture', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    notBefore: now - 30, notAfter: now + 3600, revoked: false,
  }] };
  const options = { website: 'https://galaxy.invalid', endpoint: source.endpoint, dataDirectory, output, now,
    fetch: async (url, init) => { assert.equal(url, 'https://galaxy.invalid/galaxy-web-config.json');
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); return Response.json(source); } };
  try {
    const result = await prepareServiceConfiguration(options);
    assert.equal(result.connected, false); assert.equal(result.identityCreated, false);
    await assert.rejects(access(dataDirectory));
    const saved = await readFile(output, 'utf8');
    assert.equal(JSON.parse(saved).trustedKeys.fixture.publicKeyPem, source.signingKeys[0].publicKeyPem);
    await assert.rejects(prepareServiceConfiguration(options), { code: 'EEXIST' });
    assert.equal(await readFile(output, 'utf8'), saved);
    await assert.rejects(prepareServiceConfiguration({ ...options, endpoint: 'https://elsewhere.invalid' }), /explicitly selected/);
    await assert.rejects(prepareServiceConfiguration({ ...options, now: now + 7200 }), /currently valid/);
    await assert.rejects(prepareServiceConfiguration({ ...options, fetch: async () => new Response('x'.repeat(17000)) }), /bounded/);
    await assert.rejects(prepareServiceConfiguration({ ...options, website: 'https://user:pass@galaxy.invalid' }));
  } finally {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('galaxy-public-config-'));
    await rm(folder, { recursive: true, force: true });
  }
});
