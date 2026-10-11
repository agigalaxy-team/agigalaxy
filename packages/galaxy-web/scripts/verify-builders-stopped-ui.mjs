import { chromium } from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { createApi } from '../../galaxy-official/src/http.mjs';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { builderDeclaration } from '../../galaxy-official/test/builders-workflow.mjs';

const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
const out = fileURLToPath(new URL('../../../../../../07-logs/development/ui-resume-20261002/builders-stopped/', import.meta.url)); await mkdir(out, { recursive: true });
const fixture = await serviceFixture(browserScopes, null, { now, syntheticCommunityQuota: false });
let releaseOriginal, enteredOriginal;
const barrier = new Promise(resolve => { releaseOriginal = resolve; }), entered = new Promise(resolve => { enteredOriginal = resolve; });
let gateFirst = true;
const publish = fixture.builders.publish.bind(fixture.builders);
fixture.builders.publish = async (...args) => { if (gateFirst) { gateFirst = false; enteredOriginal(); await barrier; } return publish(...args); };
const api = createApi({ ...fixture, browserOrigins: ['https://galaxy-ui.example.org'], rateLimit: 10000 });
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve)); const apiOrigin = `http://127.0.0.1:${api.address().port}`;
let configuredEndpoint = endpoint;
const frontend = createServer(async (request, response) => {
  try {
    if (request.url === '/galaxy-web-config.json') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ version: 1, endpoint: configuredEndpoint,
      operator: 'Synthetic Builder UI', signingKeys: [...fixture.bindings.trustedKeys].map(([kid, pin]) => ({ kid, ...pin })) })); return; }
    const upstream = await fetch('http://127.0.0.1:5179' + request.url); response.statusCode = upstream.status;
    for (const [key, value] of upstream.headers) if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key)) response.setHeader(key, value);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { response.writeHead(500); response.end('synthetic_fixture_failure'); }
});
await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${frontend.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe' });
const contexts = [], events = [], calls = [], pageErrors = [];
/** @type {Promise<{status():number}>|undefined} */
let originalResponse;
let page, delayBusiness = true, failReceipt = false;
async function open() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); contexts.push(context); context.setDefaultTimeout(15000);
  await context.addInitScript(now => { Date.now = () => now * 1000; }, now);
  await context.route(endpoint + '/**', async route => {
    const request = route.request(), url = new URL(request.url()); calls.push({ path: url.pathname });
    if (failReceipt && url.pathname === '/v1/builders/events/receipt') { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic_receipt_unavailable"}' }); return; }
    try {
      const result = context.request.fetch(apiOrigin + url.pathname + url.search, { method: request.method(), headers: { ...request.headers(), origin: 'https://galaxy-ui.example.org' }, data: request.postData() ?? undefined });
      if (delayBusiness && url.pathname === '/v1/builders/events') { delayBusiness = false; originalResponse = result; result.catch(() => {}); await entered; await route.abort('failed'); return; }
      const response = await result; await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': origin } });
    } catch { await route.abort('failed').catch(() => {}); }
  });
  const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); return { page, context };
}
async function identity(page) {
  if (await page.getByRole('button', { name: '打开菜单', exact: true }).isVisible()) { await page.getByRole('button', { name: '打开菜单', exact: true }).click(); await page.locator('.mobile-personal a[href="/app/settings/identity"]').click(); }
  else { await page.locator('.personal-menu>summary').click(); await page.locator('.personal-menu a[href="/app/settings/identity"]').click(); }
  await page.getByRole('heading', { name: '身份与设置', exact: true }).waitFor();
}
async function shot(name) { await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); }); await page.screenshot({ path: resolve(out, name + '.png'), fullPage: true, mask: [page.locator('textarea.recovery-code,textarea[autocomplete="off"]')] }); }
async function form(name) { await page.getByRole('button', { name: '新建登记', exact: true }).click(); const declaration = builderDeclaration('bridge'); declaration.name = name;
  await page.getByRole('textbox', { name: '资料 JSON', exact: true }).fill(JSON.stringify(declaration)); await page.getByRole('button', { name: '预览准确内容与范围', exact: true }).click(); await page.getByRole('heading', { name: '本次发送预览', exact: true }).waitFor(); }
const businessWrites = () => calls.filter(item => item.path === '/v1/builders/events').length;
try {
  const first = await open(); page = first.page; await page.goto(origin + '/app/builders'); await identity(page); await page.getByRole('button', { name: '创建我的银河身份', exact: true }).click();
  await page.getByRole('heading', { name: '当前银河身份', exact: true }).waitFor(); const firstId = await page.locator('.identity-id').textContent();
  await page.getByRole('button', { name: '连接并返回', exact: true }).click(); await page.waitForURL(origin + '/app/builders');
  await form('合成原建设者声明'); await page.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(businessWrites(), 0);
  events.push({ check: 'canceling a real declaration preview sends no business event', passed: true });
  await form('合成原建设者声明'); await page.getByRole('button', { name: '确认这份内容并发布', exact: true }).click(); await page.getByRole('button', { name: '核对并放弃重试', exact: true }).waitFor(); assert.equal(businessWrites(), 1);
  await page.getByRole('button', { name: '核对并放弃重试', exact: true }).click(); await page.getByRole('button', { name: '继续保留本机重试', exact: true }).click(); await page.getByRole('button', { name: '查询原回执', exact: true }).waitFor(); assert.equal(businessWrites(), 1);
  events.push({ check: 'canceling the stop preview keeps the original pending operation without resending', passed: true });
  failReceipt = true; await page.getByRole('button', { name: '核对并放弃重试', exact: true }).click(); await page.getByRole('button', { name: '确认停止本机重试', exact: true }).click();
  const stopped = page.getByRole('region', { name: '已停止本机重试的原操作', exact: true }); await stopped.getByRole('heading', { name: '已停止本机重试', exact: true }).waitFor();
  await stopped.getByText('远端状态待核对，原操作定位信息继续保留。', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '仅重试原操作', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '本次发送预览', exact: true }).count(), 0); assert.equal(await page.getByRole('textbox', { name: '资料 JSON', exact: true }).inputValue(), '');
  await stopped.getByRole('button', { name: '只查询这项原事件回执', exact: true }).click(); await stopped.getByRole('alert').waitFor(); assert.equal(businessWrites(), 1);
  failReceipt = false; await stopped.getByRole('button', { name: '只查询这项原事件回执', exact: true }).click(); await stopped.getByText('当前时点尚未找到原事件；先前在途请求仍可能稍后提交。', { exact: true }).waitFor();
  events.push({ check: 'unknown receipt can stop only local retry; explicit failed query retains locator, and later absent is accurately shown as a time-point observation', passed: true });
  await form('合成新的独立声明'); await page.getByRole('button', { name: '确认这份内容并发布', exact: true }).click(); await page.getByRole('heading', { name: '合成新的独立声明', exact: true }).waitFor(); assert.equal(businessWrites(), 2);
  await stopped.getByRole('button', { name: '只查询这项原事件回执', exact: true }).waitFor(); assert.equal(await stopped.locator('article').count(), 1);
  releaseOriginal(); assert.equal((await originalResponse).status(), 200);
  const beforeQuery = calls.length; await stopped.getByRole('button', { name: '只查询这项原事件回执', exact: true }).click(); await stopped.getByText('服务已接收这项原事件；不代表能力认证或实际运行。', { exact: true }).waitFor();
  assert.deepEqual(calls.slice(beforeQuery).map(item => item.path), ['/v1/builders/events/receipt']); assert.equal(businessWrites(), 2);
  const retained = await page.evaluate(async ({ endpoint, subjectId }) => {
    const { openDeviceKeyStore } = await import('/app/@fs/C:/Users/USER1/Documents/ChatGPT/projects/active/银河项目/agi-galaxy-network/05-build/repos/galaxy-founding-beta/packages/galaxy-core/src/domain/device-key-store.mjs');
    const store = await openDeviceKeyStore(); try { const record = await store.get(`galaxy-web:${endpoint}:${subjectId}:builder-web-v2:${endpoint}:${subjectId}`);
      return { count: record.stoppedOperations.length, keys: Object.keys(record.stoppedOperations[0]).sort(), pending: !!record.pending, containsOriginalBody: JSON.stringify(record.stoppedOperations).includes('合成原建设者声明') };
    } finally { store.close(); }
  }, { endpoint, subjectId: firstId });
  assert.deepEqual(retained, { count: 1, keys: ['builderId', 'endpoint', 'eventId', 'ownerId', 'payloadHash'], pending: false, containsOriginalBody: false });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot('stopped-original-after-new-declaration-narrow');
  events.push({ check: 'a real original HTTP dispatch commits after local stop and a new independent declaration; original stopped receipt remains queryable with one read request and no repeat business/Consent write', passed: true, actualIndexedDbMinimalLocator: retained });
  configuredEndpoint = 'https://other-synthetic.example.org'; await page.reload(); await page.getByText('公开资料可以浏览；连接身份后可登记和管理自己的资料。', { exact: true }).waitFor(); assert.equal(await page.locator('.builder-stopped-operations').count(), 0);
  configuredEndpoint = endpoint; await page.reload(); await identity(page); await page.getByRole('button', { name: '连接并返回', exact: true }).click(); await page.waitForURL(origin + '/app/builders');
  await page.locator('.builder-stopped-operations').getByRole('button', { name: '只查询这项原事件回执', exact: true }).waitFor();
  events.push({ check: 'changing configured endpoint clears a previously visible stopped list; returning and explicitly reconnecting original endpoint restores its own retained locator', passed: true });
  const other = await open(); const previousPage = page; page = other.page; await page.goto(origin + '/app/builders'); await identity(page); await page.getByRole('button', { name: '创建我的银河身份', exact: true }).click(); await page.getByRole('heading', { name: '当前银河身份', exact: true }).waitFor(); const otherId = await page.locator('.identity-id').textContent();
  await page.getByRole('button', { name: '准备或更换恢复码', exact: true }).click(); const recoveryField = page.getByRole('textbox', { name: '新的恢复码', exact: true }); await recoveryField.waitFor(); const code = await recoveryField.inputValue(); await page.getByRole('button', { name: '我已保存', exact: true }).click();
  page = previousPage; await identity(page); await page.locator('#recover-existing').evaluate(element => { element.open = true; }); await page.locator('#recover-existing textarea').fill(code); await page.getByRole('button', { name: '确认恢复同一身份', exact: true }).click(); await page.waitForFunction(id => document.querySelector('.identity-id')?.textContent === id, otherId);
  await page.getByRole('button', { name: '我已保存', exact: true }).click(); await page.getByRole('button', { name: '连接并返回', exact: true }).click(); await page.waitForURL(origin + '/app/builders'); await page.getByRole('button', { name: '新建登记', exact: true }).waitFor(); assert.equal(await page.locator('.builder-stopped-operations').count(), 0);
  events.push({ check: 'actual owner change through recovery clears the prior owner stopped list and receipt view', passed: true });
  assert.deepEqual(pageErrors, []);
} catch (error) { events.push({ failed: error.message, url: page?.url() }); if (page) await shot('failure'); throw error; }
finally { releaseOriginal(); await originalResponse?.catch(() => {}); await writeFile(resolve(out, 'report.json'), JSON.stringify({ actualBrowser: true, actualSignedHttp: true, syntheticServiceEntryBarrier: true, defaultQuotaEnforced: true, events, pageErrors }, null, 2));
  for (const context of contexts) await context.unrouteAll({ behavior: 'ignoreErrors' }); await browser.close(); await new Promise(resolve => frontend.close(resolve)); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await fixture.db.close(); }
