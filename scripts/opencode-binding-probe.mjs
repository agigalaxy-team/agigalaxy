import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const probe = { id: 'galaxy.host.binding.probe', async tui(api) {
  const { observed } = await import(process.env.GALAXY_HOST_BINDING_BRIDGE);
  const input = JSON.parse(await readFile(process.env.GALAXY_HOST_BINDING_INPUT, 'utf8'));
  const events = [], pluginId = 'galaxy.opencode.stable.tui';
  const frame = () => new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true));
  const has = name => api.keymap.getCommands().some(command => command.name === name);
  const dispatch = name => assert.equal(api.keymap.dispatchCommand(name).ok, true, name);
  const state = async () => (await fetch(input.address + '/fixture/state')).json();
  const control = async path => { const response = await fetch(input.address + '/fixture/' + path); assert.equal(response.ok, true); return response.json(); };
  async function waitFor(check, limit = 15000) {
    const until = Date.now() + limit;
    while (Date.now() < until) { if (check()) return; await delay(50); }
    assert.ok(check(), 'Expected native state timed out');
  }
  const capture = name => events.push({ name, terminal: { width: api.renderer.width, height: api.renderer.height, text: frame() },
    galaxyCommands: api.keymap.getCommands().filter(command => command.name.startsWith('galaxy.')).map(command => command.name) });
  async function keyboard(phase, value, check) {
    await writeFile(process.env.GALAXY_HOST_BINDING_PHASE, JSON.stringify({ phase, keyboard: value }) + '\n');
    await waitFor(check, 180000); capture(phase + '-completed');
  }
  async function root() { dispatch('galaxy.open'); await waitFor(() => has('galaxy.choose.6')); }
  async function connection() { await root(); dispatch('galaxy.choose.6'); await waitFor(() => /接入银河|服务信息/.test(frame())); }
  async function exit() { dispatch('galaxy.exit'); await waitFor(() => !api.ui.dialog.open); }
  async function run() {
    const report = { timestamp: new Date().toISOString(), hostVersion: api.app.version, events,
      actualInstalledPlugin: true, syntheticFixture: true, transport: 'explicit-private-loopback-http', productionHttpsVerified: false, passed: false };
    try {
      await waitFor(() => api.plugins.list().find(item => item.id === pluginId)?.active);
      await connection(); capture('configured-target');
      dispatch('galaxy.choose.1'); await waitFor(() => /服务信息已验证/.test(frame())); capture('verified-manifest');
      let service = await state(); assert.equal(service.bindings.length, 0);
      assert.ok(service.requests.every(row => row.method === 'GET' && !row.authorizationPresent));
      await keyboard('enter-service-information', '\r', () => has('galaxy.choose.2') && /no-session/.test(frame()));
      dispatch('galaxy.choose.1'); await waitFor(() => /确认远程连接/.test(frame()));
      await keyboard('cancel-preview', '\u001b', () => !api.ui.dialog.open);
      service = await state(); assert.equal(service.bindings.length, 0); assert.ok(service.requests.every(row => row.method === 'GET'));
      await connection(); dispatch('galaxy.choose.1'); await waitFor(() => /确认远程连接/.test(frame()));
      await keyboard('wrong-confirmation', 'wrong\r', () => /确认文本不匹配/.test(frame()));
      service = await state(); assert.equal(service.bindings.length, 0); assert.ok(service.requests.every(row => row.method === 'GET'));
      await keyboard('retry-confirmation', '\r', () => /确认远程连接/.test(frame()));
      assert.ok(observed.prompt?.placeholder);
      await keyboard('exact-confirmation', observed.prompt.placeholder + '\r', () => /session-local/.test(frame()));
      service = await state(); assert.equal(service.bindings.length, 1);
      assert.deepEqual(service.requests.filter(row => row.method === 'POST').map(row => row.path),
        ['/v1/binding-challenges', '/v1/bindings', '/v1/session-challenges', '/v1/sessions']);
      assert.ok(Object.values(service.counts).every(count => count === 0)); capture('bound-and-session-active');
      dispatch('galaxy.choose.3'); await waitFor(() => /绑定、审计与数据管理/.test(frame()));
      dispatch('galaxy.choose.1'); await waitFor(() => /binding-verified/.test(frame())); capture('binding-checked');
      await keyboard('return-after-binding-check', '\r', () => has('galaxy.choose.2') && /接入银河/.test(frame()));
      await control('revoke');
      dispatch('galaxy.choose.3'); await waitFor(() => /绑定、审计与数据管理/.test(frame()));
      dispatch('galaxy.choose.1'); await waitFor(() => /remote-rejected/.test(frame())); capture('revocation-blocked-access');
      await exit(); await root(); dispatch('galaxy.choose.1'); await waitFor(() => /Case 的创建/.test(frame())); capture('local-case-after-revocation');
      await exit(); await connection(); dispatch('galaxy.choose.2'); await waitFor(() => /服务信息/.test(frame()));
      await control('bad-manifest'); dispatch('galaxy.choose.1'); await waitFor(() => /服务信息未通过验证/.test(frame())); capture('bad-manifest-rejected');
      await exit(); await control('valid-manifest'); observed.advanceTime(1000);
      await connection(); dispatch('galaxy.choose.1'); await waitFor(() => /服务信息已过期/.test(frame())); capture('expired-manifest-rejected');
      await exit(); assert.equal(await api.plugins.deactivate(pluginId), true);
      assert.equal(api.keymap.getCommands().filter(command => command.name.startsWith('galaxy.')).length, 0);
      const before = JSON.parse(await readFile(process.env.GALAXY_HOST_CHECK_FIXTURES, 'utf8'));
      for (const [name, expected] of Object.entries(before))
        assert.equal(createHash('sha256').update(await readFile(join(process.env.GALAXY_DATA_DIR, name))).digest('hex'), expected, name);
      report.initialFilesUnchanged = true;
      report.addedLocalFiles = (await readdir(process.env.GALAXY_DATA_DIR)).filter(name => !Object.hasOwn(before, name));
      report.service = await state(); assert.equal(report.service.bindings.length, 1); assert.ok(report.service.bindings[0].revoked_at);
      assert.ok(Object.values(report.service.counts).every(count => count === 0)); report.passed = true;
    } catch (error) { report.error = { name: error.name, message: error.message }; capture('failed'); }
    await writeFile(process.env.GALAXY_HOST_CHECK_REPORT, JSON.stringify(report, null, 2) + '\n');
    await writeFile(process.env.GALAXY_HOST_BINDING_PHASE, JSON.stringify({ phase: 'finished', passed: report.passed }) + '\n');
    api.keymap.dispatchCommand('app.exit');
  }
  const timer = setTimeout(() => void run(), 1000); api.lifecycle.onDispose(() => clearTimeout(timer));
} };
export default probe;
