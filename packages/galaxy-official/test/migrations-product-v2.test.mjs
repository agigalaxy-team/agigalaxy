import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { migrations } from '../src/infrastructure/migrations.mjs';

test('product v2 preserves all 41 prior migration SQL bodies byte for byte', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/migrations-before-product-v2.json', import.meta.url),'utf8'));
  assert.equal(baseline.migrations.length,41);
  for(const old of baseline.migrations) assert.equal(createHash('sha256').update(migrations.find(m=>m.version===old.version).sql).digest('hex'),old.sha256,
    'append a new migration; do not rewrite version '+old.version);
  assert.equal(new Set(migrations.map(m=>m.version)).size,migrations.length);
});

