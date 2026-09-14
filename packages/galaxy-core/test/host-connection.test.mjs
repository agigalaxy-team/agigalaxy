import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import { initializeGalaxyIntegration } from '../src/local-store.mjs';

test('injected native connection page requires literal confirmation and ignores completion after Escape', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'galaxy-host-connect-'));
  const prior = process.env.GALAXY_DATA_DIR; process.env.GALAXY_DATA_DIR = dir;
  t.after(async () => {
    if (prior === undefined) delete process.env.GALAXY_DATA_DIR; else process.env.GALAXY_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  });
  await initializeGalaxyIntegration(dir, { profile: 'coding-case', source: 'test' });
  const { createGalaxyAdapter } = await tsImport('../../../integrations/host-adapters/opencode-stable/galaxy.tui.ts', import.meta.url);
  let page = null, executes = 0, cancels = 0, complete, checks = 0, finishCheck;
  const commands = new Map();
  const preview = Object.freeze({ endpoint: 'https://official.example.org', requestJson: '{"scopes":["binding"]}',
    maximumBindingSeconds: 86400, maximumSessionSeconds: 600, confirmation: 'CONFIRM CONNECTION fixture' });
  const controller = { status: async () => ({ endpoint: preview.endpoint, state: 'no-session' }),
    checkRemote: async () => { checks++; return new Promise(resolve => { finishCheck = resolve; }); },
    prepare: async () => preview, cancel: () => { cancels++; }, disconnect() {},
    execute: async (value, text) => {
      assert.equal(value, preview); assert.equal(text, preview.confirmation); executes++;
      return new Promise(resolve => { complete = resolve; });
    } };
  await createGalaxyAdapter(controller).tui({
    keymap: { registerLayer({ commands: layer }) {
      for (const item of layer) commands.set(item.name, item.run);
      return () => {};
    } }, ui: { dialog: { clear() { page = null; }, setSize() {}, replace(factory) { page = factory(); } },
      DialogSelect: props => ({ type: 'select', ...props }), DialogAlert: props => ({ type: 'alert', ...props }),
      DialogPrompt: props => ({ type: 'prompt', ...props }) } });
  async function transition(action) {
    const before = page; action();
    for (let i = 0; i < 100 && page === before; i++) await delay(10);
    assert.notEqual(page, before);
  }
  const choose = number => transition(() => page.options.find(item => item.value === number).onSelect());
  await transition(() => commands.get('galaxy.open')());
  await choose('6');
  assert.match(page.title, /no-session/);
  await choose('1');
  assert.equal(page.type, 'prompt'); assert.ok(page.title.includes(preview.requestJson));
  await transition(() => page.onConfirm('CONFIRM'));
  assert.equal(executes, 0);
  await transition(() => page.onConfirm());
  await transition(() => page.onConfirm(preview.confirmation));
  assert.equal(executes, 1);
  commands.get('galaxy.exit')();
  assert.equal(page, null); assert.ok(cancels > 0);
  complete({ state: 'session-local' });
  await delay(30);
  assert.equal(page, null);
  await transition(() => commands.get('galaxy.open')());
  await choose('6'); assert.equal(checks, 0);
  await choose('3'); assert.equal(checks, 1);
  commands.get('galaxy.exit')(); assert.equal(page, null);
  finishCheck({ endpoint: preview.endpoint, state: 'binding-verified' });
  await delay(30); assert.equal(page, null);
});
