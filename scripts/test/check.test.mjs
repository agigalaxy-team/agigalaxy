import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('combined runner includes service and client failures and rejects an empty suite', async () => {
  const prefix = join(tmpdir(), 'galaxy-check-runner-');
  const root = await mkdtemp(prefix);
  try {
    for (const path of ['scripts/test', 'scripts/checks', 'packages/galaxy-core/test', 'packages/galaxy-official/test', 'packages/galaxy-a2a/test', 'packages/galaxy-web/test', 'packages/galaxy-edge-mcp/test']) {
      await mkdir(join(root, path), { recursive: true });
    }
    await copyFile(new URL('../check.mjs', import.meta.url), join(root, 'scripts/check.mjs'));
    for (const name of ['runner.mjs', 'test-discovery.mjs'])
      await copyFile(new URL('../checks/' + name, import.meta.url), join(root, 'scripts/checks', name));
    await writeFile(join(root, 'packages/galaxy-core/test/pass.test.mjs'), "import test from 'node:test'; test('core passes', () => {});\n");
    await writeFile(join(root, 'packages/galaxy-a2a/test/pass.test.mjs'), "import test from 'node:test'; test('a2a passes', () => {});\n");
    for (const name of ['galaxy-web', 'galaxy-edge-mcp']) {
      await writeFile(join(root, `packages/${name}/test/pass.test.mjs`), `import test from 'node:test'; test('${name} passes', () => {});\n`);
    }
    const failure = join(root, 'packages/galaxy-official/test/fail.test.mjs');
    await writeFile(failure, "import test from 'node:test'; test('official fails', () => { throw Error('fixture failure'); });\n");
    const run = (mode, selected = {}) => {
      const env = { ...process.env };
      for (const key of ['GALAXY_TEST_CHAT_ISOLATED', 'GALAXY_NATIVE_TEST_SOURCE', 'GALAXY_NATIVE_TEST_CANDIDATE']) delete env[key];
      return spawnSync(process.execPath, ['scripts/check.mjs', mode], { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...env, ...selected } });
    };
    assert.equal(run('core').status, 0);
    const failed = run('test');
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /official fails/);
    assert.match(failed.stdout, /a2a passes/);
    assert.equal(run('a2a').status, 0);
    await writeFile(failure, "import test from 'node:test'; test('official passes', () => {});\n");
    for (const name of ['galaxy-web', 'galaxy-edge-mcp']) {
      const clientFailure = join(root, `packages/${name}/test/fail.test.mjs`);
      await writeFile(clientFailure, `import test from 'node:test'; test('${name} failure is included', () => { throw Error('deliberate client failure'); });\n`);
      const result = run('test');
      assert.equal(result.status, 1); assert.ok(result.stdout.includes(`${name} failure is included`));
      await rm(clientFailure);
    }
    await writeFile(join(root, 'scripts/test/native-candidate-case-receipts.test.mjs'), "import test from 'node:test'; test('selected artifact acceptance ran', () => { throw Error('deliberate artifact failure'); });\n");
    await writeFile(join(root, 'packages/galaxy-official/test/chat-shared-summary-prosody.test.mjs'), "import test from 'node:test'; test('selected Prosody acceptance ran', () => { throw Error('deliberate transport failure'); });\n");
    const ordinary = run('test');
    assert.equal(ordinary.status, 0);
    assert.match(ordinary.stdout, /separate environment\/artifact acceptance \(not executed by this run\)/);
    const candidate = run('test', { GALAXY_NATIVE_TEST_SOURCE: root, GALAXY_NATIVE_TEST_CANDIDATE: root });
    assert.equal(candidate.status, 1); assert.match(candidate.stdout, /selected artifact acceptance ran/);
    const prosody = run('official', { GALAXY_TEST_CHAT_ISOLATED: '1' });
    assert.equal(prosody.status, 1); assert.match(prosody.stdout, /selected Prosody acceptance ran/);
    const incomplete = run('test', { GALAXY_NATIVE_TEST_CANDIDATE: root });
    assert.notEqual(incomplete.status, 0); assert.match(incomplete.stderr, /requires both/);
    await rm(failure);
    assert.notEqual(run('official').status, 0);
    assert.equal(run('unknown').status, 2);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(prefix)));
    await rm(root, { recursive: true, force: true });
  }
});
