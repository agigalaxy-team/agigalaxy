import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGalaxyAdapter, createGalaxyPlugin } from '../../../integrations/host-adapters/opencode-stable/galaxy.tui.ts';
import { initializeGalaxyIntegration } from '../src/local-store.mjs';
import { createConfiguredGalaxyPlugin } from '../../../integrations/host-adapters/opencode-stable/configured-galaxy.tui.ts';

function host() {
  const abort = new AbortController(), cleanups = new Set(), commands = new Map();
  let page = null, onClose;
  const api = {
    lifecycle: { signal: abort.signal, onDispose(fn) { cleanups.add(fn); return () => cleanups.delete(fn); } },
    keymap: { registerLayer({ commands: entries }) {
      for (const entry of entries) { assert.equal(commands.has(entry.name), false); commands.set(entry.name, entry); }
      return () => { for (const entry of entries) commands.delete(entry.name); };
    } },
    ui: { dialog: { clear() { onClose?.(); onClose = null; page = null; }, setSize() {},
      replace(fn, cleanup) { onClose?.(); onClose = cleanup; page = fn(); } },
      DialogSelect: props => ({ kind: 'select', ...props }), DialogAlert: props => ({ kind: 'alert', ...props }),
      DialogPrompt: props => ({ kind: 'prompt', ...props }) },
  };
  return { api, commands, cleanups, get page() { return page; },
    async open() { commands.get('galaxy.open').run(); for (let i = 0; i < 100 && !page; i++) await delay(10); assert.ok(page); },
    dispose() { abort.abort(); for (const cleanup of cleanups) cleanup(); } };
}

test('host disposal clears modal state and delayed callbacks; cached plugin can activate again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let instances = 0, disconnects = 0;
  const plugin = createGalaxyPlugin(() => {
    instances++;
    return createGalaxyAdapter({ cancel() {}, disconnect() { disconnects++; } }, { dataDirectory: directory });
  });
  const first = host();
  await plugin.tui(first.api); await first.open();
  assert.match(first.page.title, /银河/);
  assert.equal(first.page.options.find(option => option.value === '1').title, '[1] 找帮助');
  first.page.options.find(option => option.value === '1').onSelect(); // A real native selection defers its next page.
  first.dispose(); await delay(30);
  assert.equal(first.page, null); assert.equal(first.commands.size, 0); assert.equal(first.cleanups.size, 0);
  assert.equal(disconnects, 1);
  const second = host();
  await plugin.tui(second.api); await second.open();
  assert.equal(instances, 2); assert.match(second.page.title, /银河/);
  assert.equal(second.page.options.find(option => option.value === '1').title, '[1] 找帮助');
  second.dispose(); second.dispose();
  assert.equal(disconnects, 2); assert.deepEqual(await readdir(directory), []);
});

test('replacing a native dialog keeps new page keys and unloading preserves another plugin dialog', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-dialog-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const current = host();
  await createGalaxyAdapter(null, { dataDirectory: directory }).tui(current.api); await current.open();
  current.commands.get('galaxy.choose.4').run();
  current.commands.get('galaxy.choose.3').run();
  current.commands.get('galaxy.choose.1').run();
  assert.equal(current.page.kind, 'alert'); assert.equal(current.commands.has('galaxy.exit'), true);
  current.page.onConfirm(); await delay(30);
  assert.equal(current.page.kind, 'select'); assert.equal(current.commands.has('galaxy.choose.1'), true);
  assert.equal(current.commands.has('galaxy.zero'), true);
  current.commands.get('galaxy.help').run(); assert.equal(current.commands.has('galaxy.exit'), true);
  current.api.ui.dialog.replace(() => ({ kind: 'another-plugin-dialog' }));
  assert.equal(current.commands.has('galaxy.exit'), false);
  current.dispose(); assert.equal(current.page.kind, 'another-plugin-dialog');
  assert.deepEqual(await readdir(directory), []);
});

test('aborted activation never registers commands, and failed registration closes its runtime', async () => {
  let closed = 0;
  const make = () => createGalaxyAdapter(null, { discovery: { close() { closed++; } } });
  const aborted = host(); aborted.dispose();
  await make().tui(aborted.api); assert.equal(aborted.commands.size, 0); assert.equal(closed, 1);
  const broken = host(); broken.api.keymap.registerLayer = () => { throw new Error('host registration unavailable'); };
  await assert.rejects(make().tui(broken.api), /host registration unavailable/);
  assert.equal(closed, 2); assert.equal(broken.cleanups.size, 0);
});

test('native dismissal without onCancel releases a pending connection and confirmed alert transitions still work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-native-dismiss-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initializeGalaxyIntegration(directory, { source: 'synthetic-dismissal-test' });
  let busy = false, sends = 0;
  const current = host();
  const preview = { endpoint: 'https://fixture.example.org', requestJson: '{}', confirmation: 'EXACT', maximumBindingSeconds: 1, maximumSessionSeconds: 1 };
  const adapter = createGalaxyAdapter({ status: async () => ({ endpoint: preview.endpoint, state: 'no-session' }),
    prepare: async () => { assert.equal(busy, false); busy = true; return preview; },
    cancel() { busy = false; }, disconnect() {}, execute() { sends++; } }, { dataDirectory: directory });
  t.after(() => adapter.close()); await adapter.tui(current.api);
  async function openPrompt() {
    await current.open(); current.commands.get('galaxy.choose.4').run(); current.commands.get('galaxy.choose.6').run(); await delay(30);
    current.commands.get('galaxy.choose.1').run(); await delay(30); assert.equal(current.page.kind, 'select'); assert.match(current.page.title,/连接到银河/);
  }
  await openPrompt(); assert.equal(busy, true);
  current.api.ui.dialog.clear(); // OpenCode's native Esc invokes only the dialog cleanup.
  assert.equal(busy, false);
  await openPrompt(); current.commands.get('galaxy.choose.2').run();
  assert.equal(current.page.kind,'alert'); assert.equal(sends,0);
  current.page.onConfirm(); current.api.ui.dialog.clear(); await delay(30);
  assert.equal(current.page.kind, 'select'); assert.equal(busy, true);
  current.api.ui.dialog.clear(); assert.equal(busy, false); assert.equal(sends, 0);
});

test('configured plugin reloads host-selected configuration on activation and aborts a late provider', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-config-provider-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { endpoint: 'https://first.example.org', dataDirectory: directory, scopes: ['binding'],
    trustedKeys: new Map(), installationId: '00000000-0000-4000-8000-000000000001', bindingScopeId: 'fixture' };
  let calls = 0, resume;
  const plugin = createConfiguredGalaxyPlugin(async () => {
    calls++;
    if (calls === 2) await new Promise(resolve => { resume = resolve; });
    return { ...config };
  });
  const first = host(); await plugin.tui(first.api); await first.open(); first.dispose();
  config.endpoint = 'https://second.example.org';
  const pending = host(), activation = plugin.tui(pending.api);
  pending.dispose(); resume(); await activation;
  assert.equal(pending.commands.size, 0); assert.equal(pending.cleanups.size, 0);
  const final = host(); await plugin.tui(final.api); await final.open(); final.dispose();
  assert.equal(calls, 3); assert.deepEqual(await readdir(directory), []);
});
