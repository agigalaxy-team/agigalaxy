import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('combined runner includes Official failures and rejects an empty suite', async () => {
  const prefix = join(tmpdir(), 'galaxy-check-runner-');
  const root = await mkdtemp(prefix);
  try {
    for (const path of ['scripts/test', 'packages/galaxy-core/test', 'packages/galaxy-official/test', 'packages/galaxy-a2a/test']) {
      await mkdir(join(root, path), { recursive: true });
    }
    await copyFile(new URL('../check.mjs', import.meta.url), join(root, 'scripts/check.mjs'));
    await writeFile(join(root, 'packages/galaxy-core/test/pass.test.mjs'), "import test from 'node:test'; test('core passes', () => {});\n");
    await writeFile(join(root, 'packages/galaxy-a2a/test/pass.test.mjs'), "import test from 'node:test'; test('a2a passes', () => {});\n");
    const failure = join(root, 'packages/galaxy-official/test/fail.test.mjs');
    await writeFile(failure, "import test from 'node:test'; test('official fails', () => { throw Error('fixture failure'); });\n");
    const run = mode => spawnSync(process.execPath, ['scripts/check.mjs', mode], { cwd: root, encoding: 'utf8', timeout: 15000 });
    assert.equal(run('core').status, 0);
    const failed = run('test');
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /official fails/);
    assert.match(failed.stdout, /a2a passes/);
    assert.equal(run('a2a').status, 0);
    await rm(failure);
    assert.notEqual(run('official').status, 0);
    assert.equal(run('unknown').status, 2);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(prefix)));
    await rm(root, { recursive: true, force: true });
  }
});
