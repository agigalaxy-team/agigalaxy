import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createConfiguredRuntime } from '../../../integrations/host-adapters/opencode-stable/configured-runtime.mjs';
import { createGalaxyAdapter } from '../../../integrations/host-adapters/opencode-stable/galaxy.tui.ts';
import { createConfiguredGalaxyAdapter } from '../../../integrations/host-adapters/opencode-stable/configured-galaxy.tui.ts';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { createConnectionProfile, saveConnectionProfile } from '../../galaxy-core/src/connection-profile.mjs';
import { hubProfile } from './hub-manifest-fixture.mjs';

test('configured discovery stays explicit, verifies signatures and discards canceled reads without local writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-configured-'));
  const f = await serviceFixture(['binding']);
  t.after(async () => { await f.db.close(); await rm(directory, { recursive: true, force: true }); });
  let time = f.now, networkFailure = false;
  const config = { endpoint: f.bindings.endpoint, dataDirectory: join(directory, 'absent'), scopes: ['binding'],
    installationId: randomUUID(), bindingScopeId: 'bind', trustedKeys: f.bindings.trustedKeys, now: () => time };
  let calls = 0, release;
  let document = (await f.manifest.get()).document;
  const source = createConfiguredRuntime(config, { readManifest: async (url, options) => {
    calls++; assert.equal(url, config.endpoint + '/.well-known/galaxy-network.json');
    assert.deepEqual(Object.keys(options), ['signal']);
    if (networkFailure) throw new Error('Synthetic transport failure');
    if (release === null) await new Promise(resolve => { release = resolve; });
    return document;
  } });
  t.after(() => source.close());
  const adapter = createConfiguredGalaxyAdapter(config); adapter.close();
  assert.equal(source.status().state, 'not-read');
  assert.equal(calls, 0); assert.deepEqual(await readdir(directory), []);
  release = null;
  const abort = new AbortController(), pending = source.read(abort.signal);
  abort.abort(); release(); await assert.rejects(pending);
  assert.equal(source.status().state, 'canceled');
  assert.deepEqual(await readdir(directory), []);
  const result = await source.read(new AbortController().signal);
  assert.equal(result.connected, false); assert.equal(result.authorized, false);
  assert.equal(result.operator, 'Fixture');
  assert.equal(source.status().state, 'verified');
  f.bindings.trustedKeys.get('fixture').revoked = true;
  assert.equal(source.status().state, 'unverified');
  f.bindings.trustedKeys.get('fixture').revoked = false;
  time += 301; assert.equal(source.status().state, 'expired');
  await assert.rejects(source.read(new AbortController().signal)); assert.equal(source.status().state, 'expired');
  time = f.now; networkFailure = true;
  await assert.rejects(source.read(new AbortController().signal)); assert.equal(source.status().state, 'unreachable');
  networkFailure = false;
  await assert.rejects(result.controller.prepare()); // Missing identity is never generated.
  assert.deepEqual(await readdir(directory), []);
  document = { signed: 'invalid' };
  await assert.rejects(source.read(new AbortController().signal));
  assert.equal(source.status().state, 'unverified');
  release = null; const unloaded = source.read(new AbortController().signal);
  source.close(); release(); await assert.rejects(unloaded);
  assert.equal(source.status().state, 'closed');
  source.close(); await assert.rejects(source.read(new AbortController().signal));
});

for (const networkType of ['official','hub']) test(`native configured ${networkType} page reads on selection, reconnects explicitly and Esc prevents a late page`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-configured-ui-'));
  const f = await serviceFixture(['binding'],null,networkType==='hub'?{manifestProfile:hubProfile,endpoint:'https://hub.example.org'}:{});
  t.after(async () => { await f.db.close(); await rm(directory, { recursive: true, force: true }); });
  await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
  const endpoint = f.bindings.endpoint;
  await saveConnectionProfile(directory, createConnectionProfile({ targets: [{ id: 'official', kind: networkType, endpoint }],
    scopes: [{ id: 'bind', targetId: 'official', action: 'binding', recipient: endpoint, purpose: 'Explicit connection',
      visibleFields: ['subjectId', 'genesisProof', 'installationId', 'scopes'], expiresAt: new Date((f.now + 90000) * 1000).toISOString() }] }));
  let reads = 0, writes = 0, release;
  const source = createConfiguredRuntime({ endpoint, networkType, dataDirectory: directory, scopes: ['binding'],
    installationId: randomUUID(), bindingScopeId: 'bind', trustedKeys: f.bindings.trustedKeys, now: () => f.now,
    connectionSend: async (url, options) => {
      writes++; const body = JSON.parse(options.bodyJson);
      const handlers = { '/v1/binding-challenges': () => f.bindings.challenge(body), '/v1/bindings': () => f.bindings.bind(body),
        '/v1/session-challenges': () => f.access.challenge(body), '/v1/sessions': () => f.access.activate(body) };
      return handlers[new URL(url).pathname]();
    } },
  { readManifest: async () => { reads++; if (release === null) await new Promise(resolve => { release = resolve; }); return (await f.manifest.get()).document; } });
  t.after(() => source.close());
  const layers = []; let page = null;
  const api = { keymap: { registerLayer(layer) { layers.push(layer); return () => { const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1); }; } },
    ui: { dialog: { setSize() {}, clear() { page = null; }, replace(factory) { factory(); } },
      DialogSelect(value) { page = { ...value, kind: 'select' }; }, DialogAlert(value) { page = { ...value, kind: 'alert' }; }, DialogPrompt(value) { page = { ...value, kind: 'prompt' }; } } };
  const viewText = () => [page?.title,page?.message,...(page?.options??[]).flatMap(value=>[value.title,value.description])].filter(Boolean).join('\n');
  const command = name => { const item = layers.flatMap(layer => layer.commands).find(item => item.name === name); assert.ok(item, name); return item.run(); };
  const wait = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error(`UI transition timed out: kind=${page?.kind}, writes=${writes}, message=${page?.message ?? ''}`); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const adapter = createGalaxyAdapter(null, { discovery: source, dataDirectory: directory });
  t.after(() => adapter.close());
  await adapter.tui(api);
  const openConnection = async () => {
    command('galaxy.open'); await wait(() => page?.kind === 'select' && page.options.some(option => option.value === '1' && option.title.includes('找帮助')));
    assert.ok(page.options.some(option => option.title.includes('回到原工作')));
    command('galaxy.choose.4'); await wait(() => viewText().includes('我的与设置'));
    command('galaxy.choose.6');
  };
  await openConnection(); assert.match(viewText(), /尚未读取/); assert.equal(reads, 0);
  await command('galaxy.choose.1'); assert.equal(reads, 1); assert.match(page.message, /尚未连接或授权/);
  assert.ok(page.message.includes(networkType==='hub'?'Hub':'Official'));
  page.onConfirm(); await wait(() => page?.kind === 'select' && viewText().includes(endpoint));
  command('galaxy.choose.1'); await wait(() => page?.kind === 'select' && page.options.some(option => option.title.includes('允许这次连接')));
  assert.equal(writes, 0); assert.ok(viewText().includes(endpoint));
  command('galaxy.choose.1'); command('galaxy.exit');
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(page, null); assert.equal(writes, 0);
  await openConnection(); await wait(() => viewText().includes('没有本机会话'));
  command('galaxy.choose.1'); await wait(() => page?.kind === 'select' && page.options.some(option => option.title.includes('允许这次连接')));
  command('galaxy.choose.1'); await wait(() => page?.kind === 'select' && viewText().includes('本机会话可用'));
  assert.equal(writes, 4);
  command('galaxy.choose.3');assert.ok(page.options.some(option=>option.title.includes('本人设备与绑定')));command('galaxy.choose.5');
  await wait(() => page?.kind === 'select' && page.title.startsWith('本机绑定回执'));
  assert.equal(page.options.filter(option=>option.value&&!option.disabled).length, 1); command('galaxy.choose.1');
  assert.match(page.message, /仅本机历史/); assert.equal(writes, 4); assert.equal(reads, 1);
  command('galaxy.exit'); await openConnection(); await wait(() => viewText().includes('本机会话可用'));
  command('galaxy.choose.2'); assert.match(viewText(), /服务信息签名有效/); assert.equal(reads, 1);
  release = null; const pending = command('galaxy.choose.1'); assert.equal(reads, 2);
  command('galaxy.exit'); assert.equal(page, null); release(); await pending;
  assert.equal(page, null);
  await openConnection(); assert.match(viewText(), /读取已取消/);
  page.options.find(option => option.value === '1').onSelect(); adapter.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, 2); assert.equal(page, null); assert.equal(layers.length, 0);
  await assert.rejects(adapter.tui(api));
  let offlineRequests = 0;
  const offlineSource = createConfiguredRuntime({ endpoint, networkType, dataDirectory: directory, scopes: ['binding'], installationId: randomUUID(),
    bindingScopeId: 'bind', trustedKeys: f.bindings.trustedKeys, now: () => f.now },
  { readManifest: async () => { offlineRequests++; throw new Error('Offline'); } });
  const offlineAdapter = createGalaxyAdapter(null, { discovery: offlineSource, dataDirectory: directory });
  t.after(() => offlineAdapter.close());
  await offlineAdapter.tui(api);
  await openConnection(); command('galaxy.choose.2');
  await wait(() => page?.kind === 'select' && page.title.startsWith('本机绑定回执'));
  assert.equal(page.options.filter(option=>option.value&&!option.disabled).length, 1); assert.equal(offlineRequests, 0);
  command('galaxy.choose.1'); assert.match(page.message, /历史配置与当前不同/);
  assert.equal(offlineSource.status().state, 'not-read');
  command('galaxy.exit');await openConnection();command('galaxy.choose.3');
  await wait(()=>page?.kind==='select'&&page.title.startsWith('本机反馈汇总'));
  assert.match(viewText(),/本机反馈 0 条/);assert.equal(offlineRequests,0);assert.equal(offlineSource.status().state,'not-read');
  command('galaxy.exit');await openConnection();command('galaxy.choose.4');
  await wait(()=>page?.kind==='select'&&page.title.startsWith('继续未完成内容'));
  command('galaxy.choose.1');await wait(()=>page?.kind==='prompt'&&viewText().includes('标题'));
  page.onConfirm('Offline saved collaboration');await wait(()=>page?.kind==='prompt'&&viewText().includes('问题说明'));
  assert.equal(offlineRequests,0);
  command('galaxy.exit');await openConnection();command('galaxy.choose.4');
  await wait(()=>page?.kind==='select'&&page.options.some(option=>option.title.includes('Offline saved collaboration')));
  command('galaxy.choose.1');await wait(()=>page?.kind==='select'&&page.options.some(option=>option.title.includes('继续填写')));
  command('galaxy.choose.1');await wait(()=>page?.kind==='prompt'&&viewText().includes('问题说明'));
  assert.equal(offlineRequests,0);assert.equal(offlineSource.status().state,'not-read');
  const localIdentity=JSON.parse(await readFile(join(directory,'galaxy-id.json'),'utf8'));
  const materialDraft=await offlineSource.createContextDraft({view:'requester',state:'active',requesterId:localIdentity.id,
    request:{id:randomUUID(),caseId:randomUUID(),title:'Offline material draft'},selected:{providerId:f.actor.subjectId},
    agreedScope:'Selected synthetic diagnostics',events:[{event:{kind:'confirm',id:randomUUID()}}]});
  command('galaxy.exit');await openConnection();command('galaxy.choose.5');
  await wait(()=>page?.kind==='select'&&page.options.some(option=>option.title.includes('Offline material draft')));
  command('galaxy.choose.1');await wait(()=>page?.kind==='select'&&page.options.some(option=>option.title.includes('继续编辑材料')));
  command('galaxy.choose.1');await wait(()=>page?.kind==='prompt'&&viewText().includes('材料名称'));
  page.onConfirm('Locally selected text');await wait(()=>page?.kind==='prompt'&&viewText().includes('选定文本片段'));
  page.onConfirm('Saved without network.');await wait(()=>page?.kind==='select'&&viewText().includes('选定材料草稿'));
  assert.equal((await offlineSource.getContextDraft(materialDraft.id)).content.materials[0].content,'Saved without network.');
  const localFile=join(directory,'offline-context.log');await writeFile(localFile,'Unselected\nOffline selected log.\nUnselected');
  const currentDraft=await offlineSource.getContextDraft(materialDraft.id);
  const excerpt=await offlineSource.previewContextFile({id:currentDraft.id,expectedRevision:currentDraft.revision,path:localFile,startLine:2,endLine:2});
  assert.equal(excerpt.content,'Offline selected log.');assert.deepEqual(await offlineSource.getContextDraft(materialDraft.id),currentDraft);
  assert.equal(offlineRequests,0);assert.equal(offlineSource.status().state,'not-read');
});
