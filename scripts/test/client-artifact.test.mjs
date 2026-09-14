import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildClient, importsOf } from '../build-client.mjs';

test('client artifact has only approved source/dependencies and deterministic hashes; existing paths are preserved', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'galaxy-client-artifact-'));
  try {
    const a = join(temporary, 'a'), b = join(temporary, 'b');
    const first = await buildClient(a); const second = await buildClient(b);
    assert.equal(first.files, second.files);
    assert.deepEqual(Object.keys(first.dependencies), ['canonicalize', 'ipaddr.js', 'jose', 'zod']);
    const manifest = JSON.parse(await readFile(join(a, 'package.json'), 'utf8'));
    const contract = JSON.parse(await readFile(new URL('../../docs/version-contract.json', import.meta.url), 'utf8'));
    assert.equal(manifest.version, contract.versions.client);
    assert.equal(manifest.private, true);
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.dependencies.pg, undefined);
    assert.equal(Object.keys(manifest.exports).length, 22);
    assert.equal(await readFile(join(a, 'source-hashes.json'), 'utf8'), await readFile(join(b, 'source-hashes.json'), 'utf8'));
    assert.equal(await readFile(join(a, 'package-lock.json'), 'utf8'), await readFile(join(b, 'package-lock.json'), 'utf8'));
    await assert.rejects(buildClient(a), { code: 'EEXIST' });
    const inventory = await readdir(join(a, 'lib/packages/galaxy-official/src'));
    for (const forbidden of ['database.mjs', 'signed-envelope.mjs', 'signing-service.mjs', 'infrastructure', 'access.mjs', 'local-host-runtime.mjs'])
      assert.equal(inventory.includes(forbidden), false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('artifact import parser handles re-exports and rejects dynamic loading rather than missing it', () => {
  assert.deepEqual(importsOf('export { x } from "./x.mjs"; import "./y.mjs";', 'fixture.mjs'), ['./x.mjs', './y.mjs']);
  for (const source of ['import("./x.mjs")', 'require("pg")', 'eval("x")'])
    assert.throws(() => importsOf(source, 'fixture.mjs'));
});
