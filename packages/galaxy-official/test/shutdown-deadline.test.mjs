import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createShutdownDeadline } from "../src/infrastructure/shutdown-deadline.mjs";

test('shutdown forces an incomplete child process to fail; repeated stop does not renew its budget', () => {
  const moduleUrl = new URL("../src/infrastructure/shutdown-deadline.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { createShutdownDeadline } from ${JSON.stringify(moduleUrl)};
    const deadline = createShutdownDeadline({ timeoutMs: 80 });
    deadline.start();
    setInterval(() => deadline.start(), 10);
    await new Promise(() => {});
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout + result.stderr, '');
});

test('completed shutdown clears the deadline and permits clean process exit', () => {
  const moduleUrl = new URL("../src/infrastructure/shutdown-deadline.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { createShutdownDeadline } from ${JSON.stringify(moduleUrl)};
    const deadline = createShutdownDeadline({ timeoutMs: 80 });
    deadline.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    deadline.finish(); deadline.start();
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

test('invalid shutdown bounds are rejected', () => {
  for (const timeoutMs of [0, -1, Infinity, 60001, 1.5]) assert.throws(() => createShutdownDeadline({ timeoutMs }));
});
