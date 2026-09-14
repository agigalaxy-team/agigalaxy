// Executed by the installed OpenCode TUI, against its actual plugin APIs.
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const probe = { id: 'galaxy.host.lifecycle.probe', async tui(api) {
  const events = [];
  const pluginId = 'galaxy.opencode.stable.tui';
  const scenario = process.env.GALAXY_HOST_CHECK_SCENARIO ?? 'uninitialized';
  const frame = () => new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true));
  const has = name => api.keymap.getCommands().some(item => item.name === name);
  const state = () => api.plugins.list().find(item => item.id === pluginId);
  const snapshot = name => events.push({ name, plugin: state() ? { enabled: state().enabled, active: state().active } : null,
    dialog: { open: api.ui.dialog.open, depth: api.ui.dialog.depth },
    galaxyCommands: api.keymap.getCommands().filter(item => item.name.startsWith('galaxy.')).map(item => item.name),
    terminal: { width: api.renderer.width, height: api.renderer.height,
      text: frame() } });
  const dispatch = name => assert.equal(api.keymap.dispatchCommand(name).ok, true, name);
  async function waitFor(check) {
    for (let i = 0; i < 100; i++) { if (check()) return; await delay(50); }
    assert.ok(check(), 'OpenCode state did not reach the expected condition');
  }
  async function run() {
    const report = { timestamp: new Date().toISOString(), version: api.app.version, runtime: process.versions,
      realOpenCodeProcess: true, scenario, syntheticFixture: !['uninitialized', 'recovery'].includes(scenario),
      identityCreatedByUi: false, visualAcceptance: false, events, passed: false };
    try {
      await waitFor(() => state()?.active); snapshot('loaded');
      dispatch('galaxy.open'); await waitFor(() => has('galaxy.exit'));
      await delay(500); snapshot('opened');
      if (scenario === 'uninitialized') {
        assert.match(frame(), /Galaxy \/ 选择语言/);
        dispatch('galaxy.choose.1'); await delay(300); snapshot('welcome');
        assert.match(frame(), /欢迎加入银河/); assert.ok(has('galaxy.exit'));
      } else if (scenario === 'recovery') {
        assert.match(frame(), /本地恢复/); assert.equal(has('galaxy.choose.1'), false);
      } else {
        assert.ok(has('galaxy.choose.6')); assert.equal(has('galaxy.choose.5'), false);
        dispatch('galaxy.choose.6');
        await waitFor(() => /接入银河|服务信息|连接配置无法读取/.test(frame()));
        await delay(200); snapshot('connection');
        if (scenario === 'invalid-connection') assert.match(frame(), /连接配置无法读取/);
        else if (scenario === 'offline') {
          assert.match(frame(), /尚未读取|未读取/);
          dispatch('galaxy.choose.1'); await waitFor(() => /服务信息读取失败/.test(frame())); snapshot('offline-failure');
        } else {
          assert.match(frame(), /未连接/);
          assert.match(frame(), scenario === 'legacy' ? /L3 尚未应用/ : /L3 本地能力包已确认/);
        }
        dispatch('galaxy.exit'); await waitFor(() => !api.ui.dialog.open);
        dispatch('galaxy.open'); await waitFor(() => has('galaxy.choose.6'));
        dispatch('galaxy.choose.3'); await waitFor(() => /Galaxy \/ 设置/.test(frame())); snapshot('settings');
        dispatch('galaxy.zero'); await waitFor(() => has('galaxy.choose.6')); snapshot('settings-back');
        dispatch('galaxy.choose.1'); await waitFor(() => /工作中的 Case/.test(frame())); snapshot('local-case-available');
      }
      dispatch('galaxy.exit'); await waitFor(() => !api.ui.dialog.open); snapshot('escaped');
      dispatch('galaxy.open'); await waitFor(() => api.ui.dialog.open);
      assert.equal(await api.plugins.deactivate(pluginId), true); await delay(100); snapshot('deactivated');
      assert.equal(api.ui.dialog.open, false);
      assert.equal(events.at(-1).galaxyCommands.length, 0);
      assert.equal(await api.plugins.activate(pluginId), true); await waitFor(() => state()?.active);
      dispatch('galaxy.open'); await waitFor(() => api.ui.dialog.open); await delay(500); snapshot('reactivated-and-opened');
      dispatch('galaxy.exit'); await waitFor(() => !api.ui.dialog.open);
      assert.equal(await api.plugins.deactivate(pluginId), true); snapshot('final-deactivated');
      assert.equal(events.at(-1).galaxyCommands.length, 0);
      const before = JSON.parse(await readFile(process.env.GALAXY_HOST_CHECK_FIXTURES, 'utf8'));
      let names;
      try { names = await readdir(process.env.GALAXY_DATA_DIR); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
      const after = {};
      for (const name of names) after[name] = createHash('sha256').update(await readFile(join(process.env.GALAXY_DATA_DIR, name))).digest('hex');
      assert.deepEqual(after, before); report.localFilesUnchanged = true; report.localFileCount = names.length;
      report.passed = true;
    } catch (error) { report.error = { name: error.name, message: error.message }; }
    await writeFile(process.env.GALAXY_HOST_CHECK_REPORT, JSON.stringify(report, null, 2) + '\n');
    api.keymap.dispatchCommand('app.exit');
  }
  const timer = setTimeout(() => void run(), 1000);
  api.lifecycle.onDispose(() => clearTimeout(timer));
} };
export default probe;
