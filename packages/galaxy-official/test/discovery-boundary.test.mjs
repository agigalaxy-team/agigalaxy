import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyManifest as compatibilityManifest } from '../src/manifest.mjs';
import { verifyManifest } from '../src/verification/manifest.mjs';
import { verifyEnvelope as compatibilityEnvelope } from "../src/security/signed-envelope.mjs";
import { verifyEnvelope } from '../src/verification/envelope.mjs';
import { verifyKeyring as compatibilityKeyring } from "../src/security/trust-keyring.mjs";
import { verifyKeyring } from '../src/verification/keyring.mjs';

test('public discovery graph excludes server signing, sessions, identity and database modules', async () => {
  const visited = new Set();
  const forbidden = new Set(['signed-envelope.mjs', 'signing-service.mjs', 'manifest.mjs',
    'trust-keyring.mjs', 'services.mjs', 'access.mjs', 'database.mjs', 'bindings.mjs', 'local-store.mjs']);
  async function inspect(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = await readFile(url, 'utf8');
    assert.equal(/\b(?:privateKey|rootPrivateKey|signEnvelope|createSigningService)\b/.test(source), false, url.pathname);
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.equal(['pg', '@electric-sql/pglite'].some(name => specifier === name || specifier.startsWith(name + '/')), false);
      if (specifier.startsWith('.')) {
        const next = new URL(specifier, url);
        const basename = next.pathname.split('/').at(-1);
        assert.equal(forbidden.has(basename) && !next.pathname.includes('/verification/'), false, next.pathname);
        await inspect(next);
      }
    }
  }
  await inspect(new URL("../src/clients/discovery.mjs", import.meta.url));
  assert.ok([...visited].some(path => path.endsWith('/verification/keyring.mjs')));
  assert.ok([...visited].some(path => path.endsWith('/verification/manifest.mjs')));
});

test('legacy verifier exports retain the same implementations after extraction', () => {
  assert.equal(compatibilityManifest, verifyManifest);
  assert.equal(compatibilityEnvelope, verifyEnvelope);
  assert.equal(compatibilityKeyring, verifyKeyring);
});
