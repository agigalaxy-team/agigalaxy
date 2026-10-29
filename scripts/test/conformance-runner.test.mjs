import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveChecks } from '../run-conformance.mjs';
import { fingerprint } from '../run-conformance.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
test('runner does not turn absent, skipped, failed or changed-source checks into a pass', () => {
  const good={success:true,counts:{tests:2,passed:2,failed:0,cancelled:0,skipped:0,todo:0}};
  const mapping={evidence:['first','second']};
  assert.equal(deriveChecks(mapping,{first:good,second:good})[0].status,'pass');
  assert.equal(deriveChecks(mapping,{first:good})[0].status,'not-tested');
  assert.equal(deriveChecks(mapping,{first:good,second:{...good,counts:{...good.counts,tests:0}}})[0].status,'not-tested');
  assert.equal(deriveChecks(mapping,{first:good,second:{...good,counts:{...good.counts,skipped:1}}})[0].status,'not-tested');
  assert.equal(deriveChecks(mapping,{first:good,second:{...good,success:false}})[0].status,'fail');
  assert.equal(deriveChecks(mapping,{first:good,second:good},false)[0].status,'not-tested');
});

test('conformance source identity includes current Go, SQL and shared contracts without retired Node source', async () => {
  const current = await fingerprint();
  const expected = ['go/go.mod', 'go/internal/databaseschema/sql/133.sql',
    'go/internal/identity/control-chain.go', 'docs/technical/reference/version-contract.json',
    'packages/galaxy-contracts/src/consents-schema.mjs'];
  for (const name of expected) assert.match(current.files[name], /^[0-9a-f]{64}$/, name);
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-source-fingerprint-'));
  try {
    for (const name of Object.keys(current.files)) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'fixture');
    }
    const before = await fingerprint(directory);
    await writeFile(join(directory, 'go/internal/databaseschema/sql/133.sql'), '-- changed migration');
    const after = await fingerprint(directory);
    assert.notEqual(after.sha256, before.sha256);
    assert.deepEqual(Object.keys(after.files), Object.keys(before.files));
  } finally {
    const child = relative(tmpdir(), directory);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(directory, { recursive: true, force: true });
  }
});
