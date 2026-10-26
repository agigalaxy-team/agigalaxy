import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserSourceUrl, browserToolOutput, chromium, requiredToolInput, loadToolMcpClient } from '../scripts/browser-tool-runtime.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

test('browser tool output is source-relative and variants retain separate results', () => {
  const tool = new URL('../scripts/verify-public-ui.mjs', import.meta.url);
  assert.equal(browserToolOutput(tool), resolve(repository, 'outputs/verify-public-ui/tmp'));
  assert.equal(browserToolOutput(tool, undefined, 'mobile'), resolve(repository, 'outputs/verify-public-ui/tmp/mobile'));
  assert.equal(browserToolOutput(tool, 'outputs/custom'), resolve(repository, 'outputs/custom'));
  assert.throws(() => browserToolOutput(tool, undefined, '../escape'), /variant/);
});

test('headful, personal-profile and external browser attachment options are rejected before launch', () => {
  for (const options of [{ headless: false }, { channel: 'chrome' }, { executablePath: '/personal/browser' },
    { args: ['--user-data-dir=/personal/profile'] }, { args: ['--remote-debugging-port=9222'] }]) {
    assert.throws(() => chromium.launch(options), /isolated managed headless/);
  }
  assert.equal(chromium.connectOverCDP, undefined);
  assert.equal(chromium.launchPersistentContext, undefined);
});

test('prepared external input is explicit and never falls back to old project evidence', () => {
  const key = 'GALAXY_BROWSER_TOOL_TEST_INPUT';
  const previous = process.env[key];
  try {
    delete process.env[key];
    assert.throws(() => requiredToolInput(key), /absolute path/);
    process.env[key] = 'relative/path';
    assert.throws(() => requiredToolInput(key), /absolute path/);
    process.env[key] = repository;
    assert.equal(requiredToolInput(key), repository);
    assert.throws(() => requiredToolInput(key, 'file'), /existing file/);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('Vite source URL follows the actual checkout instead of an author machine', () => {
  assert.equal(browserSourceUrl('packages/galaxy-core/src/domain/device-key-store.mjs'),
    '/app/@fs/' + resolve(repository, 'packages/galaxy-core/src/domain/device-key-store.mjs').replaceAll('\\', '/'));
});

test('Native browser tools resolve their client from the declared test dependency, independent of candidate contents', async () => {
  const { Client, InMemoryTransport } = await loadToolMcpClient();
  assert.equal(typeof Client, 'function');
  const pair = InMemoryTransport.createLinkedPair();
  assert.equal(pair.length, 2);
  await Promise.all(pair.map(transport => transport.close()));
});
