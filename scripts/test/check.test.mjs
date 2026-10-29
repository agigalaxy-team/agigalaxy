import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('JS discovery runs current contracts and UI tests, preserves failures and excludes retired service/core tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galaxy-check-runner-'));
  try {
    for (const path of ['scripts/test', 'scripts/checks', 'packages/galaxy-contracts/test', 'packages/galaxy-a2a/test',
      'packages/galaxy-web/test', 'packages/galaxy-client/test', 'packages/galaxy-edge-mcp/test', 'packages/galaxy-core/test', 'packages/galaxy-official/test'])
      await mkdir(join(root, path), { recursive: true });
    await mkdir(join(root, 'node_modules'));
    await symlink(resolve(fileURLToPath(import.meta.resolve('tsx/package.json')), '..'), join(root, 'node_modules/tsx'), process.platform === 'win32' ? 'junction' : 'dir');
    await copyFile(new URL('../check.mjs', import.meta.url), join(root, 'scripts/check.mjs'));
    for (const name of ['runner.mjs', 'test-discovery.mjs'])
      await copyFile(new URL('../checks/' + name, import.meta.url), join(root, 'scripts/checks', name));
    for (const name of ['galaxy-contracts', 'galaxy-client', 'galaxy-a2a', 'galaxy-web'])
      await writeFile(join(root, `packages/${name}/test/pass.test.mjs`), `import test from 'node:test'; test('${name} passes', () => {});\n`);
    for (const name of ['galaxy-core', 'galaxy-official', 'galaxy-edge-mcp'])
      await writeFile(join(root, `packages/${name}/test/retired.test.mjs`), "import test from 'node:test'; test('retired source must not run', () => { throw Error('retired'); });\n");
    const run = (mode, files = [], selected = {}) => {
      const env = { ...process.env };
      delete env.GALAXY_TEST_CHAT_ISOLATED;
      return spawnSync(process.execPath, ['scripts/check.mjs', mode, ...files], { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...env, ...selected } });
    };
    const ordinary = run('test');
    assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
    for (const name of ['galaxy-contracts', 'galaxy-client', 'galaxy-a2a', 'galaxy-web']) assert.match(ordinary.stdout, new RegExp(name + ' passes'));
    assert.doesNotMatch(ordinary.stdout, /retired source must not run/);
    const path = 'packages/galaxy-contracts/test/pass.test.mjs';
    const selected = run('test', [path, path]);
    assert.equal(selected.status, 0); assert.match(selected.stdout, /1 files/);
    for (const files of [['--unknown'], ['scripts/check.mjs'], ['../outside.test.mjs'], ['scripts/test/missing.test.mjs'],
      ['packages/galaxy-core/test/retired.test.mjs'], ['packages/galaxy-official/test/retired.test.mjs']])
      assert.equal(run('test', files).status, 2);
    assert.equal(run('core', [path]).status, 2);
    assert.equal(run('official', [path]).status, 2);
    assert.equal(run('a2a', [path]).status, 2);
    assert.equal(run('lint', [path]).status, 2);
    const failure = join(root, 'packages/galaxy-a2a/test/fail.test.mjs');
    await writeFile(failure, "import test from 'node:test'; test('current adapter failure', () => { throw Error('fixture failure'); });\n");
    const failed = run('test');
    assert.equal(failed.status, 1); assert.match(failed.stdout, /current adapter failure/);
    await rm(failure);
    await rm(join(root, 'packages/galaxy-a2a/test/pass.test.mjs'));
    assert.notEqual(run('a2a').status, 0);
    assert.equal(run('unknown').status, 2);
  } finally {
    const child = relative(tmpdir(), root);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  }
});
