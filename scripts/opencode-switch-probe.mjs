import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { observed } from './opencode-switch-bridge.mjs';
import { resetGalaxyIntegration, initializeGalaxyIntegration } from '../packages/galaxy-core/src/local-store.mjs';
import { saveConnectionProfile } from '../packages/galaxy-core/src/connection-profile.mjs';

const probe = { id: 'galaxy.host.switch.probe', async tui(api) {
  const input = JSON.parse(await readFile(process.env.GALAXY_HOST_BINDING_INPUT, 'utf8'));
  const events = [], pluginId = 'galaxy.opencode.stable.tui';
  const frame = () => new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true));
  const has = name => api.keymap.getCommands().some(command => command.name === name);
  const dispatch = name => assert.equal(api.keymap.dispatchCommand(name).ok, true, name);
  const state = async () => Promise.all(input.services.map(async service => (await fetch(service.address + '/fixture/state')).json()));
  const networkCount = async () => (await state()).reduce((n, service) => n + service.requests.length, 0);
  const capture = name => events.push({ name, terminal: { width: api.renderer.width, height: api.renderer.height, text: frame() } });
  async function waitFor(check, limit = 15000) {
    const until = Date.now() + limit;
    while (Date.now() < until) { if (check()) return; await delay(50); }
    assert.ok(check(), 'Expected switch state timed out');
  }
  async function keyboard(phase, keyboard, check) {
    await writeFile(process.env.GALAXY_HOST_BINDING_PHASE, JSON.stringify({ phase, keyboard }) + '\n');
    await waitFor(check, 180000); capture(phase);
  }
  async function connection() {
    dispatch('galaxy.open'); await waitFor(() => has('galaxy.choose.6'));
    dispatch('galaxy.choose.6'); await waitFor(() => /服务信息/.test(frame()));
  }
  async function reload(name, config) {
    const before = await networkCount();
    assert.equal(await api.plugins.deactivate(pluginId), true);
    assert.equal(api.ui.dialog.open, false);
    assert.equal(api.keymap.getCommands().filter(item => item.name.startsWith('galaxy.')).length, 0);
    if (config.service !== undefined) await saveConnectionProfile(
      config.dataDirectory ?? observed.selections.at(-1).dataDirectory, input.profiles[config.service]);
    observed.selectConfiguration(config);
    assert.equal(await api.plugins.activate(pluginId), true);
    await connection(); await waitFor(() => /尚未读取|未读取/.test(frame()));
    assert.equal(await networkCount(), before); capture(name + '-fresh-discovery');
  }
  async function receipts(name, count, mismatch = false) {
    const before = await networkCount();
    dispatch('galaxy.choose.2'); await waitFor(() => observed.select?.title.startsWith('本机绑定回执\n') && /历史记录不代表当前绑定或会话有效/.test(frame()));
    assert.equal(observed.select.options.length, count); capture(name + '-receipts');
    if (mismatch) {
      dispatch('galaxy.choose.1'); await waitFor(() => /历史配置与当前不同/.test(frame())); capture(name + '-history-only');
      dispatch('galaxy.exit'); await waitFor(() => !api.ui.dialog.open); await connection();
    } else { dispatch('galaxy.zero'); await waitFor(() => /服务信息/.test(frame())); }
    assert.equal(await networkCount(), before);
  }
  async function bind(name, previous = null) {
    dispatch('galaxy.choose.1'); await waitFor(() => /服务信息已验证/.test(frame()));
    await keyboard(name + '-enter', '\r', () => /no-session/.test(frame()) && has('galaxy.choose.2'));
    dispatch('galaxy.choose.1'); await waitFor(() => /确认远程连接/.test(frame()));
    const confirmation = observed.prompt.placeholder, before = await networkCount();
    if (previous) {
      assert.notEqual(confirmation, previous);
      await keyboard(name + '-old-confirmation', previous + '\r', () => /确认文本不匹配/.test(frame()));
      assert.equal(await networkCount(), before);
      await keyboard(name + '-retry', '\r', () => /确认远程连接/.test(frame()));
    }
    await keyboard(name + '-confirm', confirmation + '\r', () => /session-local/.test(frame()));
    assert.equal(await networkCount(), before + 4); capture(name + '-bound');
    return confirmation;
  }
  async function run() {
    const report = { timestamp: new Date().toISOString(), hostVersion: api.app.version, syntheticFixture: true,
      actualInstalledPlugin: true, productionHttpsVerified: false, resetPerformedByFixture: true, events, passed: false };
    try {
      const baseline = await state();
      report.initialServiceCounts = baseline.map(service => ({ requests: service.requests.length, bindings: service.bindings.length }));
      await waitFor(() => api.plugins.list().find(item => item.id === pluginId)?.active);
      await connection(); let previous = await bind('original');
      await reload('endpoint', { service: 1 }); await receipts('endpoint', 0); previous = await bind('endpoint', previous);
      await reload('scope', { service: 0, scopes: ['binding', 'history'] }); await receipts('scope', 1, true); previous = await bind('scope', previous);
      await reload('payload', { installationId: '00000000-0000-4000-8000-000000000003' }); await receipts('payload', 2, true); previous = await bind('payload', previous);
      await reload('identity', { dataDirectory: input.secondDirectory }); await receipts('identity', 0); previous = await bind('identity', previous);
      // Explicit synthetic reset uses the existing core operation, never a user's identity.
      const oldIdentity = JSON.parse(await readFile(join(input.secondDirectory, 'galaxy-id.json'), 'utf8')).id;
      const beforeReset = await networkCount();
      await resetGalaxyIntegration(input.secondDirectory);
      await initializeGalaxyIntegration(input.secondDirectory, { source: 'synthetic-host-reinitialize' });
      const newIdentity = JSON.parse(await readFile(join(input.secondDirectory, 'galaxy-id.json'), 'utf8')).id;
      assert.notEqual(oldIdentity, newIdentity);
      dispatch('galaxy.choose.3'); await waitFor(() => /绑定、审计与数据管理/.test(frame()));
      dispatch('galaxy.choose.1'); await waitFor(() => /no-session/.test(frame())); capture('reset-invalidated-live-session');
      assert.equal(await networkCount(), beforeReset);
      await reload('reinitialized', {}); await receipts('reinitialized', 0); await bind('reinitialized', previous);
      assert.equal(await api.plugins.deactivate(pluginId), true);
      assert.equal(api.keymap.getCommands().filter(item => item.name.startsWith('galaxy.')).length, 0);
      const hashes = JSON.parse(await readFile(join(dirname(process.env.GALAXY_HOST_CHECK_REPORT), 'switch-fixture-hashes.json'), 'utf8'));
      for (const [name, expected] of Object.entries(hashes[input.firstDirectory]))
        assert.equal(createHash('sha256').update(await readFile(join(input.firstDirectory, name))).digest('hex'), expected, name);
      report.originalIdentityAndProfileUnchanged = true;
      report.reinitializedIdentityChanged = true; report.configurationSelections = observed.selections;
      report.services = await state();
      assert.deepEqual(report.services.map((service, i) => service.bindings.length - baseline[i].bindings.length), [5, 1]);
      for (const service of report.services) assert.ok(Object.values(service.counts).every(count => count === 0));
      report.requestsSinceStart = report.services.flatMap((service, i) => service.requests.slice(baseline[i].requests.length));
      assert.equal(report.requestsSinceStart.filter(row => row.method === 'POST').length, 24);
      assert.equal(report.requestsSinceStart.filter(row => row.authorizationPresent).length, 0);
      report.passed = true;
    } catch (error) { report.error = { name: error.name, message: error.message }; capture('failed'); }
    await writeFile(process.env.GALAXY_HOST_CHECK_REPORT, JSON.stringify(report, null, 2) + '\n');
    await writeFile(process.env.GALAXY_HOST_BINDING_PHASE, JSON.stringify({ phase: 'finished', passed: report.passed }) + '\n');
    api.keymap.dispatchCommand('app.exit');
  }
  const timer = setTimeout(() => void run(), 1000); api.lifecycle.onDispose(() => clearTimeout(timer));
} };
export default probe;
