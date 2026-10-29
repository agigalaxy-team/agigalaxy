import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserToolOutput, chromium } from '../scripts/browser-tool-runtime.mjs';

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

