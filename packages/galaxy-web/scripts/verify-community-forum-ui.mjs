import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { chromium, browserToolOutput, requiredToolInput, loadToolMcpClient } from './browser-tool-runtime.mjs';

const repo = resolve(process.env.GALAXY_FORUM_SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)));
const dist = resolve(process.env.GALAXY_FORUM_DIST ?? join(repo, 'packages/galaxy-web/dist'));
const out = browserToolOutput(import.meta.url, process.env.GALAXY_FORUM_REPORT);
const website = 'https://forum-flow.example', endpoint = 'https://official.example.org', issuerAlias = 'https://isolated-oidc.example';
const nativeCandidate = requiredToolInput('GALAXY_NATIVE_CANDIDATE_DIR');
const nativeScopes = ['binding', 'consent', 'case-teaser', 'history', 'assistance', 'context'];
const load = path => import(pathToFileURL(join(repo, path)));
const [{ serviceFixture }, { createApi }, { browserScopes }, { oidcProviderFixture }, { createOidcLoginProvider }] = await Promise.all([
  load('packages/galaxy-official/test/service-fixture.mjs'), load('packages/galaxy-official/src/http.mjs'),
  load('packages/galaxy-official/src/browser-client.mjs'), load('packages/galaxy-official/test/oidc-provider-fixture.mjs'),
  load("packages/galaxy-official/src/identity/authentication/oidc-login.mjs")
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const files = [fileURLToPath(import.meta.url)];
async function sourceTree(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await sourceTree(path); else if (entry.isFile()) files.push(path); } }
await sourceTree(join(repo, 'packages/galaxy-official/src'));
await sourceTree(join(repo, 'packages/galaxy-core/src'));
for (const name of ['features/community-forum/community-forum-client.mjs', 'features/community-forum/community-forum-workspace.tsx', 'features/community-forum/community-forum-origin.mjs', 'runtime.mjs', 'main.tsx','standalone-galaxy.tsx','application/galaxy-session.tsx','application/galaxy-pages.tsx','application/galaxy-shell.tsx', 'site-shell.tsx', 'features/tasks/publish/task-publish-workspace.tsx', 'workspace.css'])
  files.push(join(repo, 'packages/galaxy-web/src', name));
for (const name of ['package.json', 'package-lock.json', 'packages/galaxy-official/test/service-fixture.mjs', 'packages/galaxy-official/test/oidc-provider-fixture.mjs']) files.push(join(repo, name));
for (const name of (await readdir(nativeCandidate)).filter(name => /\.(?:[cm]?js|json)$/.test(name))) files.push(join(nativeCandidate, name));
const html = await readFile(join(dist, 'index.html'), 'utf8');
files.push(join(dist, 'index.html'), ...[...html.matchAll(/(?:src|href)="\/app\/(assets\/[^"?]+)"/g)].map(match => join(dist, match[1])));
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, sha(await readFile(path))])));
const report = { startedAt: new Date().toISOString(), dist, sourceBefore: await hashes(), checks: [], apiCalls: [], pageErrors: [], boundary: {
  actualProductionMain: true, actualWebCryptoIndexedDB: true, actualHttpPGlite: true, syntheticCommunityQuota: false,
  actualOidcCodePkceIdToken: true, externalAccountsSynthetic: true, productionProviderOrRealPerson: false, modelCalls: 0,
  fixtureRoleConfiguration: 'The configured moderator GUID is established through actual ordinary browser registration. Configuration identifies the synthetic handler; no verified Account, event, role evidence or source content is inserted into SQL.',
  controlledInterleavings: 'A test-only React DevTools hook observes existing production runtime/client and first commits. HTTP delays, lost acknowledgments and 503s are explicit transport faults. New locator-derivation tests delay an actual WebCrypto digest result without changing its bytes. No replacement business response or mock component is used.',
  taskOriginBoundary: 'Forum locators are body-free local return records. Formal Task creation still uses existing Agent continuity and actual Task publication.'
} };
const contexts = [], loopbackOrigins = new Set(), opened = [], publicConnectionRequests = new Map();
const receiptBlocked = new Set();
let fixture, api, issuer, browser, failure, lastPage, hold = null, dropWrite = null, rejectWrite = null, dropTaskActor = null;
let native, nativeServer, nativeClient, nativeDirectory;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const stage = value => { report.stage = value; process.stdout.write(value + '\n'); };
const pass = (id, data = {}) => { report.checks.push({ id, passed: true, ...data }); };
const button = (page, name) => page.getByRole('button', { name, exact: true });
const editor = page => page.getByRole('region', { name: '社区本机稿', exact: true });
const forum = page => page.locator('.forum-workspace');
const state = page => page.evaluate(async () => { const value = await window.__forumProbe.runtime.status(); return { identity: value.identity, connection: value.connection ? { subjectId: value.connection.subjectId, bindingId: value.connection.bindingId, generation: value.connection.generation, scopes: value.connection.scopes } : null }; });
const journal = (page, subject = null) => page.evaluate(async subject => { const runtime = window.__forumProbe.runtime, id = subject ?? (await runtime.status()).identity.subjectId; return runtime.getLocal('community-forum:' + runtime.api.endpoint + ':' + id, id); }, subject);
const writes = actor => report.apiCalls.filter(row => row.actor === actor && row.method === 'POST' && /^\/v2\/community\/(?:posts|versions|replies)$/.test(row.path)).length;
const screenshot = async (page, name) => {
  lastPage = page;
  await page.locator('.site-app-footer').waitFor({ state: 'visible' });
  if (await forum(page).count()) await page.waitForFunction(() => document.querySelector('.forum-workspace')?.getAttribute('aria-busy') === 'false');
  await page.evaluate(async () => { document.activeElement?.blur(); scrollTo(0, 0); await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'horizontal overflow');
  await page.screenshot({ path: join(out, name + '.png'), fullPage: true });
};
try {
  await mkdir(out, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'], { emailVerified: true });
  const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Isolated OIDC', issuer: issuer.issuer, clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true, now: () => now });
  fixture = await serviceFixture(browserScopes, null, { now, identityProviders: [provider], syntheticCommunityQuota: false });
  api = createApi({ ...fixture, browserOrigins: [website], rateLimit: 10000 });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + api.address().port;
  browser = await chromium.launch({ headless: true });

  async function makePage(name, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    contexts.push(context); context.setDefaultTimeout(20000);
    context.on('page', page => page.on('pageerror', error => report.pageErrors.push({ actor: name, message: error.message })));
    await context.addInitScript(now => { Date.now = () => now * 1000; }, now);
    await context.addInitScript(() => {
      const probe = { runtime: null, rendered: null, client: null, commits: [], watchText: '__NO_FORUM_PRIVATE_MARKER__' };
      window.__forumProbe = probe;
      const observe = root => {
        const visit = fiber => { if (!fiber) return; let hook = fiber.memoizedState, count = 0;
          while (hook && count++ < 100) {
            const value = hook.memoizedState;
            if (value && typeof value.status === 'function' && typeof value.createIdentity === 'function' && value.api) probe.runtime = value;
            const candidate = Array.isArray(value) ? value[0] : value;
            if (candidate && typeof candidate.ownPost === 'function' && typeof candidate.stopLocalRetry === 'function') probe.client = candidate;
            if (value && Object.hasOwn(value, 'identity') && Object.hasOwn(value, 'connection') && typeof value.endpoint === 'string')
              probe.rendered = { subjectId: value.identity?.subjectId ?? null, bindingId: value.connection?.bindingId ?? null, generation: value.connection?.generation ?? null };
            hook = hook.next;
          }
          visit(fiber.child); visit(fiber.sibling);
        };
        visit(root.current);
        if (probe.rendered) {
          const body = document.body?.textContent ?? '', fields = [...document.querySelectorAll('.forum-workspace input,.forum-workspace textarea')];
          probe.commits.push({ ...probe.rendered, oldPrivateText: body.includes(probe.watchText), oldPrivateEditor: fields.some(field => field.value.includes(probe.watchText)), retryConfirm: body.includes('确认继续这项原操作'), forumAlert: document.querySelector('.forum-workspace [role="alert"]')?.textContent ?? '' });
        }
      };
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberRoot: (_id, root) => observe(root), onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {}, checkDCE: () => {} };
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === website) {
        if (url.pathname === '/galaxy-web-config.json') return route.fulfill({ json: { version: 1, endpoint, operator: 'Isolated forum flow', signingKeys: [...fixture.bindings.trustedKeys].map(([kid, pin]) => ({ kid, ...pin })) } });
        const path = url.pathname.startsWith('/app/assets/') ? resolve(dist, 'assets', url.pathname.slice('/app/assets/'.length)) : resolve(dist, 'index.html');
        assert.ok(path === resolve(dist, 'index.html') || path.startsWith(resolve(dist, 'assets') + sep));
        return route.fulfill({ body: await readFile(path), contentType: extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html; charset=utf-8' });
      }
      if (url.origin === issuerAlias) {
        const callback = await issuer.authorize(issuer.issuer + url.pathname + url.search), response = await fetch(base + callback.pathname + callback.search), value = await response.json();
        report.apiCalls.push({ actor: name, method: 'GET', path: callback.pathname, status: response.status, state: value.state });
        assert.equal(response.status, 200); assert.equal(value.state, 'awaiting-local-signature');
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><p>Isolated OIDC completed; return for local confirmation.</p>' });
      }
      if (url.origin === endpoint) {
        const cors = { 'access-control-allow-origin': website };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
        const row = { actor: name, method: request.method(), path: url.pathname, authenticated: !!request.headers().authorization }; report.apiCalls.push(row);
        if (url.pathname === '/v2/binding-challenges') publicConnectionRequests.set(name, JSON.parse(request.postData()));
        if (receiptBlocked.has(name) && url.pathname === '/v2/community/receipt') { row.status = 503; row.error = 'synthetic_receipt_unavailable'; return route.fulfill({ status: 503, json: { error: row.error }, headers: cors }); }
        if (rejectWrite === name && url.pathname === '/v2/community/posts' && request.method() === 'POST') { row.status = 503; row.error = 'synthetic_before_business'; return route.fulfill({ status: 503, json: { error: row.error }, headers: cors }); }
        const response = await fetch(base + url.pathname + url.search, { method: request.method(), headers: { ...request.headers(), origin: website }, body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postData() });
        row.status = response.status; let body = await response.text();
        if (response.status >= 400) { try { row.error = JSON.parse(body).error; } catch {} }
        if (url.pathname === '/v1/identity/begin' && response.status === 200) { const value = JSON.parse(body), original = new URL(value.authorizationUrl); value.authorizationUrl = issuerAlias + original.pathname + original.search; body = JSON.stringify(value); }
        if (dropWrite === name && url.pathname === '/v2/community/posts' && response.status === 200) { dropWrite = null; row.responseDropped = true; return route.abort('connectionreset'); }
        if (dropTaskActor === name && url.pathname === '/v2/tasks' && request.method() === 'POST' && response.status === 200) { dropTaskActor = null; row.responseDropped = true; return route.abort('connectionreset'); }
        if (hold && hold.actor === name && hold.path === url.pathname && !hold.used) { const gate = hold; gate.used = true; row.delayed = true; gate.seen.resolve(); await gate.release.promise; row.released = true; }
        return route.fulfill({ status: response.status, body, contentType: response.headers.get('content-type') ?? 'application/json', headers: cors });
      }
      if (loopbackOrigins.has(url.origin)) return route.continue();
      return route.abort();
    });
    const page = await context.newPage(); lastPage = page;
    return { page, context, name };
  }
  async function createOrdinary(actor, target = '/app/community') {
    const { page } = actor; lastPage = page;
    await page.goto(website + target); await page.waitForFunction(() => !!window.__forumProbe?.runtime);
    if (await button(page, '打开菜单').isVisible()) await button(page, '打开菜单').click(); else await page.getByLabel('登录与账号', { exact: true }).click();
    await page.getByRole('link', { name: '登录 / 开始使用', exact: true }).click();
    await button(page, '创建我的银河身份').click(); await page.getByRole('heading', { name: '当前银河身份', exact: true }).waitFor();
    await button(page, '连接并返回').click(); await page.waitForURL(website + target);
    const value = await state(page); assert.ok(value.identity && value.connection); return value;
  }
  async function account(actor, returnUrl = actor.page.url()) {
    const { page } = actor; issuer.setAccount('synthetic-forum-' + actor.name);
    if (await button(page, '前往账号验证').count()) await button(page, '前往账号验证').first().click();
    else {
      if (await button(page, '打开菜单').isVisible()) await button(page, '打开菜单').click(); else await page.getByLabel('我的账号', { exact: true }).click();
      await page.getByRole('link', { name: '账号与设置', exact: true }).click();
      await page.getByRole('navigation', { name: '账号设置分组' }).getByRole('link', { name: '账号验证', exact: true }).click();
    }
    await button(page, '使用 Isolated OIDC 验证').click();
    const popupReady = page.waitForEvent('popup'); await page.getByRole('link', { name: '打开账号验证页 ↗', exact: true }).click();
    const popup = await popupReady; await popup.getByText('Isolated OIDC completed; return for local confirmation.', { exact: true }).waitFor(); await popup.close();
    await button(page, '我已完成登录，查询结果').click(); await button(page, '确认关联这个账号').click();
    await page.getByText('账号关联已记录 · 关联状态与公开操作资格分别核对。', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.__forumProbe.runtime.accounts.quotas())).accountVerified, true);
    await button(page, '回到原目标').click(); await page.waitForURL(returnUrl);
  }
  async function writePost(actor, title, body) {
    const page = actor.page;
    if (new URL(page.url()).searchParams.get('compose') === 'post') await page.getByLabel('标题', { exact: true }).waitFor();
    else if (!await page.getByLabel('标题', { exact: true }).count()) await button(page, '写帖子').click();
    await page.getByLabel('标题', { exact: true }).fill(title); await page.getByLabel('正文', { exact: true }).fill(body);
    await page.waitForFunction(_text => document.querySelector('.forum-editor [role="status"]')?.textContent === '已保存到此浏览器。', body);
  }
  async function publish(page) { const before = page.url(); await button(page, '公开发表').click(); await page.waitForURL(url => url.href !== before && /^\/app\/community\/(?:posts\/[^/]+\/versions\/[^/]+|replies\/[^/]+)$/.test(url.pathname)); }
  async function connectCurrent(page) {
    if ((await state(page)).connection) return;
    const target = page.url();
    if (await button(page, '打开菜单').isVisible()) await button(page, '打开菜单').click(); else await page.getByLabel('登录与账号', { exact: true }).click();
    await page.getByRole('link', { name: '连接已有身份', exact: true }).click();
    await button(page, '连接并返回').click(); await page.waitForURL(target);
  }
  async function go(page, path) {
    lastPage = page;
    const wasConnected = await page.evaluate(() => !!window.__forumProbe?.runtime?.api.snapshot()).catch(() => false);
    await page.goto(website + path); await page.waitForFunction(() => !!window.__forumProbe?.client);
    if (wasConnected) await connectCurrent(page);
  }
  async function readyDraft(page, body, context = 'feed') {
    await page.waitForFunction(async ({ body, context }) => { const runtime = window.__forumProbe.runtime, id = (await runtime.status()).identity.subjectId, value = await runtime.getLocal('community-forum:' + runtime.api.endpoint + ':' + id, id); return value?.drafts?.[context]?.body === body; }, { body, context });
  }
  async function holdActualDigest(page, marker) {
    await page.evaluate(marker => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      const gate = { seen: false, released: false, original, release: null };
      const waiting = new Promise(resolve => { gate.release = resolve; });
      window.__forumDigestGate = gate;
      crypto.subtle.digest = async function (algorithm, input) {
        const result = await original.call(this, algorithm, input);
        if (!gate.seen && new TextDecoder().decode(input).includes(marker)) {
          gate.seen = true; await waiting;
        }
        return result;
      };
    }, marker);
  }
  async function releaseActualDigest(page) {
    await page.evaluate(() => {
      const gate = window.__forumDigestGate;
      if (!gate?.seen) throw Error('The actual WebCrypto result was not held.');
      crypto.subtle.digest = gate.original; gate.released = true; gate.release();
    });
  }

  stage('anonymous-production-community');
  const R = await makePage('anonymous'); await go(R.page, '/app/community');
  await R.page.getByRole('heading', { name: '社区', exact: true }).waitFor();
  assert.equal(report.apiCalls.filter(row => row.actor === R.name && row.path.startsWith('/v2/community/') && row.authenticated).length, 0);
  pass('anonymous-community-feed-needs-no-registration-agent-account-or-model');

  stage('ordinary-author-draft-account-publication');
  const A = await makePage('author-A'); const initialA = await createOrdinary(A, '/app/community?compose=post');
  const firstTitle = '第一次分享：一个普通网页想法', firstBody = 'PUBLIC_FORUM_VERSION_ONE_20261008 — 这是一段由普通浏览器用户独立填写的真实测试文字。';
  await writePost(A, firstTitle, firstBody); await readyDraft(A.page, firstBody);
  const savedA = await journal(A.page), beforeA = writes(A.name); await account(A);
  await A.page.getByLabel('正文', { exact: true }).waitFor(); assert.equal(await A.page.getByLabel('正文', { exact: true }).inputValue(), firstBody);
  assert.deepEqual((await journal(A.page)).drafts, savedA.drafts); assert.equal(writes(A.name), beforeA);
  await screenshot(A.page, '01-desktop-ready-ordinary-post');
  await publish(A.page); await A.page.getByRole('heading', { name: firstTitle, exact: true }).waitFor();
  const v1Path = new URL(A.page.url()).pathname, [, , , , postId, , version1] = v1Path.split('/');
  assert.equal(writes(A.name), beforeA + 1); assert.equal((await journal(A.page)).drafts.feed, undefined);
  assert.equal((await state(A.page)).identity.subjectId, initialA.identity.subjectId);
  pass('ordinary-browser-create-identity-account-local-signature-draft-return-single-publication', { subjectId: initialA.identity.subjectId, path: v1Path, businessPosts: 1, agentRequired: false });
  await go(R.page, v1Path); await R.page.getByText(firstBody, { exact: true }).waitFor(); await screenshot(R.page, '02-anonymous-exact-version');

  stage('mobile-independent-reply-account-return');
  const B = await makePage('reader-B', { width: 390, height: 844 }); await createOrdinary(B, v1Path);
  await button(B.page, '回复这一版').click(); const replyBody = 'INDEPENDENT_REPLY_V1 — 这条回复只描述我自己的观点。';
  await B.page.getByLabel('回复内容', { exact: true }).fill(replyBody); await readyDraft(B.page, replyBody, 'post:' + postId);
  const savedB = await journal(B.page); await account(B); assert.deepEqual((await journal(B.page)).drafts, savedB.drafts);
  await B.page.getByLabel('回复内容', { exact: true }).waitFor(); await screenshot(B.page, '03-mobile-reply-before-submit'); await publish(B.page);
  const replyPath = new URL(B.page.url()).pathname, replyId = replyPath.split('/').at(-1);
  await B.page.getByText(replyBody, { exact: true }).waitFor();
  pass('390px-ordinary-independent-reply-exact-version-account-roundtrip', { replyId, postId, version1, noHorizontalOverflow: true, agentRequired: false });

  stage('version-publication-and-exact-old-reply');
  await go(A.page, v1Path); await button(A.page, '以此版准备更新').click();
  const secondTitle = '同一想法的第二版', secondBody = 'PUBLIC_FORUM_VERSION_TWO_20261008 — 更新后的独立版本。';
  await A.page.getByLabel('标题', { exact: true }).fill(secondTitle); await A.page.getByLabel('正文', { exact: true }).fill(secondBody); await publish(A.page);
  const v2Path = new URL(A.page.url()).pathname, version2 = v2Path.split('/').at(-1); assert.notEqual(version1, version2);
  await go(R.page, v1Path); await R.page.getByText(firstBody, { exact: true }).waitFor(); await R.page.getByText(replyBody, { exact: true }).waitFor();
  await go(A.page, v1Path); await A.page.locator('.forum-owner-actions summary').click(); await button(A.page, '撤回这一版').click(); await button(A.page, '确认撤回').click();
  await A.page.getByText(/^此内容已撤回。/).first().waitFor(); assert.equal(await A.page.getByText(firstBody, { exact: true }).count(), 0);
  await go(R.page, replyPath); await R.page.getByText(replyBody, { exact: true }).waitFor(); assert.equal(await R.page.getByText(firstBody, { exact: true }).count(), 0);
  await screenshot(R.page, '04-independent-reply-after-parent-withdrawal');
  await go(R.page, v2Path); await R.page.getByText(secondBody, { exact: true }).waitFor();
  pass('new-version-does-not-move-old-reply-and-parent-withdrawal-withholds-only-parent-body', { postId, version1, version2, replyId });

  stage('forum-task-draft-locator-only-preservation');
  const ownTaskDraft = { title: 'MY_EXISTING_TASK_DRAFT', summary: 'PRIVATE_OWN_TASK_INPUT_STAYS_LOCAL' };
  await A.page.evaluate(async value => { await window.__forumProbe.runtime.putLocal('task-draft', value); }, ownTaskDraft);
  await go(A.page, v2Path); await button(A.page, '为这件事准备任务').click();
  await A.page.getByLabel('目标（用一句话说明）', { exact: true }).waitFor(); assert.equal(await A.page.getByLabel('目标（用一句话说明）', { exact: true }).inputValue(), ownTaskDraft.title);
  assert.deepEqual(await A.page.evaluate(() => window.__forumProbe.runtime.getLocal('task-draft')), ownTaskDraft);
  assert.equal(await A.page.getByText(secondBody, { exact: true }).count(), 0);
  await screenshot(A.page, '05-forum-locator-keeps-own-task-draft');
  await button(A.page, '保留草稿，返回原帖子').click(); await A.page.waitForURL(website + v2Path);
  pass('optional-task-preparation-body-free-locator-preserves-existing-task-input', { returnTo: v2Path, sourceBodyCopied: false });

  stage('private-governance-actual-roles');
  const M = await makePage('configured-moderator'); const initialM = await createOrdinary(M);
  fixture.forumGovernance.moderatorIds = [initialM.identity.subjectId];
  await go(B.page, v2Path); await button(B.page, '私有举报').first().click();
  const privateReport = 'PRIVATE_REPORTER_NARRATIVE_ONLY_HANDLERS_20261008';
  await B.page.getByLabel('我的说明', { exact: true }).fill(privateReport); await button(B.page, '提交私有举报').click();
  await B.page.waitForURL(url => /^\/app\/community\/reports\/[^/]+$/.test(url.pathname));
  const reportPath = new URL(B.page.url()).pathname, reportId = reportPath.split('/').at(-1);
  await B.page.getByText(privateReport, { exact: true }).waitFor(); await screenshot(B.page, '06-mobile-private-report');
  await go(A.page, reportPath); await A.page.getByRole('heading', { name: '当前处理记录', exact: true }).waitFor(); assert.equal(await A.page.getByText(privateReport, { exact: true }).count(), 0); assert.equal(await button(A.page, '记录处理决定').count(), 0);
  await go(M.page, reportPath); await M.page.getByText(privateReport, { exact: true }).waitFor();
  const moderationScopes = ['binding', 'consent', 'moderation'];
  await M.page.evaluate(async ({ request, scopes }) => { await window.__forumProbe.runtime.api.connect({ ...request, scopes }, { confirmed: true }); document.dispatchEvent(new Event('visibilitychange')); }, { request: publicConnectionRequests.get(M.name), scopes: moderationScopes });
  await M.page.waitForFunction(() => window.__forumProbe.rendered?.bindingId === window.__forumProbe.runtime.api.snapshot()?.bindingId);
  assert.deepEqual((await state(M.page)).connection.scopes, moderationScopes);
  await button(M.page, '记录处理决定').click();
  const decisionReason = 'INDEPENDENT_HANDLER_REASON_20261008';
  await M.page.getByLabel('我的处理理由', { exact: true }).fill(decisionReason); await M.page.getByLabel('处理结果', { exact: true }).selectOption('accepted');
  await M.page.getByLabel('暂时停止目标内容读取', { exact: true }).check();
  await M.page.getByLabel('期望最长时数', { exact: true }).fill(''); await M.page.getByLabel('期望最长时数', { exact: true }).fill('2');
  await button(M.page, '提交私有记录').click();
  await M.page.getByText(decisionReason, { exact: true }).waitFor();
  await go(A.page, reportPath); await A.page.getByText(decisionReason, { exact: true }).waitFor(); assert.equal(await A.page.getByText(privateReport, { exact: true }).count(), 0);
  await button(A.page, '提交申诉').click(); const appealReason = 'AFFECTED_AUTHOR_OWN_APPEAL_20261008'; await A.page.getByLabel('我的申诉说明', { exact: true }).fill(appealReason);
  await editor(A.page).getByRole('button', { name: '提交申诉', exact: true }).click(); await A.page.locator('.forum-report .forum-prose').filter({ hasText: appealReason }).waitFor();
  await screenshot(A.page, '07-affected-author-decision-and-own-appeal');
  await go(R.page, v2Path); await R.page.getByText(/^此内容当前不可读。/).first().waitFor(); assert.equal(await R.page.getByText(secondBody, { exact: true }).count(), 0);
  await go(B.page, reportPath); await button(B.page, '撤回我的举报').click(); await button(B.page, '确认撤回').click();
  await B.page.getByText('原撤回操作已确认。当前内容按最新状态读取。', { exact: true }).waitFor(); await B.page.getByText(privateReport, { exact: true }).waitFor({ state: 'detached' });
  await B.page.getByText(decisionReason, { exact: true }).waitFor(); assert.equal(await B.page.getByText(privateReport, { exact: true }).count(), 0);
  pass('private-report-independent-decision-affected-party-own-appeal-and-reporter-withdrawal', { reportId, configuredModerator: initialM.identity.subjectId, reporterNarrativeWithheldFromTarget: true, appealDoesNotRestoreSource: true });

  stage('unavailable-source-task-can-exit-with-own-input');
  const taskQuery = '?forumPost=' + postId + '&forumVersion=' + version2 + '&forumReturn=' + encodeURIComponent(v2Path);
  await A.page.goto(website + '/app/publish' + taskQuery); await A.page.getByText(/原帖当前不可读，仍保留准确位置/).waitFor();
  assert.equal(await A.page.getByLabel(/^说说需要什么帮助/).inputValue(), ownTaskDraft.summary);
  await button(A.page, '保留草稿，返回原帖子').click(); await A.page.waitForURL(website + v2Path);
  pass('unavailable-forum-source-keeps-exit-and-own-task-input-with-no-source-body');

  stage('asynchronous-locator-derivation-draft-cas-and-clear');
  const D = await makePage('locator-derivation'); const initialD = await createOrdinary(D);
  await writePost(D, '异步定位计算中的本机稿', 'ASYNC_LOCATOR_ORIGINAL_DRAFT'); await account(D); await readyDraft(D.page, 'ASYNC_LOCATOR_ORIGINAL_DRAFT');
  const beforePreparedOnly = await journal(D.page), beforePreparedWrites = writes(D.name);
  const preparedOnly = await D.page.evaluate(async () => {
    const client = window.__forumProbe.client;
    const input = { schemaVersion: 1, operationId: crypto.randomUUID(), postId: crypto.randomUUID(), expectedHeadVersion: 0, versionId: crypto.randomUUID(), title: 'Prepare exact locator only', body: 'PREPARE_ONLY_NO_BUSINESS_WRITE', links: ['https://example.org/own-link'], publishedUntil: Math.floor(Date.now() / 1000) + 3600 };
    const original = structuredClone(input), first = await client.prepare('create-post', input), repeated = await client.prepare('create-post', input);
    const changedBody = await client.prepare('create-post', { ...input, body: input.body + ' changed' });
    const changedDeadline = await client.prepare('create-post', { ...input, publishedUntil: input.publishedUntil + 1 });
    const changedOperation = await client.prepare('create-post', { ...input, operationId: crypto.randomUUID() });
    window.__forumPreparedOnly = { input: original, payload: first.payload, payloadHash: first.payloadHash };
    return { original, input, first, repeated, changedBody, changedDeadline, changedOperation };
  });
  assert.deepEqual(preparedOnly.input, preparedOnly.original); assert.deepEqual(preparedOnly.first, preparedOnly.repeated);
  for (const value of [preparedOnly.first, preparedOnly.changedBody, preparedOnly.changedDeadline, preparedOnly.changedOperation]) {
    assert.match(value.payload.postId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(value.payload.versionId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  for (const value of [preparedOnly.changedBody, preparedOnly.changedDeadline, preparedOnly.changedOperation]) {
    assert.notEqual(value.payload.postId, preparedOnly.first.payload.postId); assert.notEqual(value.payload.versionId, preparedOnly.first.payload.versionId);
  }
  assert.deepEqual(await journal(D.page), beforePreparedOnly); assert.equal(writes(D.name), beforePreparedWrites);
  pass('new-preparation-deterministic-derived-locators-input-unchanged-and-no-business-write', { payloadHash: preparedOnly.first.payloadHash, postId: preparedOnly.first.payload.postId, versionId: preparedOnly.first.payload.versionId, changedBodyDeadlineOperationHaveDistinctIds: true, businessWrites: 0 });
  const derivationSibling = await D.context.newPage(); await derivationSibling.goto(website + '/app/community');
  await derivationSibling.waitForFunction(() => !!window.__forumProbe?.runtime);
  await derivationSibling.evaluate(async () => { await window.__forumProbe.runtime.connect({ confirmed: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await derivationSibling.getByLabel('正文', { exact: true }).waitFor();
  const beforeDerivationWrites = writes(D.name);
  await holdActualDigest(D.page, 'ASYNC_LOCATOR_ORIGINAL_DRAFT'); await button(D.page, '公开发表').click();
  await D.page.waitForFunction(() => window.__forumDigestGate?.seen);
  await derivationSibling.getByLabel('正文', { exact: true }).fill('ASYNC_LOCATOR_NEWER_TAB_DRAFT'); await readyDraft(derivationSibling, 'ASYNC_LOCATOR_NEWER_TAB_DRAFT');
  const derivationNewer = (await journal(derivationSibling)).drafts.feed;
  await releaseActualDigest(D.page); await forum(D.page).getByRole('alert').waitFor();
  await D.page.waitForFunction(() => document.querySelector('.forum-workspace')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual((await journal(D.page)).drafts.feed, derivationNewer); assert.equal((await journal(D.page)).active, null); assert.equal(writes(D.name), beforeDerivationWrites);
  assert.equal(await D.page.getByLabel('正文', { exact: true }).inputValue(), 'ASYNC_LOCATOR_NEWER_TAB_DRAFT');
  await holdActualDigest(D.page, 'ASYNC_LOCATOR_NEWER_TAB_DRAFT'); await button(D.page, '公开发表').click();
  await D.page.waitForFunction(() => window.__forumDigestGate?.seen);
  await button(derivationSibling, '取消编辑').click(); await derivationSibling.getByLabel('正文', { exact: true }).waitFor({ state: 'detached' });
  await releaseActualDigest(D.page); await D.page.getByLabel('正文', { exact: true }).waitFor({ state: 'detached' });
  await D.page.waitForFunction(() => document.querySelector('.forum-workspace')?.getAttribute('aria-busy') === 'false');
  assert.equal((await journal(D.page)).drafts.feed ?? null, null); assert.equal((await journal(D.page)).active, null); assert.equal(writes(D.name), beforeDerivationWrites);
  pass('actual-webcrypto-locator-derivation-other-tab-edit-and-clear-null-prevent-stale-execution', { actualDigestResultDelayed: true, changedDraftPreserved: true, clearedDraftStayedNull: true, businessWrites: 0 });

  stage('asynchronous-locator-derivation-binding-change');
  await writePost(D, '计算期间保留本人的新稿', 'ASYNC_LOCATOR_SAME_GUID_NEW_BINDING'); await readyDraft(D.page, 'ASYNC_LOCATOR_SAME_GUID_NEW_BINDING');
  const beforeBindingDraft = (await journal(D.page)).drafts.feed;
  await D.page.evaluate(() => { window.__forumProbe.watchText = 'ASYNC_LOCATOR_SAME_GUID_NEW_BINDING'; window.__forumProbe.commits = []; });
  await holdActualDigest(D.page, 'ASYNC_LOCATOR_SAME_GUID_NEW_BINDING'); await button(D.page, '公开发表').click();
  await D.page.waitForFunction(() => window.__forumDigestGate?.seen);
  const duringDigestBinding = await D.page.evaluate(async () => { await window.__forumProbe.runtime.connect({ confirmed: true }); const value = await window.__forumProbe.runtime.status(); document.dispatchEvent(new Event('visibilitychange')); return value.connection.bindingId; });
  await D.page.waitForFunction(binding => window.__forumProbe.rendered?.bindingId === binding, duringDigestBinding);
  const firstDigestBinding = await D.page.evaluate(binding => window.__forumProbe.commits.find(value => value.bindingId === binding), duringDigestBinding);
  assert.equal(firstDigestBinding.oldPrivateText, false); assert.equal(firstDigestBinding.oldPrivateEditor, false); assert.equal(firstDigestBinding.retryConfirm, false);
  await releaseActualDigest(D.page); await D.page.getByLabel('正文', { exact: true }).waitFor();
  assert.deepEqual((await journal(D.page)).drafts.feed, beforeBindingDraft); assert.equal((await journal(D.page)).active, null); assert.equal(writes(D.name), beforeDerivationWrites);
  const afterBindingPreparation = await D.page.evaluate(async () => { const original = window.__forumPreparedOnly, prepared = await window.__forumProbe.client.prepare('create-post', original.input); return { payload: prepared.payload, payloadHash: prepared.payloadHash }; });
  assert.deepEqual(afterBindingPreparation, { payload: preparedOnly.first.payload, payloadHash: preparedOnly.first.payloadHash });
  pass('actual-webcrypto-locator-derivation-new-binding-rejects-old-lease-before-write', { firstDigestBinding, originalDraftPreserved: true, sameOriginalPayloadKeepsIdsAcrossBinding: true, businessWrites: 0 });
  await screenshot(D.page, '13-async-locator-binding-change-keeps-only-current-own-draft');

  stage('asynchronous-locator-derivation-cross-guid-change');
  const Q = await makePage('locator-recovery-target'); await createOrdinary(Q);
  const locatorRecovery = await Q.page.evaluate(async () => { const runtime = window.__forumProbe.runtime, value = await runtime.prepareRecovery(); await runtime.saveRecovery({ operationId: value.operationId, confirmed: true }); return { code: value.code, subjectId: value.subjectId }; });
  const beforeDigestOwnerChange = await journal(D.page);
  await D.page.evaluate(() => { window.__forumProbe.commits = []; });
  await holdActualDigest(D.page, 'ASYNC_LOCATOR_SAME_GUID_NEW_BINDING'); await button(D.page, '公开发表').click();
  await D.page.waitForFunction(() => window.__forumDigestGate?.seen);
  await D.page.evaluate(async code => { const runtime = window.__forumProbe.runtime; await runtime.recover(code, { confirmed: true }); await runtime.connect({ confirmed: true }); document.dispatchEvent(new Event('visibilitychange')); }, locatorRecovery.code); locatorRecovery.code = null;
  await D.page.waitForFunction(subject => window.__forumProbe.rendered?.subjectId === subject, locatorRecovery.subjectId);
  const firstDigestOtherGuid = await D.page.evaluate(subject => window.__forumProbe.commits.find(value => value.subjectId === subject), locatorRecovery.subjectId);
  assert.equal(firstDigestOtherGuid.oldPrivateText, false); assert.equal(firstDigestOtherGuid.oldPrivateEditor, false); assert.equal(firstDigestOtherGuid.retryConfirm, false);
  await releaseActualDigest(D.page);
  await D.page.waitForFunction(() => !document.querySelector('.forum-heading button')?.disabled);
  assert.equal(await D.page.getByLabel('正文', { exact: true }).count(), 0);
  assert.deepEqual((await journal(D.page, initialD.identity.subjectId)).drafts, beforeDigestOwnerChange.drafts);
  assert.deepEqual((await journal(D.page))?.drafts ?? {}, {}); assert.equal(writes(D.name), beforeDerivationWrites);
  pass('actual-webcrypto-locator-derivation-cross-guid-first-dom-and-late-result-withheld', { firstDigestOtherGuid, oldOwnerDraftPreserved: true, businessWrites: 0 });
  await screenshot(D.page, '14-async-locator-other-guid-does-not-receive-old-draft');

  stage('actual-two-tabs-cas-and-same-guid-first-commit');
  const C = await makePage('draft-owner'); const initialC = await createOrdinary(C);
  await writePost(C, '未发送本机稿', 'PRIVATE_DRAFT_OWNER_C'); await readyDraft(C.page, 'PRIVATE_DRAFT_OWNER_C');
  const sibling = await C.context.newPage(); await sibling.goto(website + '/app/community'); await sibling.waitForFunction(() => !!window.__forumProbe?.runtime);
  await sibling.evaluate(async () => { await window.__forumProbe.runtime.connect({ confirmed: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sibling.getByLabel('正文', { exact: true }).waitFor(); await sibling.getByLabel('正文', { exact: true }).fill('PRIVATE_NEWER_OTHER_TAB'); await readyDraft(sibling, 'PRIVATE_NEWER_OTHER_TAB');
  await C.page.getByLabel('正文', { exact: true }).fill('PRIVATE_STALE_TAB_CHANGE'); await button(C.page, '重新读取本机版本').waitFor(); await button(C.page, '重新读取本机版本').click();
  await C.page.waitForFunction(() => document.querySelector('.forum-editor textarea')?.value === 'PRIVATE_NEWER_OTHER_TAB');
  await C.page.evaluate(() => { window.__forumProbe.watchText = 'PRIVATE_NEWER_OTHER_TAB'; window.__forumProbe.commits = []; });
  const rebound = await C.page.evaluate(async () => { await window.__forumProbe.runtime.connect({ confirmed: true }); const value = await window.__forumProbe.runtime.status(); document.dispatchEvent(new Event('visibilitychange')); return { subjectId: value.identity.subjectId, bindingId: value.connection.bindingId }; });
  await C.page.waitForFunction(binding => window.__forumProbe.rendered?.bindingId === binding, rebound.bindingId);
  const firstBinding = await C.page.evaluate(binding => window.__forumProbe.commits.find(value => value.bindingId === binding), rebound.bindingId);
  assert.equal(firstBinding.oldPrivateText, false); assert.equal(firstBinding.oldPrivateEditor, false); assert.equal(firstBinding.retryConfirm, false);
  await C.page.getByLabel('正文', { exact: true }).waitFor(); assert.equal(await C.page.getByLabel('正文', { exact: true }).inputValue(), 'PRIVATE_NEWER_OTHER_TAB');
  assert.equal(rebound.subjectId, initialC.identity.subjectId);
  pass('actual-two-tab-cas-conflict-fresh-reload-and-same-guid-binding-first-commit', { firstBinding, overwritePrevented: true });
  await screenshot(C.page, '08-cas-fresh-own-draft');

  stage('cross-guid-private-draft-first-commit-late-http');
  const T = await makePage('recovery-target'); await createOrdinary(T);
  const recovery = await T.page.evaluate(async () => { const runtime = window.__forumProbe.runtime, value = await runtime.prepareRecovery(); await runtime.saveRecovery({ operationId: value.operationId, confirmed: true }); return { code: value.code, subjectId: value.subjectId }; });
  const oldC = await journal(C.page);
  const privateTaskC = { title: 'PRIVATE_TASK_OWNER_C', summary: 'PRIVATE_TASK_INPUT_MUST_NOT_MOVE_TO_OTHER_GUID' };
  await C.page.evaluate(value => window.__forumProbe.runtime.putLocal('task-draft', value), privateTaskC);
  hold = { actor: C.name, path: '/v2/community/posts/query', seen: deferred(), release: deferred() };
  await C.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await hold.seen.promise;
  await C.page.evaluate(() => { window.__forumProbe.commits = []; });
  await C.page.evaluate(async code => { const runtime = window.__forumProbe.runtime; await runtime.recover(code, { confirmed: true }); await runtime.connect({ confirmed: true }); document.dispatchEvent(new Event('visibilitychange')); }, recovery.code); recovery.code = null;
  await C.page.waitForFunction(subject => window.__forumProbe.rendered?.subjectId === subject, recovery.subjectId);
  const firstOther = await C.page.evaluate(subject => window.__forumProbe.commits.find(value => value.subjectId === subject), recovery.subjectId);
  assert.equal(firstOther.oldPrivateText, false); assert.equal(firstOther.oldPrivateEditor, false); assert.equal(firstOther.retryConfirm, false);
  hold.release.resolve(); hold = null;
  await button(C.page, '写帖子').waitFor(); await C.page.waitForFunction(() => !document.querySelector('.forum-heading button')?.disabled);
  assert.equal(await C.page.getByLabel('正文', { exact: true }).count(), 0);
  assert.deepEqual((await journal(C.page, initialC.identity.subjectId)).drafts, oldC.drafts); assert.deepEqual((await journal(C.page))?.drafts ?? {}, {});
  assert.deepEqual(await C.page.evaluate(subject => window.__forumProbe.runtime.getLocal('task-draft', subject), initialC.identity.subjectId), privateTaskC);
  assert.equal(await C.page.evaluate(async () => (await window.__forumProbe.runtime.getLocal('task-draft')) ?? null), null);
  pass('cross-guid-first-dom-and-delayed-old-http-withhold-private-draft-and-preserve-old-owner', { firstOther, oldOwner: initialC.identity.subjectId, newOwner: recovery.subjectId });
  await C.page.getByRole('link', { name: '发布', exact: true }).click();
  await C.page.getByLabel('目标（用一句话说明）', { exact: true }).waitFor();
  assert.equal(await C.page.getByLabel('目标（用一句话说明）', { exact: true }).inputValue(), '');
  assert.equal(await C.page.getByLabel(/^说说需要什么帮助/).inputValue(), '');
  pass('different-guid-task-preparation-does-not-inherit-private-input', { oldOwner: initialC.identity.subjectId, newOwner: recovery.subjectId, privateInputStoredThroughActualOwnerScopedRuntime: true });

  stage('lost-ack-persistent-stop-and-new-draft');
  const U = await makePage('unknown-post', { width: 390, height: 844 }); await createOrdinary(U, '/app/community?compose=post');
  await writePost(U, '待核对原操作', 'UNKNOWN_ACCEPTED_ORIGINAL_BODY'); await account(U);
  receiptBlocked.add(U.name); dropWrite = U.name;
  await button(U.page, '公开发表').click(); await forum(U.page).getByRole('alert').waitFor();
  const unknown = await journal(U.page); assert.ok(unknown.active); const originalId = unknown.active.operationId, unknownPostId = unknown.active.payload.postId;
  const countBeforeReload = writes(U.name); await U.page.reload(); await U.page.waitForFunction(() => !!window.__forumProbe?.runtime); await connectCurrent(U.page); await U.page.getByText('草稿所指的原操作暂不能核对。原记录仍保留，请先查询原结果，或明确停止本机重试。', { exact: false }).waitFor();
  assert.equal(await U.page.getByLabel('正文', { exact: true }).count(), 0); assert.equal(writes(U.name), countBeforeReload);
  await button(U.page, '停止本机重试').click(); await button(U.page, '停止本机重试').waitFor({ state: 'detached' });
  const stopped = await journal(U.page); assert.equal(stopped.active, null); assert.equal(JSON.stringify(stopped).includes('UNKNOWN_ACCEPTED_ORIGINAL_BODY'), false); assert.equal(stopped.completed.find(row => row.operationId === originalId).serverCancellationConfirmed, false);
  await U.page.reload(); await button(U.page, '写帖子').waitFor(); await writePost(U, '新的未发送稿', 'DISTINCT_UNSENT_AFTER_STOP'); await readyDraft(U.page, 'DISTINCT_UNSENT_AFTER_STOP');
  const newDraft = (await journal(U.page)).drafts.feed;
  await connectCurrent(U.page);
  receiptBlocked.delete(U.name); await button(U.page, '查询原结果').click(); await U.page.waitForURL(url => url.pathname.includes(unknownPostId));
  const acknowledged = await journal(U.page); assert.deepEqual(acknowledged.drafts.feed, newDraft); assert.equal(acknowledged.completed.find(row => row.operationId === originalId).state, 'acknowledged');
  assert.equal(acknowledged.completed.find(row => row.operationId === originalId).localRetryStopped, true); assert.equal(writes(U.name), countBeforeReload);
  await go(U.page, '/app/community'); await U.page.getByLabel('正文', { exact: true }).waitFor(); assert.equal(await U.page.getByLabel('正文', { exact: true }).inputValue(), 'DISTINCT_UNSENT_AFTER_STOP');
  await screenshot(U.page, '09-stopped-original-query-preserves-new-draft');
  pass('lost-post-ack-read-before-draft-persistent-body-free-stop-and-later-query-keeps-new-draft', { operationId: originalId, acceptedPostId: unknownPostId, automaticResends: 0 });

  stage('late-post-ack-after-second-tab-stop');
  hold = { actor: U.name, path: '/v2/community/posts', seen: deferred(), release: deferred() };
  receiptBlocked.add(U.name);
  await U.page.evaluate(() => { window.__originalForumClient = window.__forumProbe.client; });
  await button(U.page, '公开发表').click(); await hold.seen.promise;
  const lateOriginal = (await journal(U.page)).active; assert.ok(lateOriginal);
  const lateSibling = await U.context.newPage(); await lateSibling.goto(website + '/app/community');
  await lateSibling.waitForFunction(() => !!window.__forumProbe?.runtime);
  await lateSibling.evaluate(async () => { await window.__forumProbe.runtime.connect({ confirmed: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await button(lateSibling, '停止本机重试').waitFor(); await button(lateSibling, '停止本机重试').click();
  await button(lateSibling, '停止本机重试').waitFor({ state: 'detached' });
  await writePost({ page: lateSibling }, '迟到确认之后的新稿', 'NEW_DRAFT_AFTER_CONCURRENT_STOP');
  await readyDraft(lateSibling, 'NEW_DRAFT_AFTER_CONCURRENT_STOP'); const afterLateStop = (await journal(lateSibling)).drafts.feed;
  hold.release.resolve(); hold = null;
  await U.page.waitForFunction(() => document.querySelector('.forum-workspace')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual((await journal(U.page)).drafts.feed, afterLateStop);
  assert.equal((await journal(U.page)).active, null);
  assert.equal((await journal(U.page)).completed.find(row => row.operationId === lateOriginal.operationId).state, 'stopped-local');
  const beforeStoppedRetry = writes(U.name);
  const staleRetry = await U.page.evaluate(async operationId => {
    try { await window.__originalForumClient.retry(operationId, { confirmed: true }); return { accepted: true }; }
    catch (error) { return { accepted: false, code: error.code ?? null }; }
  }, lateOriginal.operationId);
  assert.equal(staleRetry.accepted, false); assert.equal(staleRetry.code, 'forum_operation_terminal'); assert.equal(writes(U.name), beforeStoppedRetry);
  receiptBlocked.delete(U.name);
  await button(lateSibling, '查询原结果').click(); await lateSibling.waitForURL(url => url.pathname.includes(lateOriginal.payload.postId));
  assert.deepEqual((await journal(lateSibling)).drafts.feed, afterLateStop);
  await screenshot(lateSibling, '10-late-original-ack-keeps-distinct-unsent-draft');
  pass('held-actual-http-ack-second-tab-stop-new-draft-late-completion-cannot-revive-original', { operationId: lateOriginal.operationId, newDraftId: afterLateStop.id, staleRetry, bodyRestored: false, extraWrites: 0 });

  stage('explicit-original-retry-under-new-binding');
  const W = await makePage('explicit-retry'); await createOrdinary(W, '/app/community?compose=post');
  await writePost(W, '同一原操作的明确继续', 'EXPLICIT_SAME_ORIGINAL_PAYLOAD'); await account(W);
  rejectWrite = W.name;
  await button(W.page, '公开发表').click(); await forum(W.page).getByRole('alert').waitFor();
  const absentOriginal = (await journal(W.page)).active; assert.ok(absentOriginal?.prepared); assert.equal((await fixture.db.query('SELECT count(*)::int n FROM forum_write_receipts_v1 WHERE operation_id=$1', [absentOriginal.operationId])).rows[0].n, 0);
  await W.page.evaluate(() => { window.__forumProbe.watchText = 'EXPLICIT_SAME_ORIGINAL_PAYLOAD'; window.__forumProbe.commits = []; });
  const newBinding = await W.page.evaluate(async () => { await window.__forumProbe.runtime.connect({ confirmed: true }); const value = await window.__forumProbe.runtime.status(); document.dispatchEvent(new Event('visibilitychange')); return value.connection.bindingId; });
  await W.page.waitForFunction(binding => window.__forumProbe.rendered?.bindingId === binding, newBinding);
  const firstRetryBinding = await W.page.evaluate(binding => window.__forumProbe.commits.find(value => value.bindingId === binding), newBinding);
  assert.equal(firstRetryBinding.oldPrivateText, false); assert.equal(firstRetryBinding.oldPrivateEditor, false); assert.equal(firstRetryBinding.retryConfirm, false);
  assert.equal((await W.page.evaluate(() => window.__forumProbe.client.pending())).find(item => item.operationId === absentOriginal.operationId).publishedUntil, absentOriginal.payload.publishedUntil);
  rejectWrite = null;
  const writeCountBeforeExplicit = writes(W.name);
  await button(W.page, '核对并继续原操作').click(); await button(W.page, '确认继续这项原操作').waitFor();
  assert.equal(writes(W.name), writeCountBeforeExplicit);
  await button(W.page, '确认继续这项原操作').click(); await W.page.waitForURL(url => url.pathname.includes(absentOriginal.payload.postId));
  const exactAccepted = (await journal(W.page)).completed.find(row => row.operationId === absentOriginal.operationId); assert.equal(exactAccepted.state, 'acknowledged');
  const originalSnapshot = (await fixture.db.query('SELECT payload_text FROM forum_events_v1 WHERE id=$1', [absentOriginal.operationId])).rows[0];
  assert.equal(originalSnapshot.payload_text, absentOriginal.payloadJson);
  assert.equal((await fixture.db.query('SELECT count(*)::int n FROM forum_events_v1 WHERE id=$1', [absentOriginal.operationId])).rows[0].n, 1);
  pass('absent-original-explicit-new-binding-reauthorization-keeps-operation-hash-payload-and-deadline', { operationId: absentOriginal.operationId, firstRetryBinding, publishedUntil: absentOriginal.payload.publishedUntil, payloadHash: absentOriginal.payloadHash });

  stage('owned-expired-reply-private-management');
  const shortReply = await W.page.evaluate(async () => {
    const client = window.__forumProbe.client, post = await client.version(location.pathname.split('/')[4], location.pathname.split('/')[6]);
    const payload = { schemaVersion: 1, operationId: crypto.randomUUID(), replyId: crypto.randomUUID(), postId: post.locator.postId, postVersionId: post.locator.versionId, expectedRevision: 0, body: 'SHORT_LIVED_INDEPENDENT_REPLY', replyTo: null, publishedUntil: Math.floor(Date.now() / 1000) + 2 };
    const prepared = await client.prepare('create-reply', payload); await client.execute(prepared, { confirmed: true }); document.dispatchEvent(new Event('visibilitychange'));
    return { replyId: prepared.payload.replyId, path: '/app/community/replies/' + prepared.payload.replyId, postId: prepared.payload.postId, postVersionId: prepared.payload.postVersionId };
  });
  await W.page.locator('a[href="' + shortReply.path + '"]').click();
  await W.page.getByText('SHORT_LIVED_INDEPENDENT_REPLY', { exact: true }).waitFor();
  const accessClock = fixture.access.now; fixture.access.now = () => now + 3;
  await W.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await W.page.getByText('此内容的公开许可已到期。', { exact: true }).waitFor();
  assert.equal(await W.page.getByText('SHORT_LIVED_INDEPENDENT_REPLY', { exact: true }).count(), 0);
  await W.page.locator('.forum-owner-actions summary').click(); await button(W.page, '核对本人回复记录').click(); await button(W.page, '核对回复许可').click();
  await W.page.getByText(/本次核对的停止原因：公开许可到期/).waitFor();
  await button(W.page, '撤回本人回复').click(); await button(W.page, '确认撤回').click(); await W.page.getByText('此内容已撤回。', { exact: true }).waitFor();
  fixture.access.now = accessClock;
  await screenshot(W.page, '11-expired-own-reply-body-free-management');
  pass('expired-public-reply-withholds-body-but-author-can-read-private-permission-and-withdraw', { replyId: shortReply.replyId, controlledClockAdvanceSeconds: 3, priorGrantDeadlineChanged: false });

  stage('compiled-native-formal-task-body-free-distinct-locators');
  const [{ createNativeRuntime }, { createNativeToolServer }, { Client, InMemoryTransport }] = await Promise.all([
    import(pathToFileURL(join(nativeCandidate, 'runtime.js'))), import(pathToFileURL(join(nativeCandidate, 'server.js'))),
    loadToolMcpClient()
  ]);
  nativeDirectory = await mkdtemp(join(tmpdir(), 'galaxy-forum-native-'));
  native = await createNativeRuntime({ dataDirectory: nativeDirectory, endpoint, website, trustedKeys: fixture.access.trustedKeys, now: () => now,
    fetch: async (url, options) => { const target = new URL(url); assert.equal(target.origin, endpoint); return fetch(base + target.pathname + target.search, options); },
    openBrowser: async url => { opened.push(url); return { state: 'captured-isolated-navigation', launched: false }; } });
  await native.initialize({ profile: 'minimal' }, { confirmed: true }); await native.connect({ confirmed: true });
  const nativeSubject = (await native.status()).identity;
  nativeServer = createNativeToolServer(native);
  nativeClient = new Client({ name: 'forum-fixed-main-native', version: '1' }, { capabilities: {} });
  const [left, right] = InMemoryTransport.createLinkedPair(); await nativeServer.connect(left); await nativeClient.connect(right);
  const handoffResult = await nativeClient.callTool({ name: 'galaxy_identity_web_connect', arguments: { requestId: randomUUID(), object: { kind: 'publish' }, origin: { host: 'isolated-forum-native', workRef: 'SYNTHETIC_PRIVATE_NATIVE_REFERENCE' } } });
  assert.equal(handoffResult.isError ?? false, false);
  const handoff = JSON.parse(handoffResult.content[0].text), handoffUrl = new URL(handoff.url); assert.equal(handoffUrl.hostname, '127.0.0.1'); loopbackOrigins.add(handoffUrl.origin);
  const N = await makePage('native-task', { width: 390, height: 844 });
  await N.page.goto(handoff.url); const nativePopupReady = N.page.waitForEvent('popup'); await N.page.locator('#open').click();
  const nativeWeb = await nativePopupReady; lastPage = nativeWeb; await N.page.locator('#offer').waitFor({ state: 'visible' }); await N.page.locator('#approve').click();
  await nativeWeb.getByLabel('目标（用一句话说明）', { exact: true }).waitFor();
  assert.equal((await state(nativeWeb)).identity.subjectId, nativeSubject); assert.deepEqual((await state(nativeWeb)).connection.scopes, nativeScopes);
  await account({ page: nativeWeb, name: N.name });
  async function nav(page, label) {
    if (await button(page, '打开菜单').isVisible()) { await button(page, '打开菜单').click(); await page.getByRole('dialog').getByRole('link', { name: label, exact: true }).click(); }
    else await page.getByRole('link', { name: label === '发布请求' ? '发布' : label, exact: true }).first().click();
  }
  async function fromPost(title) {
    await nav(nativeWeb, '社区'); await nativeWeb.getByRole('link', { name: title, exact: true }).click(); await button(nativeWeb, '为这件事准备任务').click();
    await nativeWeb.getByLabel('目标（用一句话说明）', { exact: true }).waitFor();
  }
  const sameTitle = 'IDENTICAL_OWN_FORMAL_TASK', sameSummary = 'Identical own input; no forum body copied.';
  async function taskPreview({ visibility = 'Public' } = {}) {
    await nativeWeb.getByLabel('目标（用一句话说明）', { exact: true }).fill(sameTitle);
    await nativeWeb.getByLabel(/^说说需要什么帮助/).fill(sameSummary);
    await button(nativeWeb, '继续并查找协助').click();
    await nativeWeb.getByLabel(/^可见范围/).selectOption(visibility);
    await button(nativeWeb, '预览这份请求').click();
    await button(nativeWeb, '确认并发布这份任务').waitFor();
  }
  await fromPost('待核对原操作'); await taskPreview(); dropTaskActor = N.name;
  await button(nativeWeb, '确认并发布这份任务').click(); await nativeWeb.getByRole('heading', { name: '原发布结果待核对', exact: true }).waitFor();
  const originalTask = await nativeWeb.evaluate(() => window.__forumProbe.runtime.getLocal('task-publication'));
  assert.ok(originalTask.forumOrigin); const firstTaskId = originalTask.payload.taskId, firstTaskOrigin = originalTask.forumOrigin;
  assert.equal(firstTaskOrigin.postId, unknownPostId);
  const firstTaskMap = await nativeWeb.evaluate(taskId => window.__forumProbe.runtime.getLocal('community-forum-task-origin:' + taskId), firstTaskId);
  assert.deepEqual(firstTaskMap.origin, firstTaskOrigin);
  await fromPost('新的未发送稿');
  assert.equal(new URL(nativeWeb.url()).searchParams.get('forumPost'), lateOriginal.payload.postId);
  const tasksBeforeQuery = report.apiCalls.filter(row => row.actor === N.name && row.path === '/v2/tasks' && row.method === 'POST').length;
  await button(nativeWeb, '查询原发布').click(); await nativeWeb.waitForURL(url => url.pathname === '/app/tasks/' + firstTaskId);
  await nativeWeb.getByRole('link', { name: '返回原帖子版本', exact: true }).waitFor();
  assert.equal(await nativeWeb.getByRole('link', { name: '返回原帖子版本', exact: true }).getAttribute('href'), firstTaskOrigin.returnTo);
  assert.equal(report.apiCalls.filter(row => row.actor === N.name && row.path === '/v2/tasks' && row.method === 'POST').length, tasksBeforeQuery);
  await fromPost('新的未发送稿'); await taskPreview(); await button(nativeWeb, '确认并发布这份任务').click(); await nativeWeb.waitForURL(url => /^\/app\/tasks\/[^/]+$/.test(url.pathname));
  const secondTaskId = new URL(nativeWeb.url()).pathname.split('/').at(-1); assert.notEqual(secondTaskId, firstTaskId);
  const secondTaskMap = await nativeWeb.evaluate(taskId => window.__forumProbe.runtime.getLocal('community-forum-task-origin:' + taskId), secondTaskId);
  assert.equal(secondTaskMap.origin.postId, lateOriginal.payload.postId); assert.notEqual(secondTaskMap.origin.returnTo, firstTaskOrigin.returnTo);
  await nativeWeb.getByRole('link', { name: '返回原帖子版本', exact: true }).waitFor(); assert.equal(await nativeWeb.getByRole('link', { name: '返回原帖子版本', exact: true }).getAttribute('href'), secondTaskMap.origin.returnTo);
  const taskRows = (await fixture.db.query('SELECT id,snapshot FROM task_requests WHERE id=ANY($1::uuid[]) ORDER BY id', [[firstTaskId, secondTaskId]])).rows;
  assert.equal(taskRows.length, 2);
  const normalizedRequests = taskRows.map(row => { const { taskId: _taskId, operationId: _operationId, ...request } = row.snapshot.request; return request; });
  assert.deepEqual(normalizedRequests[0], normalizedRequests[1]);
  const oldMapAgain = await nativeWeb.evaluate(taskId => window.__forumProbe.runtime.getLocal('community-forum-task-origin:' + taskId), firstTaskId); assert.deepEqual(oldMapAgain, firstTaskMap);
  assert.deepEqual(Object.keys(firstTaskMap.origin).sort(), ['postId', 'returnTo', 'versionId']);
  assert.equal(JSON.stringify(normalizedRequests).includes('UNKNOWN_ACCEPTED_ORIGINAL_BODY'), false); assert.equal(JSON.stringify(normalizedRequests).includes('DISTINCT_UNSENT_AFTER_STOP'), false);
  await screenshot(nativeWeb, '12-two-identical-tasks-distinct-body-free-forum-return');
  pass('actual-native-agent-account-two-identical-tasks-distinct-actual-operation-return-maps', { firstTaskId, secondTaskId, firstTaskOrigin, secondTaskOrigin: secondTaskMap.origin, requestWithoutGeneratedIdsHash: sha(JSON.stringify(normalizedRequests[0])), firstUnknownAckRetriedByOriginalReceiptOnly: true, defaultNativeScopes: nativeScopes });

  await nav(nativeWeb, '发布请求'); await taskPreview({ visibility: 'Private' }); await button(nativeWeb, '确认并发布这份任务').click(); await nativeWeb.waitForURL(url => /^\/app\/tasks\/[^/]+$/.test(url.pathname));
  const normalTaskId = new URL(nativeWeb.url()).pathname.split('/').at(-1);
  assert.equal(await nativeWeb.evaluate(async taskId => (await window.__forumProbe.runtime.getLocal('community-forum-task-origin:' + taskId)) ?? null, normalTaskId), null);
  assert.equal(await nativeWeb.getByRole('link', { name: '返回原帖子版本', exact: true }).count(), 0);
  assert.equal((await fixture.db.query('SELECT count(*)::int n FROM task_requests WHERE requester_id=$1', [nativeSubject])).rows[0].n, 3);
  pass('ordinary-formal-task-without-forum-origin-keeps-original-publication-path', { normalTaskId, normalTaskVisibility: 'Private', formalTaskCount: 3, publicTaskCount: 2, existingNewAccountPublicTaskQuotaUnchanged: true });

  assert.equal(report.apiCalls.filter(row => row.path === '/v1/consents' && row.actor !== N.name).length, 0, 'forum writes must use atomic signature envelope');
  pass('all-forum-ui-writes-use-atomic-envelope-with-no-generic-consent-write');

  stage('finished-current-checks');
  report.sourceAfter = await hashes(); report.sourceStable = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
  assert.deepEqual(report.pageErrors, []); assert.equal(issuer.failures.length, 0); assert.equal(report.sourceStable, true, 'candidate sources changed during verification');
  report.passed = true;
} catch (error) {
  failure = error; report.passed = false; report.failure = { stage: report.stage, name: error.name, message: error.message, stack: error.stack };
  if (lastPage && !lastPage.isClosed()) { try { await lastPage.screenshot({ path: join(out, 'failure.png'), fullPage: true }); await writeFile(join(out, 'failure-dom.txt'), await lastPage.locator('body').innerText(), { flag: 'wx' }); } catch {} }
} finally {
  if (hold) hold.release.resolve();
  report.finishedAt = new Date().toISOString();
  if (!report.sourceAfter) report.sourceAfter = await hashes();
  report.sourceStable = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  try { await nativeClient?.close(); } catch {}
  try { await nativeServer?.close(); } catch {}
  try { await native?.close?.(); } catch {}
  if (api) { api.closeAllConnections(); await new Promise(r => api.close(r)); }
  await issuer?.close().catch(() => {}); await fixture?.db.close().catch(() => {});
  if (nativeDirectory) { const root = resolve(tmpdir()); assert.ok(resolve(nativeDirectory).startsWith(root + sep)); await rm(nativeDirectory, { recursive: true, force: true }); }
}
process.stdout.write(JSON.stringify({ passed: report.passed, checks: report.checks.length, sourceStable: report.sourceStable, stage: report.stage, out, failure: report.failure?.message }) + '\n');
if (failure) process.exitCode = 1;
