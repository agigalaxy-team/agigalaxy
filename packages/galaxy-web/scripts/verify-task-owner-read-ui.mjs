import { chromium } from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { createApi } from '../../galaxy-official/src/http.mjs';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';

const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
const out = fileURLToPath(new URL('../../../../../../07-logs/development/ui-resume-20261002/task-owner-read/', import.meta.url));
await mkdir(out, { recursive: true });
const fixture = await serviceFixture(browserScopes, null, { now, syntheticCommunityQuota: false });
const api = createApi({ ...fixture, browserOrigins: ['https://galaxy-ui.example.org'], rateLimit: 10000 });
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve)); const apiOrigin = `http://127.0.0.1:${api.address().port}`;
const frontend = createServer(async (request, response) => {
  try {
    if (request.url === '/galaxy-web-config.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: 1, endpoint, operator: 'Synthetic isolated owner read',
        signingKeys: [...fixture.bindings.trustedKeys].map(([kid, pin]) => ({ kid, ...pin })) })); return;
    }
    const upstream = await fetch('http://127.0.0.1:5179' + request.url);
    response.statusCode = upstream.status;
    for (const [key, value] of upstream.headers) if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key)) response.setHeader(key, value);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { response.writeHead(500); response.end('synthetic_fixture_failure'); }
});
await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${frontend.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe' });
const contexts = [], events = [], calls = [], pageErrors = [];
let page, dropConsent = false;
async function open() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  contexts.push(context); context.setDefaultTimeout(15000); await context.addInitScript(now => { Date.now = () => now * 1000; }, now);
  await context.route(endpoint + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let action;
    if (url.pathname === '/v1/consents') action = JSON.parse(Buffer.from(JSON.parse(request.postData()).signedIntent.split('.')[1], 'base64url')).action;
    calls.push({ path: url.pathname, action });
    try {
      const response = await context.request.fetch(apiOrigin + url.pathname + url.search, { method: request.method(),
        headers: { ...request.headers(), origin: 'https://galaxy-ui.example.org' }, data: request.postData() ?? undefined });
      if (dropConsent && action === 'task.owner-read') { dropConsent = false; assert.equal(response.status(), 200); await route.abort('failed'); return; }
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': origin } });
    } catch { await route.abort('failed').catch(() => {}); }
  });
  const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); return { context, page };
}
async function identity(page) {
  if (await page.getByRole('button', { name: '打开菜单', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '打开菜单', exact: true }).click(); await page.locator('.mobile-personal a[href="/app/settings/identity"]').click();
  } else { await page.locator('.personal-menu>summary').click(); await page.locator('.personal-menu a[href="/app/settings/identity"]').click(); }
  await page.getByRole('heading', { name: '身份与设置', exact: true }).waitFor();
}
async function shot(name) { await page.screenshot({ path: resolve(out, name + '.png'), fullPage: true, mask: [page.locator('textarea.recovery-code,textarea[autocomplete="off"]')] }); }
const ownerConsents = () => calls.filter(item => item.action === 'task.owner-read').length;
const bodyReads = () => calls.filter(item => item.path.endsWith('/owner-read')).length;
try {
  const source = await open(); page = source.page; await page.goto(origin + '/app/publish'); await identity(page);
  await page.getByRole('button', { name: '创建我的银河身份', exact: true }).click(); await page.getByRole('heading', { name: '当前银河身份', exact: true }).waitFor(); const subjectId = await page.locator('.identity-id').textContent();
  await page.getByRole('button', { name: '准备或更换恢复码', exact: true }).click(); const codeField = page.getByRole('textbox', { name: '新的恢复码', exact: true }); await codeField.waitFor(); const recoveryCode = await codeField.inputValue();
  await page.getByRole('button', { name: '我已保存', exact: true }).click(); await page.getByRole('button', { name: '连接并返回', exact: true }).click(); await page.waitForURL(origin + '/app/publish');
  const title = '恢复同一身份后读取本人原请求', summary = '合成保留内容：只通过精确的新本人读取授权披露。';
  await page.getByLabel('目标（用一句话说明）', { exact: true }).fill(title); await page.getByLabel('说说需要什么帮助', { exact: true }).fill(summary);
  await page.getByRole('button', { name: '下一步：协助与范围', exact: true }).click(); await page.getByRole('combobox', { name: /可见范围/ }).selectOption('Private');
  await page.getByRole('button', { name: '预览这份请求', exact: true }).click(); await page.getByRole('button', { name: '确认并发布这份任务', exact: true }).click(); await page.waitForURL(/\/app\/tasks\/[0-9a-f-]{36}$/);
  const target = page.url() + '?section=collaboration#original-help', taskId = new URL(target).pathname.split('/').at(-1);
  const recovered = await open(); page = recovered.page; await page.setViewportSize({ width: 390, height: 844 }); await page.goto(target); await identity(page);
  await page.getByRole('button', { name: '用恢复码接续', exact: true }).click(); await page.locator('#recover-existing textarea').fill(recoveryCode); await page.getByRole('button', { name: '确认恢复同一身份', exact: true }).click();
  await page.getByRole('heading', { name: '当前银河身份', exact: true }).waitFor(); assert.equal(await page.locator('.identity-id').textContent(), subjectId);
  await page.getByRole('button', { name: '我已保存', exact: true }).click(); await page.getByRole('button', { name: '连接并返回', exact: true }).click(); await page.waitForURL(target);
  await page.getByRole('heading', { name: '当前任务暂未读到。', exact: true }).waitFor(); await page.getByText('consent_required', { exact: true }).waitFor();
  const area = page.locator('.task-owner-read'); await area.getByRole('button', { name: '核对可读取的本人记录范围', exact: true }).waitFor(); assert.equal(ownerConsents(), 0); assert.equal(bodyReads(), 0);
  events.push({ check: 'independent browser really recovers same identity, saves replacement, returns exact original Task URL and preserves original denied-GET status', passed: true });
  await area.getByRole('button', { name: '核对可读取的本人记录范围', exact: true }).click(); await area.getByRole('button', { name: '授权读取所列本人记录', exact: true }).waitFor();
  assert.equal(ownerConsents(), 0); assert.equal(bodyReads(), 0); assert.equal(await area.getByText(summary, { exact: true }).count(), 0);
  await area.getByRole('button', { name: '暂不读取', exact: true }).click(); assert.equal(ownerConsents(), 0); assert.equal(bodyReads(), 0);
  events.push({ check: 'metadata-only preview exposes no original body; cancellation sends no Consent and does not read', passed: true });
  await area.getByRole('button', { name: '核对可读取的本人记录范围', exact: true }).click(); await area.getByRole('button', { name: '授权读取所列本人记录', exact: true }).waitFor(); await shot('owner-read-preview-narrow');
  dropConsent = true; await area.getByRole('button', { name: '授权读取所列本人记录', exact: true }).click(); await area.getByRole('alert').waitFor(); assert.equal(ownerConsents(), 1); assert.equal(bodyReads(), 0);
  await area.getByRole('button', { name: '核对原授权并读取所列本人记录', exact: true }).click(); await area.getByRole('heading', { name: '已读取 1 项本人保留记录', exact: true }).waitFor();
  assert.equal(ownerConsents(), 1); assert.equal(bodyReads(), 1); assert.equal(await area.getByRole('heading', { name: title, exact: true }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: '当前任务暂未读到。', exact: true }).count(), 1); await page.getByText('consent_required', { exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '参与与交付', exact: true }).count(), 0); assert.equal(page.url(), target);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot('owner-read-partial-result-narrow');
  events.push({ check: 'accepted Consent with lost ACK reconciles original authorization without duplicate Consent; exact original root body appears only in partial owner panel, never full Task/write UI', passed: true });
  const sourceConsent = (await fixture.db.query('SELECT consent_id FROM task_events WHERE task_id=$1 ORDER BY version LIMIT 1', [taskId])).rows[0].consent_id;
  await fixture.db.query('UPDATE consents SET revoked_at=$2 WHERE id=$1', [sourceConsent, new Date(now * 1000).toISOString()]);
  await area.getByRole('button', { name: '核对可读取的本人记录范围', exact: true }).click(); await area.getByText('原授权已失效、正文已不再保留，或这项来源不符合恢复后本人读取条件。请保留原任务地址。', { exact: true }).waitFor();
  assert.equal(await area.getByRole('heading', { name: title, exact: true }).count(), 0); assert.equal(ownerConsents(), 1); assert.equal(bodyReads(), 1); await shot('owner-read-source-unavailable-narrow');
  events.push({ check: 'explicit fresh review after source revocation drops the displayed old body and honestly fails without signing or further body read', passed: true, syntheticFaultInjection: 'exact original Consent revoked in isolated fixture database' });
  assert.deepEqual(pageErrors, []);
} catch (error) { events.push({ failed: error.message, url: page?.url() }); if (page) await shot('failure'); throw error; }
finally {
  await writeFile(resolve(out, 'ui-report.json'), JSON.stringify({ actualBrowser: true, actualSignedHttp: true, noQuotaBypass: true,
    syntheticIdentitiesOnly: true, noRecoveryCodesInEvidence: true, events, pageErrors }, null, 2));
  for (const context of contexts) await context.unrouteAll({ behavior: 'ignoreErrors' });
  await browser.close(); await new Promise(resolve => frontend.close(resolve)); await new Promise(resolve => api.close(resolve)); await fixture.db.close();
}
