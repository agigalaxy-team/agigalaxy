import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { businessApiReference, specialApiReference } from '../reference/http-api-entries.mjs';
import { buildApiReference } from '../build-api-reference.mjs';

test('authored API subset uses existing current schema sources and current documentation', async () => {
  const seen = new Set();
  for (const entry of [...businessApiReference, ...specialApiReference]) {
    const key = entry.method + ' ' + entry.path;
    assert.ok(!seen.has(key), key); seen.add(key);
    await access(new URL('../../' + entry.documentation, import.meta.url));
    if (entry.input?.schema) {
      const path = entry.input.schema.split(':')[0];
      assert.match(path, /^(packages\/galaxy-contracts\/src|go\/internal)\//);
      await access(new URL('../../' + path, import.meta.url));
    }
  }
});

test('generated reference reads current Go declarations and retains its limited development scope', async () => {
  await buildApiReference({ check: true });
  const catalog = JSON.parse(await readFile(new URL('../../docs/technical/reference/development-api-reference-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(catalog.publicApiEndpoints, []);
  assert.equal(catalog.coverage, 'authored-subset-not-complete-current-http-surface');
  assert.equal(catalog.entries.length, businessApiReference.length + specialApiReference.length);
  assert.ok(catalog.sources.length > 0);
  assert.ok(catalog.sources.every(path => path.startsWith('go/')));
});
