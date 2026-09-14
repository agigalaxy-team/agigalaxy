import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getGalaxyConnectionStatus } from '../packages/galaxy-core/src/connection-profile.mjs';

const probe = { id: 'galaxy.host.initialization.probe', async tui(api) {
  const events = [], phasePath = join(dirname(process.env.GALAXY_HOST_CHECK_REPORT), 'phase.json');
  const directory = process.env.GALAXY_DATA_DIR, pluginId = 'galaxy.opencode.stable.tui';
  const frame = () => new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true));
  const has = name => api.keymap.getCommands().some(command => command.name === name);
  const dispatch = name => assert.equal(api.keymap.dispatchCommand(name).ok, true, name);
  const capture = (name, requiredVisible = []) => events.push({ name,
    terminal: { width: api.renderer.width, height: api.renderer.height, text: frame() },
    missingVisibleText: requiredVisible.filter(text => !frame().includes(text)) });
  async function waitFor(check, limit = 15000) {
    const until = Date.now() + limit;
    while (Date.now() < until) { if (check()) return; await delay(50); }
    assert.ok(check(), 'Initialization native state timed out');
  }
  async function files() {
    try { return await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function empty() { assert.deepEqual(await files(), []); }
  async function keyboard(phase, keyboard, check) {
    await writeFile(phasePath, JSON.stringify({ phase, keyboard }) + '\n');
    await waitFor(check, 180000); capture(phase);
  }
  async function stage(n) { await waitFor(() => frame().includes(`阶段 ${n} / 5`)); await delay(100); }
  async function toConfirmation(round, inspect = false) {
    dispatch('galaxy.open'); await waitFor(() => /选择语言/.test(frame()));
    await keyboard('language-' + round, '1', () => /欢迎加入银河/.test(frame()));
    await keyboard('welcome-' + round, '\r', () => frame().includes('阶段 1 / 5'));
    await keyboard('personal-' + round, '1', () => frame().includes('阶段 2 / 5')); await stage(2);
    capture('modules-' + round, ['采用 L3', '阶段 2 / 5']);
    if (inspect) {
      await keyboard('back-to-shape', '0', () => frame().includes('阶段 1 / 5'));
      await keyboard('personal-again', '1', () => frame().includes('阶段 2 / 5'));
    }
    await keyboard('privacy-' + round, '1', () => frame().includes('阶段 3 / 5')); await stage(3);
    capture('privacy-' + round, ['阅读隐私条款', '阶段 3 / 5']);
    if (inspect) {
      await keyboard('terms-open', '4', () => /Galaxy \/ 隐私条款/.test(frame()));
      await empty(); capture('terms', ['按 Enter 返回隐私选择']);
      await keyboard('terms-return', '\r', () => frame().includes('阶段 3 / 5'));
    }
    await keyboard('identity-' + round, '1', () => frame().includes('阶段 4 / 5')); await stage(4); capture('identity-' + round, ['阶段 4 / 5', '创建新的 Galaxy ID']);
    await keyboard('review-' + round, '1', () => frame().includes('阶段 5 / 5')); await stage(5);
    capture('confirmation-' + round, ['阶段 5 / 5', '请输入', '确认初始化', '仅本地', 'Galaxy ID']);
    await empty();
  }
  async function run() {
    const report = { timestamp: new Date().toISOString(), hostVersion: api.app.version,
      syntheticDirectory: true, navigationInput: 'terminal-digits', identityCreatedByNativeUi: false, events, passed: false };
    try {
      await waitFor(() => api.plugins.list().find(item => item.id === pluginId)?.active);
      await empty(); await toConfirmation(1, true);
      await keyboard('wrong-confirmation', '确认\r', () => /尚未确认初始化/.test(frame())); await empty();
      await keyboard('retry-confirmation', '\r', () => frame().includes('阶段 5 / 5'));
      await keyboard('cancel-initialization', '取消\r', () => !api.ui.dialog.open); await empty();
      await toConfirmation(2);
      await keyboard('confirm-initialization', '确认初始化\r', () => has('galaxy.choose.6'));
      const status = await getGalaxyConnectionStatus(directory);
      assert.equal(status.appliedCapabilityProfile, 'l3-foundation');
      assert.equal(status.enabledModuleIds.length, 5); assert.equal(status.state, 'not-connected');
      report.identityCreatedByNativeUi = true;
      const hashes = {};
      for (const name of await files()) hashes[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
      dispatch('galaxy.choose.6'); await waitFor(() => /L3 本地能力包已确认/.test(frame())); capture('initialized-connection', ['未连接']);
      await keyboard('return-from-connection', '\r', () => has('galaxy.choose.6'));
      dispatch('galaxy.choose.3'); await waitFor(() => /Galaxy \/ 设置/.test(frame()));
      dispatch('galaxy.zero'); await waitFor(() => has('galaxy.choose.6')); capture('settings-return');
      await keyboard('escape-console', '\u001b', () => !api.ui.dialog.open);
      assert.equal(await api.plugins.deactivate(pluginId), true);
      assert.equal(await api.plugins.activate(pluginId), true);
      dispatch('galaxy.open'); await waitFor(() => has('galaxy.choose.6')); capture('reactivated-console');
      assert.equal(await api.plugins.deactivate(pluginId), true);
      for (const [name, expected] of Object.entries(hashes))
        assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), expected, name);
      report.savedFileCount = Object.keys(hashes).length; report.postInitializationFilesUnchanged = true;
      report.enabledModuleIds = status.enabledModuleIds; report.connectionState = status.state;
      report.layoutFindings = events.filter(event => event.missingVisibleText.length).map(event => ({ name: event.name, missing: event.missingVisibleText }));
      report.passed = true;
    } catch (error) { report.error = { name: error.name, message: error.message }; capture('failed'); }
    await writeFile(process.env.GALAXY_HOST_CHECK_REPORT, JSON.stringify(report, null, 2) + '\n');
    await writeFile(phasePath, JSON.stringify({ phase: 'finished', passed: report.passed }) + '\n');
    api.keymap.dispatchCommand('app.exit');
  }
  const timer = setTimeout(() => void run(), 1000); api.lifecycle.onDispose(() => clearTimeout(timer));
} };
export default probe;
