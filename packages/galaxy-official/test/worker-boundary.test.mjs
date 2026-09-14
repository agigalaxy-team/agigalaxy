import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('verification worker dependency graph excludes identity, sessions and signing services', async () => {
  const forbidden = new Set(['bindings.mjs', 'access.mjs', 'consents.mjs', 'signed-envelope.mjs', 'proofs.mjs']);
  const visited = new Set();
  async function inspect(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    assert.equal(forbidden.has(url.pathname.split('/').at(-1)), false, url.pathname);
    const source = await readFile(url, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      await inspect(new URL(match[1], url));
    }
  }
  await inspect(new URL('../src/worker.mjs', import.meta.url));
});
