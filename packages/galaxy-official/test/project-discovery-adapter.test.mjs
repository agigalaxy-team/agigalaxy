import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createGalaxyAdapter } from '../../../integrations/host-adapters/opencode-stable/galaxy.tui.ts';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { createConnectionProfile, saveConnectionProfile } from '../../galaxy-core/src/connection-profile.mjs';
import { createLocalHostRuntime } from '../src/local-host-runtime.mjs';
import { createApi } from '../src/http.mjs';
import { serviceFixture } from './service-fixture.mjs';

test('native Dialog and keymap route edits projects, signs publication, displays live opportunities and saves temporary wishes over real HTTP', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-project-discovery-ui-'));
  const scopes = ['binding', 'consent', 'history', 'notifications'], now = Math.floor(Date.now() / 1000);
  const f = await serviceFixture(scopes, null, { now }), endpoint = f.access.endpoint;
  const api = createApi(f); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  let runtime, adapter, page, calls = 0, holdResponse = null;
  const layers = [];
  const send = async (url, input) => {
    calls++;
    const response = await fetch(origin + new URL(url).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(input.credential ? { Authorization: 'Bearer ' + input.credential } : {}) }, body: input.bodyJson, signal: input.signal });
    const body = await response.json();
    if (response.status >= 400) throw new Error(body.error);
    if (holdResponse && url.endsWith('/discovery/query')) await holdResponse();
    return body;
  };
  const ui = { keymap: { registerLayer(layer) { layers.push(layer); return () => { const at = layers.indexOf(layer); if (at >= 0) layers.splice(at, 1); }; } },
    ui: { dialog: { setSize() {}, clear() {}, replace(factory) { factory(); } },
      DialogSelect(value) { page = { kind: 'select', ...value }; }, DialogPrompt(value) { page = { kind: 'prompt', ...value }; }, DialogAlert(value) { page = { kind: 'alert', ...value }; } } };
  const viewText = () => [page?.title,page?.message,...(page?.options??[]).flatMap(value=>[value.title,value.description])].filter(Boolean).join('\n');
  const command = name => { const action = [...layers].reverse().flatMap(layer => layer.commands).find(value => value.name === name); assert.ok(action, name); action.run(); };
  const wait = async predicate => {
    const deadline = Date.now() + 7000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Dialog transition timed out at ' + viewText()); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  const choose = text => { assert.equal(page.kind, 'select'); const option = page.options.find(value => value.title.includes(text)); assert.ok(option, text + ' in ' + viewText()); command('galaxy.choose.' + option.value); };
  const fill = async (field, value) => { choose(field); await wait(() => page.kind === 'prompt'); page.onConfirm(value); await wait(() => page.kind === 'select'); };
  try {
    const candidate = { id: randomUUID(), kind: 'module', title: 'Rust 文档检索', summary: '可独立交流的检索实现', functions: ['全文搜索', '中文分词'], technologies: ['Rust'], sourceUrl: 'https://example.org/search', discoverable: true };
    const target = { id: randomUUID(), expectedRevision: 0, selfDeclared: { projects: [candidate] } };
    const grant = await f.authorize(target, 'profile.publish', { visibility: 'Public', purpose: 'public-profile' });
    await f.profiles.publish(f.actor, grant); await f.discovery.save(f.actor, { expectedRevision: 0, preferences: { enabled: true } });
    await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
    await saveConnectionProfile(directory, createConnectionProfile({ targets: [{ id: 'official', kind: 'official', endpoint }], scopes: [{ id: 'bind', targetId: 'official', action: 'binding', recipient: endpoint, purpose: 'Synthetic UI connection', visibleFields: ['subjectId','genesisProof','installationId','scopes'], expiresAt: new Date((now + 90000) * 1000).toISOString() }] }));
    runtime = createLocalHostRuntime({ dataDirectory: directory, endpoint, scopes, installationId: randomUUID(), bindingScopeId: 'bind', trustedKeys: f.bindings.trustedKeys, manifest: (await f.manifest.get()).document, now: () => now,
      connectionSend: send, historySend: send, consentSend: send, projectDiscoverySend: send });
    const connection = await runtime.controller.prepare(); await runtime.controller.execute(connection, connection.confirmation);
    const owner = await runtime.controller.status(); assert.notEqual(owner.subjectId, f.actor.subjectId);
    adapter = createGalaxyAdapter(runtime.controller, { dataDirectory: directory }); await adapter.tui(ui);
    command('galaxy.open'); await wait(() => viewText().includes('当前工作'));
    assert.equal(page.options.filter(value => !value.disabled && /^\[?[1-6]/.test(value.title)).length > 0, true);
    command('galaxy.choose.4'); await wait(() => viewText().includes('我的与设置'));
    command('galaxy.choose.6'); await wait(() => viewText().includes('本机会话可用；远端状态未核查'));
    command('galaxy.choose.4'); await wait(() => viewText().includes('选择检索来源'));
    choose('寻找同行'); await wait(() => viewText().startsWith('项目／模块机会') && viewText().includes('按功能寻找相关的人；单纯交流也可以。'));
    choose('我的资料与项目介绍'); await wait(() => viewText().includes('我的资料') && page.kind === 'select');
    choose('编辑自述'); choose('项目／模块介绍'); choose('添加项目／模块');
    await fill('名称', 'Python 文档索引'); await fill('功能简介', '本机选取的模块介绍'); await fill('功能标签', '全文搜索, PDF提取'); await fill('技术标签', 'Python');
    choose('完成此项编辑'); command('galaxy.zero'); await wait(() => viewText().includes('编辑自述；'));
    choose('预览发布'); await wait(() => page.kind === 'select' && page.options.some(option => option.title.includes('允许本次内容与范围')));
    assert.match(viewText(), /Python 文档索引/); assert.match(viewText(), /仅自己/);
    assert.equal((await f.db.query('SELECT id FROM profile_statements WHERE subject_id=$1', [owner.subjectId])).rows.length, 0);
    choose('查看来源与完整内容'); await wait(() => page.kind === 'alert');
    assert.match(page.message, /"discoverable":false/); assert.match(page.message, /"visibility":"Private"/);
    page.onConfirm(); await wait(() => page.kind === 'select');
    choose('允许本次内容与范围'); await wait(() => page.kind === 'alert' && page.title === '自述已记录');
    page.onConfirm(); await wait(() => page.kind === 'select' && viewText().includes('我的资料'));
    command('galaxy.zero'); await wait(() => viewText().startsWith('项目／模块机会'));
    choose('接触意愿'); await wait(() => viewText().startsWith('接触意愿'));
    choose('开启发现'); await wait(() => viewText().includes('当前欢迎接触'));
    command('galaxy.zero'); await wait(() => viewText().startsWith('项目／模块机会'));
    choose('选择项目并发现机会'); choose('Python 文档索引'); await wait(() => viewText().startsWith('相关机会'));
    choose('Rust 文档检索');await wait(()=>page.kind==='select'&&viewText().includes('相关功能：'));assert.match(viewText(), /相关功能：全文搜索/); assert.match(viewText(), /我方不同技术：python/); assert.match(viewText(), /对方不同技术：rust/); assert.match(viewText(), /共同目的：交流/);
    choose('查看当前来源资料'); await wait(() => page.kind === 'alert' && page.message.includes('https://example.org/search'));
    assert.ok(page.message.includes(candidate.title));assert.ok(page.message.includes(candidate.summary));assert.ok(!page.message.includes(target.id));page.onConfirm(); await wait(() => viewText().startsWith('相关机会'));
    command('galaxy.zero'); command('galaxy.zero'); await wait(() => viewText().startsWith('项目／模块机会'));
    choose('接触意愿'); await wait(() => viewText().startsWith('接触意愿'));
    choose('临时调整'); choose('切换欢迎／暂停'); await fill('持续时长', '2'); choose('保存临时意愿');
    await wait(() => viewText().includes('当前关闭或暂停'));
    const paused = await runtime.controller.projectDiscoveryPreferences(); assert.equal(paused.preferences.temporary.contact, 'paused'); assert.ok(paused.preferences.temporary.until >= now + 7200);
    command('galaxy.zero'); await wait(() => viewText().startsWith('项目／模块机会'));
    choose('选择项目并发现机会'); choose('Python 文档索引'); await wait(() => viewText().includes('发现已关闭或暂时暂停'));
    command('galaxy.zero'); command('galaxy.zero'); await wait(() => viewText().startsWith('项目／模块机会'));
    choose('接触意愿'); await wait(() => viewText().startsWith('接触意愿')); choose('清除临时调整'); await wait(() => viewText().includes('当前欢迎接触'));
    await fill('长期关注方向', '发票处理'); await wait(() => page.kind === 'select' && viewText().startsWith('接触意愿'));
    const ownProfile = await runtime.controller.queryHistory({ subjectId: owner.subjectId, limit: 1 });
    const projectId = ownProfile.selfDeclared.projects[0].id;
    assert.equal((await runtime.controller.queryProjectDiscovery({ projectId })).items.length, 0);
    await fill('长期关注方向', ''); await wait(() => page.kind === 'select' && viewText().startsWith('接触意愿'));
    assert.equal((await runtime.controller.queryProjectDiscovery({ projectId })).items.length, 1);
    let release;
    holdResponse = () => new Promise(resolve => { release = resolve; });
    const pending = runtime.controller.queryProjectDiscovery({ projectId }); await wait(() => release);
    runtime.controller.cancel(); release(); await assert.rejects(pending, /aborted|canceled/i); holdResponse = null;
    await f.consents.revoke(f.actor, grant.consentId);
    assert.equal((await runtime.controller.queryProjectDiscovery({ projectId })).items.length, 0);
    assert.ok(calls > 20, 'real HTTP used through runtime and portable clients');
  } finally {
    adapter?.close(); runtime?.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close();
    assert.equal(dirname(directory), tmpdir()); assert.ok(directory.startsWith(join(tmpdir(), 'galaxy-project-discovery-ui-')));
    await rm(directory, { recursive: true, force: true });
  }
});
