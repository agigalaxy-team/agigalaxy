import { chromium } from 'playwright';
import { build } from '../node_modules/esbuild/lib/main.js';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { workerPanelResult, workerComponentResult } from '../integrations/native-v2/compact-app/worker-result.mjs';
import { workerToolsFixture } from '../integrations/native-v2/worker-tools-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out=fileURLToPath(new URL('../outputs/worker-pack-host-journey/tmp/',import.meta.url));
await mkdir(out, { recursive: true });
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {WorkerPackHostWorkspace} from './packages/galaxy-web/src/worker-pack-host-workspace.tsx';
  const root=createRoot(document.getElementById('panel'));
  window.showPack=(pack)=>root.render(<WorkerPackHostWorkspace key={pack.manifestId} pack={pack}/>);
`, loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'iife',
  platform: 'browser', jsx: 'automatic', alias: { '@': root } });
const css = await readFile(resolve(root, 'packages/galaxy-web/src/workspace.css'), 'utf8');
const builtAssets = resolve(root, 'packages/galaxy-web/dist/assets');
const builtCss = (await readdir(builtAssets)).filter(name => name.endsWith('.css'));
assert.ok(builtCss.length, 'Build the existing web stylesheet before the visual check.');
const baseCss = (await Promise.all(builtCss.map(name => readFile(resolve(builtAssets, name), 'utf8')))).join('\n');
const browser = await chromium.launch({ headless: true });
const checks = [], pageErrors = [];
const actualEvidence = { executed: false };
const pack = { builderId: '11111111-1111-4111-8111-111111111111', manifestId: '22222222-2222-4222-8222-222222222222',
  manifestHash: 'a'.repeat(64), manifest: { name: '合成参考计算配置', version: '1.0.0' } };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.setContent('<html lang="zh-CN"><head><meta charset="UTF-8"></head><body class="galaxy-site"><main class="workspace" style="max-width:900px;margin:30px auto;padding:20px"><h1>Pack 版本与实际使用</h1><section class="task-card" id="panel"></section></main></body></html>');
  await page.addStyleTag({ content: baseCss + '\n' + css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(pack => {
    window.clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.clipboardWrites.push(value); } } });
    window.showPack(pack);
  }, pack);
  await page.getByText('在自己的宿主中使用这个版本', { exact: true }).click();
  await page.getByText('本次所选版本的准确引用', { exact: true }).click();
  await page.getByRole('button', { name: '复制本版本引用' }).click();
  await page.getByText('已复制此版本引用。请在自己的宿主中核对配置和本次任务。').waitFor();
  const copied = await page.evaluate(() => window.clipboardWrites);
  assert.deepEqual(JSON.parse(copied[0]), { builderId: pack.builderId, manifestId: pack.manifestId, manifestHash: pack.manifestHash });
  assert.equal(await page.getByRole('button').count(), 1);
  await page.screenshot({ path: resolve(out, 'web-host-entry-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(out, 'web-host-entry-mobile.png'), fullPage: true });
  checks.push({ check: 'The website exposes exact selected Pack references and host-only preparation, with no execution button; desktop and narrow DOM fit', passed: true });
  await page.evaluate(pack => window.showPack({ ...pack, manifestId: '33333333-3333-4333-8333-333333333333', delisted: true }), pack);
  await page.getByText('在自己的宿主中使用这个版本', { exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('ol').count(), 0);
  assert.equal(await page.getByText('已复制此版本引用。请在自己的宿主中核对配置和本次任务。').count(), 0);
  checks.push({ check: 'Changing the selected Pack clears prior copy status; delisted version hides execution directions and shows maintenance state', passed: true });
  const workerBundle = await build({ stdin: { contents: `export {mountWorkerPanel} from './integrations/native-v2/compact-app/worker-view.mjs'; export {compactCss} from './integrations/native-v2/compact-app/view.mjs';`,
    resolveDir: root, loader: 'js' }, bundle: true, write: false, format: 'iife', globalName: 'WorkerPanel', platform: 'browser' });
  const preview = { handle: '44444444-4444-4444-8444-444444444444', previewHash: 'b'.repeat(64), action: 'start',
    associationId: '55555555-5555-4555-8555-555555555555', workerId: 'reference-arithmetic', pack,
    purpose: '核对本次合成计算', caseId: '66666666-6666-4666-8666-666666666666', attempt: { id: '77777777-7777-4777-8777-777777777777', version: 1 },
    visibility: 'Private', recipients: ['synthetic-selected-peer'], expiresAt: '2030-01-01T00:00:00.000Z', exact: { text: 'synthetic selected private input', operation: 'sum', values: [2, 3] } };
  const sample = { kind: 'galaxy-worker-panel', schemaVersion: 1, viewId: '88888888-8888-4888-8888-888888888888', checkedAt: '2026-10-02T00:00:00.000Z',
    availability: 'ready', workers: [{ id: preview.workerId, version: '1.0.0', pack }], associations: [], preview };
  const projected = workerPanelResult(sample, { componentOnly: true });
  assert.ok(!JSON.stringify(projected.structuredContent).includes(preview.exact.text));
  assert.ok(!JSON.stringify(projected.content).includes(preview.exact.text));
  assert.equal(workerComponentResult(projected).preview.exact.text, preview.exact.text);
  assert.equal(workerPanelResult(sample).structuredContent.preview.exact.text, preview.exact.text);
  checks.push({ check: 'Component-only exact review stays in metadata; ordinary MCP preserves semantically complete authorized review', passed: true });
  await page.setContent('<html lang="zh-CN"><head><meta charset="UTF-8"></head><body><main id="worker"></main></body></html>');
  await page.addScriptTag({ content: workerBundle.outputFiles[0].text });
  await page.evaluate(sample => {
    const style = document.createElement('style'); style.textContent = WorkerPanel.compactCss; document.head.append(style);
    window.workerSample = sample; window.workerCalls = []; window.deferWorkerRead = false;
    window.workerView = WorkerPanel.mountWorkerPanel(document.getElementById('worker'), { call: async (name, args) => {
      workerCalls.push({ name, args });
      if (name === 'galaxy_worker_host_execute') return { resultType: 'input_required', inputRequests: [] };
      if (name === 'galaxy_worker_host_abort_local') { const { preview: _preview, ...rest } = workerSample; return { ...rest, actionResult: { previewDiscarded: true, remoteCanceled: false, originalOperationRetained: true } }; }
      if (name === 'galaxy_worker_host_read' && window.deferWorkerRead) return new Promise(resolve => { window.resolveWorkerRead = resolve; });
      return structuredClone(workerSample);
    } }); workerView.receive(sample);
  }, sample);
  await page.getByText('synthetic selected private input', { exact: false }).waitFor();
  await page.screenshot({ path: resolve(out, 'worker-start-review-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '放弃本次预览' }).click();
  await page.getByText('已停止本机预览。没有据此确认远端工作已取消。').waitFor();
  assert.equal(await page.evaluate(() => workerCalls.filter(v => v.name === 'galaxy_worker_host_execute').length), 0);
  await page.evaluate(sample => workerView.receive(sample), sample);
  await page.getByRole('button', { name: '继续审阅并确认本次操作' }).click();
  await page.getByText('请在宿主确认界面审阅本次操作。尚未收到执行回执。').waitFor();
  assert.equal(await page.getByRole('button', { name: '继续审阅并确认本次操作' }).count(), 0);
  assert.deepEqual(await page.evaluate(() => workerCalls.find(v => v.name === 'galaxy_worker_host_execute').args), { handle: preview.handle, previewHash: preview.previewHash });
  checks.push({ check: 'Discard invokes only abort_local; execute sends the exact opaque handle/hash once and input_required makes no success claim or repeated button', passed: true });
  const association = { associationId: preview.associationId, workerId: preview.workerId, pack, purpose: preview.purpose,
    caseId: preview.caseId, attempt: preview.attempt, configuration: { id: '99999999-9999-4999-8999-999999999999', version: 1 } };
  const selected = { association, peer: { id: association.associationId, status: 'unknown', peer: null }, executionAuthority: 'peer-reported', capabilityVerified: false };
  const opened = { ...sample, preview: undefined, associations: [association], selected };
  await page.evaluate(sample => { workerSample = sample; workerView.receive(sample); }, opened);
  assert.equal(await page.getByRole('button', { name: '查询对端当前进展' }).count(), 0);
  assert.equal(await page.getByText('整理这次结果', { exact: true }).count(), 0);
  await page.getByText('尚未取得对端任务编号，不能自动轮询或重新发送。请在原宿主核对这次关联。').waitFor();
  await page.getByRole('button', { name: '查询原结果回执' }).click();
  const reads = await page.evaluate(() => workerCalls.filter(v => v.name === 'galaxy_worker_host_read'));
  assert.deepEqual(reads.at(-1).args, { action: 'reconcile-result', associationId: preview.associationId });
  const failed = { ...opened, selected: { ...selected, peer: { id: association.associationId, status: 'observed', peer: { taskId: 'synthetic-task', state: 'failed' } } } };
  await page.evaluate(sample => { workerSample = sample; workerView.receive(sample); }, failed);
  await page.getByText('整理这次结果', { exact: true }).click();
  assert.equal(await page.getByRole('option', { name: '报告成功', exact: true }).count(), 0);
  assert.equal(await page.getByRole('option', { name: '部分完成', exact: true }).count(), 0);
  await page.getByRole('textbox', { name: '结果摘要', exact: true }).fill('本次计算失败，保留有限观察');
  await page.getByRole('button', { name: '审阅结果记录' }).click();
  assert.equal(await page.evaluate(() => workerCalls.filter(v => v.name === 'galaxy_worker_host_prepare').at(-1).args.reportedOutcome), 'inconclusive');
  checks.push({ check: 'Unknown association offers original receipt only; observed failed task cannot be prepared as success or partial from the UI', passed: true });
  await page.evaluate(() => { window.deferWorkerRead = true; });
  await page.getByRole('button', { name: '刷新本机关联' }).click();
  await page.evaluate(sample => workerView.receive({ ...sample, viewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', selected: undefined, associations: [], availability: 'unconfigured' }), opened);
  await page.evaluate(sample => window.resolveWorkerRead(sample), failed);
  await page.getByText('当前宿主没有可用的 Worker 执行连接。请在原运行环境核对配置；网页清单和已有事实仍可按权限查看。').waitFor();
  assert.equal(await page.getByText('本次计算失败，保留有限观察', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '查询对端当前进展' }).count(), 0);
  await page.screenshot({ path: resolve(out, 'worker-unconfigured-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checks.push({ check: 'A late old read cannot replace a new view or restore old execution material, and the unavailable host shows no execution controls', passed: true });
  const actual = await workerToolsFixture();
  try {
    const actualCalls = [];
    await page.exposeFunction('callActualWorkerTool', async (name, args) => {
      actualCalls.push({ name, action: args.action, associationId: args.associationId, handle: args.handle });
      return actual.raw(name, args);
    });
    await page.evaluate(() => {
      workerView.close();
      window.workerView = WorkerPanel.mountWorkerPanel(document.getElementById('worker'), { call: (name, args) => window.callActualWorkerTool(name, args) });
    });
    const present = result => page.evaluate(result => workerView.receive(result), result);
    const idle = () => page.waitForFunction(() => document.getElementById('worker').getAttribute('aria-busy') === 'false');
    const chooseOriginal = async (answer = 'allow') => {
      await page.getByRole('button', { name: '继续审阅并确认本次操作' }).click();
      await page.getByRole('link', { name: '打开本机审阅页' }).waitFor();
      const popupReady = page.waitForEvent('popup');
      await page.getByRole('link', { name: '打开本机审阅页' }).click();
      const popup = await popupReady;
      let postHeaders;
      popup.on('request', request => { if (request.method() === 'POST') { const headers = request.headers(); postHeaders = { origin: headers.origin, contentType: headers['content-type'], secFetchSite: headers['sec-fetch-site'], pageOrigin: new URL(request.url()).origin }; } });
      await popup.getByRole('button', { name: answer === 'allow' ? '允许本次显示的操作' : '拒绝', exact: true }).click();
      const choiceText = await popup.locator('body').innerText();
      assert.ok(choiceText.includes(answer === 'allow' ? '已允许显示的操作。返回原宿主重试同一操作以继续。' : '已拒绝。本次操作没有获得授权。'), 'Native review response: ' + choiceText.slice(0, 300) + '; ' + JSON.stringify(postHeaders));
      await popup.close();
      await page.getByRole('button', { name: '完成审阅后继续本次操作' }).click();
      await idle();
    };
    const approveOriginal = () => chooseOriginal('allow');
    const input = { action: 'start', ...await actual.fact('浏览器审阅真实参考进程求和'), text: JSON.stringify({ operation: 'sum', values: [2, 3] }) };
    await present(await actual.raw('galaxy_worker_host_prepare', input));
    await page.getByRole('button', { name: '放弃本次预览' }).click(); await idle();
    assert.equal((await actual.processWorker.observations()).starts, 0);
    await present(await actual.raw('galaxy_worker_host_prepare', input));
    await chooseOriginal('decline');
    await page.getByText('你已拒绝本次操作，没有提交。', { exact: true }).waitFor();
    assert.equal((await actual.processWorker.observations()).starts, 0);
    const deniedPreview = await actual.prepare(input);
    const deniedChoice = await actual.call('galaxy_worker_host_execute', { handle: deniedPreview.handle, previewHash: deniedPreview.previewHash });
    assert.equal(deniedChoice.state, 'user-choice-needs-browser');
    const submitForeign = async (foreignPage, url) => {
      await foreignPage.evaluate(url => {
        const form = document.createElement('form'); form.method = 'POST'; form.action = url;
        const button = document.createElement('button'); button.name = 'action'; button.value = 'allow'; button.textContent = 'Synthetic cross-origin submit'; form.append(button); document.body.append(form);
      }, url);
      const deniedResponse = foreignPage.waitForResponse(response => response.request().method() === 'POST');
      await foreignPage.getByRole('button', { name: 'Synthetic cross-origin submit' }).click();
      assert.equal((await deniedResponse).status(), 403);
      const rejection = await foreignPage.locator('body').innerText();
      assert.ok(rejection.includes('请在本机审阅页面操作。') || rejection.includes('拒绝跨站提交。'), rejection);
      await foreignPage.close();
    };
    await submitForeign(await browser.newPage(), deniedChoice.url);
    const foreign = createServer((_req, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><body>Unrelated synthetic origin</body>'); });
    await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
    try {
      const foreignPage = await browser.newPage();
      await foreignPage.goto('http://127.0.0.1:' + foreign.address().port);
      await submitForeign(foreignPage, deniedChoice.url);
    } finally { foreign.closeAllConnections(); await new Promise(resolve => foreign.close(resolve)); }
    const stillPending = await actual.call('galaxy_worker_host_execute', { handle: deniedPreview.handle, previewHash: deniedPreview.previewHash });
    assert.equal(stillPending.state, 'user-choice-needs-browser');
    assert.equal((await actual.processWorker.observations()).starts, 0);
    await actual.call('galaxy_worker_host_abort_local', { handle: deniedPreview.handle });
    checks.push({ check: 'Actual native review decline starts no work; real browser opaque-origin and separate-origin form submissions remain denied and leave the original decision pending', passed: true });
    const prepared = await actual.raw('galaxy_worker_host_prepare', input);
    const original = workerComponentResult(prepared).preview;
    await present(prepared); await approveOriginal();
    assert.equal((await actual.processWorker.observations()).starts, 1);
    assert.equal(Number((await actual.f.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count), 0);
    assert.equal(actual.f.calls.filter(p => p === '/v2/builders/pack-uses/events').length, 0);
    await page.getByRole('button', { name: '查看原工作关联' }).click(); await idle();
    await page.getByText('对端报告已完成', { exact: true }).waitFor();
    const observed = await actual.flow.read(original.associationId);
    assert.equal(observed.peer.peer.state, 'completed');
    assert.ok(JSON.stringify(observed.peer.peer).includes('\\"value\\":5'));
    checks.push({ check: 'Actual browser buttons → HTTP MCP SDK → native exact local review → fixed independent Worker process; dropping preview starts zero, explicit approval starts once without Result/use publication', passed: true });

    await page.getByText('整理这次结果', { exact: true }).click();
    await page.getByRole('textbox', { name: '结果摘要', exact: true }).fill('本次所选输入计算得到5，未验证外部问题已解决');
    await page.getByRole('combobox', { name: '你对结果的判断', exact: true }).selectOption('succeeded');
    await page.getByRole('textbox', { name: '限制与尚未核对的部分', exact: true }).fill('合成输入与参考程序；没有独立能力认证');
    await page.getByRole('button', { name: '审阅结果记录' }).click(); await idle();
    actual.controls.loseResultAck = true;
    await approveOriginal();
    await page.getByText('操作未完成。原关联仍保留，不会自动重新执行。', { exact: false }).waitFor();
    assert.equal(Number((await actual.f.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count), 1);
    await page.getByRole('button', { name: '查看原工作关联' }).click(); await idle();
    await page.getByRole('button', { name: '查询原结果回执' }).click(); await idle();
    await page.getByText('原操作已接受。请按原关联核对实际状态。').waitFor();
    assert.equal(Number((await actual.f.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count), 1);
    await page.getByRole('button', { name: '查看原工作关联' }).click(); await idle();
    await page.getByRole('button', { name: '审阅这个 Pack 的使用关联' }).click(); await idle();
    actual.f.state.losePackUseAck = true;
    await approveOriginal();
    await page.getByRole('button', { name: '查看原工作关联' }).click(); await idle();
    await page.getByRole('button', { name: '查询原使用关联回执' }).click(); await idle();
    await page.getByText('原操作已接受。请按原关联核对实际状态。').waitFor();
    assert.equal(actual.f.calls.filter(p => p === '/v2/builders/pack-uses/events').length, 1);
    assert.equal((await actual.processWorker.observations()).starts, 1);
    const finalAssociation = await actual.flow.read(original.associationId);
    const used = await actual.f.workerClient.get({ id: finalAssociation.association.packUse.id });
    assert.equal(used.sources.successfulReuseVerified, false);
    assert.deepEqual(used.record.configuration, { id: actual.config.id, version: 1 });
    assert.deepEqual(used.record.attempt, { id: input.attemptId, version: 1 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: resolve(out, 'actual-mcp-use-receipt-desktop.png'), fullPage: true });
    checks.push({ check: 'Actual separately reviewed Result and PackUse commits each survive one lost ACK; original receipt queries preserve exact Configuration/Attempt and do not execute or publish twice', passed: true });

    const delayed = { action: 'start', ...await actual.fact('浏览器取消已选延迟参考工作'), text: JSON.stringify({ operation: 'sum', values: [4, 6], delayMs: 5000 }) };
    const delayedPrepared = await actual.raw('galaxy_worker_host_prepare', delayed);
    const delayedId = workerComponentResult(delayedPrepared).preview.associationId;
    await present(delayedPrepared); await approveOriginal();
    await page.getByRole('button', { name: '查看原工作关联' }).click(); await idle();
    await page.getByRole('button', { name: '审阅停止远端工作的请求' }).click(); await idle();
    await page.getByRole('button', { name: '放弃本次预览' }).click(); await idle();
    assert.equal(actual.processWorker.requests.filter(v => v === 'CancelTask').length, 0);
    await page.getByRole('button', { name: '查看原工作关联' }).click(); await idle();
    await page.getByRole('button', { name: '审阅停止远端工作的请求' }).click(); await idle();
    await approveOriginal();
    await page.getByRole('button', { name: '查看原工作关联' }).click(); await idle();
    await page.getByText('对端报告已取消', { exact: true }).waitFor();
    assert.equal((await actual.flow.read(delayedId)).peer.peer.state, 'canceled');
    assert.equal(actual.processWorker.requests.filter(v => v === 'CancelTask').length, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(out, 'actual-mcp-canceled-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    checks.push({ check: 'Actual remote CancelTask requires its own review; abandoning its preview sends zero cancellations, approved exact cancellation is observed as canceled', passed: true });
    Object.assign(actualEvidence, { executed: true, actualMcpHttp: true, actualNativeChoiceBrowser: true, actualIndependentChild: true,
      database: 'PGlite', localStore: 'Map fixture', actualPhysicalHostApps: false, modelExecuted: false,
      starts: (await actual.processWorker.observations()).starts, cancellations: (await actual.processWorker.observations()).cancellations,
      resultRecords: Number((await actual.f.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count),
      packUseWrites: actual.f.calls.filter(p => p === '/v2/builders/pack-uses/events').length, toolCallCount: actualCalls.length, successfulReuseVerified: false });
  } finally { await actual.close(); }
  assert.deepEqual(pageErrors, []);
} finally {
  await writeFile(resolve(out, 'browser-report.json'), JSON.stringify({ synthetic: true, actualBrowser: true,
    mockedClipboard: true, mockedWorkerToolsInDomCases: true, actualEvidence,
    scope: 'Synthetic identities/inputs. Browser test transport calls actual HTTP MCP/host choice/independent Worker. No physical MCP Apps host acceptance claimed.', checks, pageErrors }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ passed: checks.length, out }));
