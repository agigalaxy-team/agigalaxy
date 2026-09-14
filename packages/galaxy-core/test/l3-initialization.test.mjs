import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import { getGalaxyConnectionStatus } from '../src/connection-profile.mjs';
import { getGalaxyInitializationContract, renderGalaxyNumberedList, resolveGalaxyInitialization } from '../src/integration-modules.mjs';
import { initializeGalaxyIntegration, getGalaxyCommandSurface } from '../src/local-store.mjs';

test('L3 contract and read-only connect preserve legacy initialization without upgrade', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'galaxy-l3-legacy-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const empty = await getGalaxyCommandSurface(dir, 'connect');
  assert.equal(empty.route, 'galaxy-connection');
  assert.equal(empty.connectionContract.appliedCapabilityProfile, null);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(resolveGalaxyInitialization().capabilityProfile, 'l3-foundation');
  for (const language of ['zh-CN', 'en-US']) {
    const contract = getGalaxyInitializationContract({ language, stage: 2 });
    assert.equal(contract.currentStage.capabilityProfile, 'l3-foundation');
    assert.equal(contract.currentStage.defaultSelected, true);
    assert.match(renderGalaxyNumberedList(contract), /L3/);
    assert.equal(contract.stages[2].id, 'connection-visibility');
  }
  await initializeGalaxyIntegration(dir, { profile: 'coding-case', source: 'test' });
  const before = await readFile(join(dir, 'galaxy-local-state.json'), 'utf8');
  const status = await getGalaxyConnectionStatus(dir);
  assert.equal(status.appliedCapabilityProfile, null);
  assert.equal(status.selectionState, 'not-applied');
  assert.equal(await readFile(join(dir, 'galaxy-local-state.json'), 'utf8'), before);
});

test('recovery is displayed by command, CLI and native alert without opening initialization', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-recovery-ui-'));
  const prior = process.env.GALAXY_DATA_DIR;
  process.env.GALAXY_DATA_DIR = directory;
  context.after(async () => {
    if (prior === undefined) delete process.env.GALAXY_DATA_DIR; else process.env.GALAXY_DATA_DIR = prior;
    await rm(directory, { recursive: true, force: true });
  });
  const marker = '{"version":1,"operation":"reset"}';
  await writeFile(join(directory, '.galaxy-reset.json'), marker);
  assert.equal((await getGalaxyCommandSurface(directory)).state, 'recovery-required');
  assert.equal((await getGalaxyConnectionStatus(directory)).recoveryRequired, true);
  const cli = fileURLToPath(new URL('../../galaxy-node/src/cli.mjs', import.meta.url));
  for (const command of ['status', 'export']) {
    const result = JSON.parse(execFileSync(process.execPath, [cli, command, '--data-dir', directory], { encoding: 'utf8', windowsHide: true }));
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.identity, null);
  }
  const { default: adapter } = await tsImport('../../../integrations/host-adapters/opencode-stable/galaxy.tui.ts', import.meta.url);
  let page;
  let open;
  await adapter.tui({
    keymap: { registerLayer: ({ commands }) => { const entry = commands.find(c => c.name === 'galaxy.open'); if (entry) open = entry.run; return () => {}; } },
    ui: { dialog: { setSize() {}, clear() { page = null; }, replace(factory) { page = factory(); } },
      DialogAlert: props => ({ type: 'alert', ...props }),
      DialogSelect: () => { throw new Error('Recovery must not open initialization'); } },
  });
  open();
  for (let i = 0; i < 100 && !page; i++) await delay(10);
  assert.equal(page.type, 'alert');
  assert.match(page.message, /不会创建新身份/);
  assert.deepEqual(await readdir(directory), ['.galaxy-reset.json']);
  assert.equal(await readFile(join(directory, '.galaxy-reset.json'), 'utf8'), marker);
});

test('native adapter navigation, literal confirmation and independent connection page', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'galaxy-l3-adapter-'));
  const prior = process.env.GALAXY_DATA_DIR;
  process.env.GALAXY_DATA_DIR = dir;
  context.after(async () => {
    if (prior === undefined) delete process.env.GALAXY_DATA_DIR;
    else process.env.GALAXY_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  });
  context.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  const { default: adapter } = await tsImport('../../../integrations/host-adapters/opencode-stable/galaxy.tui.ts', import.meta.url);
  let page = null;
  let open;
  const api = {
    keymap: { registerLayer: ({ commands }) => {
      const command = commands.find((item) => item.name === 'galaxy.open');
      if (command) open = command.run;
      return () => {};
    } },
    ui: {
      dialog: { setSize() {}, clear() { page = null; }, replace(factory) { page = factory(); } },
      DialogSelect: (props) => ({ type: 'select', ...props }),
      DialogAlert: (props) => ({ type: 'alert', ...props }),
      DialogPrompt: (props) => ({ type: 'prompt', ...props }),
    },
  };
  async function transition(action) {
    const previous = page;
    await action();
    for (let attempt = 0; attempt < 100 && page === previous; attempt++) await delay(10);
    assert.notEqual(page, previous, 'navigation must complete');
  }
  function choose(number) {
    return transition(() => page.options.find((item) => item.value === number).onSelect());
  }
  async function toConfirmation() {
    await transition(() => open());
    await choose('1'); // language -> welcome
    await transition(() => page.onConfirm());
    assert.equal(page.options.find((item) => item.value === '2').disabled, true);
    await choose('1'); // Personal -> L3
    assert.match(page.title, /L3/);
    await choose('0'); // back to shape
    await choose('1');
    await choose('1'); // visibility
    assert.match(page.title, /接入与可见性/);
    await choose('4'); // terms are read-only and return
    await transition(() => page.onConfirm());
    await choose('1'); // identity
    await choose('1'); // literal confirmation
    assert.equal(page.type, 'prompt');
    assert.match(page.title, /L3/);
    assert.match(page.title, /未连接/);
  }
  await adapter.tui(api);
  await toConfirmation();
  assert.deepEqual(await readdir(dir), []);
  await transition(() => page.onConfirm('确认'));
  assert.deepEqual(await readdir(dir), []);
  await transition(() => page.onConfirm());
  await transition(() => page.onConfirm('取消'));
  assert.equal(page, null);
  assert.deepEqual(await readdir(dir), []);
  await toConfirmation();
  await transition(() => page.onConfirm('确认初始化'));
  const status = await getGalaxyConnectionStatus(dir);
  assert.equal(status.appliedCapabilityProfile, 'l3-foundation');
  assert.equal(status.enabledModuleIds.length, 5);
  assert.equal(status.state, 'not-connected');
  const state = JSON.parse(await readFile(join(dir, 'galaxy-local-state.json'), 'utf8'));
  assert.deepEqual(state.integration.enabledModuleSnapshot, status.enabledModuleIds);
  const before = await readFile(join(dir, 'galaxy-local-state.json'), 'utf8');
  await choose('6');
  assert.match(page.title, /接入银河/);
  assert.match(page.message, /未连接/);
  await transition(() => page.onConfirm());
  assert.equal(page.type, 'select');
  assert.equal(await readFile(join(dir, 'galaxy-local-state.json'), 'utf8'), before);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
