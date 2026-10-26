import { chromium, browserToolOutput } from './browser-tool-runtime.mjs';
import { build } from '../../../node_modules/esbuild/lib/main.js';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { createApi } from '../../galaxy-official/src/http.mjs';
import { digest } from '../../galaxy-official/src/shared/digest.mjs';

// Three independent synthetic signed subjects, actual HTTP/PGlite, production
// CapsuleWorkspace/Authoring DOM. The read-only browser transport injects each
// fixture subject's credential in routing; this is not browser identity enrollment.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = browserToolOutput(import.meta.url, undefined);
await mkdir(out, { recursive: true });
const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
const scopes = ['binding', 'consent', 'case-teaser', 'assistance', 'capsules', 'history'];
const requester = await serviceFixture(scopes, null, { now, syntheticCommunityQuota: false });
const contributor = await serviceFixture(scopes, requester.db, { now, migrateDatabase: false, syntheticCommunityQuota: false });
const outsider = await serviceFixture(scopes, requester.db, { now, migrateDatabase: false, syntheticCommunityQuota: false });
const api = createApi({ ...requester, rateLimit: 10000 });
let frontend, browser;
const contexts = [], checks = [], browserCalls = [], pageErrors = [];
let failPreview = false;
try {
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  const post = async (who, path, body) => {
    const response = await fetch(apiOrigin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.credential}` } : {}) }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify({ path, ...value })); return value;
  };
  const signed = (who, value, action, viewers = [], publicly = false) => who.authorize(value, action, { objectId: value.eventId ?? value.operationId ?? value.id, viewers, visibility: publicly ? 'Public' : 'Private', purpose: publicly ? 'public-profile' : 'operational' });
  const taskId = randomUUID(), caseId = randomUUID(), participationId = randomUUID();
  const task = { operationId: randomUUID(), taskId, caseId: null, intent: 'proactive-review', title: '合成：共同工作中的原介入', summary: '私有合成工作；不是共同署名确认', workContext: { goal: '核对限定贡献', currentSituation: '合成验收', attemptRefs: [] }, visibility: 'Private', collaboration: 'open-assistance', enrollmentExpiresAt: now + 1000 };
  await post(requester, '/v2/tasks', await signed(requester, task, 'assistance.publish', [contributor.actor.subjectId]));
  const rootCase = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0, actorId: requester.actor.subjectId, taskId, localRef: randomUUID(), title: '合成私有来源工作', summary: '原工作不随方法公开', source: { kind: 'active-task', reference: taskId }, synthetic: true };
  const event = (who, kind, expectedVersion, fields) => ({ schemaVersion: 2, kind, eventId: randomUUID(), caseId, expectedVersion, actorId: who.actor.subjectId, taskId, ...fields });
  const initial = event(requester, 'intervention', 1, { types: ['context-addition'], affectsAttemptIds: [], description: '合成请求者提供背景', sourceRefs: [], observedEffect: '界定范围' });
  await post(requester, `/v2/tasks/${taskId}/case`, { operationId: randomUUID(), expectedTaskVersion: 1, case: await signed(requester, rootCase, 'case.teaser.publish', [contributor.actor.subjectId]), initialFact: await signed(requester, initial, 'case.teaser.publish', [contributor.actor.subjectId]) });
  const proposal = { eventId: randomUUID(), kind: 'propose', expectedTaskVersion: 1, participationId, subjectId: contributor.actor.subjectId, role: 'patch', scopeVersion: 1, agreedScope: '合成有限修补范围' };
  await post(requester, `/v2/tasks/${taskId}/participations`, await signed(requester, proposal, 'assistance.publish', [contributor.actor.subjectId]));
  await post(contributor, `/v2/participations/${participationId}/events`, await signed(contributor, { eventId: randomUUID(), kind: 'confirm', expectedParticipationVersion: 1, scopeVersion: 1 }, 'assistance.publish', [requester.actor.subjectId]));
  const intervention = event(contributor, 'intervention', 2, { participationId, types: ['patch'], affectsAttemptIds: [], description: '合成贡献者的限定修补', sourceRefs: [], observedEffect: '合成观察到纠正' });
  const interventionGrant = await signed(contributor, intervention, 'case.teaser.publish', [requester.actor.subjectId]);
  await post(contributor, '/v2/cases/events', interventionGrant);
  const originalResponse = event(requester, 'intervention-response', 3, { interventionRef: { id: intervention.eventId, version: 1 }, state: 'accepted', summary: 'PRIVATE_RESPONSE_BODY_DO_NOT_COPY' });
  await post(requester, '/v2/cases/events', await signed(requester, originalResponse, 'case.teaser.publish', [contributor.actor.subjectId]));
  const result = event(contributor, 'result-recorded', 4, { participationId, origin: { kind: 'intervention', id: intervention.eventId, version: 1 }, scopeVersion: 1, deliverableRefs: [], reportedOutcome: 'succeeded', summary: '合成范围内报告达到目标', limitations: '不代表真实专业能力或独立验证' });
  await post(contributor, '/v2/cases/events', await signed(contributor, result, 'case.teaser.publish', [requester.actor.subjectId]));
  const sourceRef = { kind: 'intervention', id: intervention.eventId, version: 1, caseId };
  const permission = { schemaVersion: 2, id: randomUUID(), kind: 'grant', sources: [sourceRef, { kind: 'result', id: result.eventId, version: 1, caseId }], grantees: [requester.actor.subjectId], license: 'MIT', scope: '只允许选定合成方法，不包含私有回应正文', basis: 'authored-content', attribution: '合成修补作者', allowPublic: true };
  await post(contributor, '/v2/capsules/permissions', await signed(contributor, permission, 'capsule.permission', [requester.actor.subjectId]));
  const version = { schemaVersion: 2, kind: 'version', id: randomUUID(), capsuleId: randomUUID(), expectedRevision: 0, version: 1, publicationClass: 'formal-source-success', synthetic: true, title: '合成：有原贡献回应的方法', problemPattern: '限定方法的归因', environment: { name: 'synthetic-lab', version: '1' }, solutionStrategy: '只发布明确选定的合成方法', tools: [], skills: [], mcpRefs: [], verificationMethod: '分别核对来源结果和原任务回应', limitations: ['合成验收，不构成专业认证'], capabilityId: 'software-debugging', applicableScope: '隔离示例', license: 'MIT', contributors: [contributor.actor.subjectId], sourceResolution: { caseId, resultId: result.eventId, resultVersion: 1, proofIds: [], verificationRefs: [] }, sourceRefs: [], permissionRefs: [permission.id], attributionRefs: [{ subjectId: contributor.actor.subjectId, source: sourceRef }], externalReferences: [], redactionConfirmed: true };
  await post(requester, '/v2/capsules/events', await signed(requester, version, 'capsule.publish', [], true));
  const initialRows = (await requester.db.query('SELECT id,payload_text,payload_hash FROM case_events WHERE case_id=$1 ORDER BY version', [caseId])).rows;
  const respond = async (state, viewers = [contributor.actor.subjectId], refVersion = 1) => {
    const current = (await requester.db.query('SELECT version FROM cases WHERE id=$1', [caseId])).rows[0].version;
    const value = event(requester, 'intervention-response', current, { interventionRef: { id: intervention.eventId, version: refVersion }, state, summary: 'PRIVATE_RESPONSE_BODY_' + state });
    const grant = await signed(requester, value, 'case.teaser.publish', viewers); await post(requester, '/v2/cases/events', grant); return { value, grant };
  };
  const bundle = await build({ stdin: { contents: "\n    import React from 'react';import{createRoot}from'react-dom/client';import{CapsuleWorkspace}from'./packages/galaxy-web/src/features/capsules/capsule-workspace.tsx';import{CapsuleAttributionResponses}from'./packages/galaxy-web/src/features/capsules/capsule-attribution-responses.tsx';\n    const root=createRoot(document.getElementById('panel'));let runtime,subjectId;let generation=1;\n    window.mount=async(config)=>{subjectId=config.subjectId;const local=new Map();runtime={getLocal:async key=>local.get(key),putLocal:async(key,value)=>local.set(key,value),api:{endpoint:config.endpoint,snapshot:()=>subjectId?({subjectId,generation,bindingId:config.bindingId}):null,call:async(path,input,options={})=>{const response=await fetch(config.endpoint+path,{method:options.method??'POST',headers:{'content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{code:value.error});return value;}}};\n      const navigate=async path=>{window.lastNavigation=path;if(path.startsWith('/app/tasks/')){const id=path.split('/')[3].split('?')[0];try{const task=await runtime.api.call('/v2/tasks/'+id,undefined,{method:'GET'});root.render(<section><h1>{task.request.title}</h1><p>原任务权限已经重新核对</p></section>);}catch(error){root.render(<p role=\"alert\">{error.message}</p>);}}};\n      root.render(<CapsuleWorkspace key={generation++} runtime={runtime} subjectId={subjectId} connected={!!subjectId} navigate={navigate} capsuleId={config.capsuleId} versionId={config.versionId}/>);};\n    window.compatibility=(attributions)=>root.render(<CapsuleAttributionResponses attributions={attributions}/>);\n  ", resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', alias: { '@': root } });
  const cssRoot = resolve(root, 'packages/galaxy-web/dist/assets');
  const css = (await Promise.all((await readdir(cssRoot)).filter(n => n.endsWith('.css')).map(n => readFile(resolve(cssRoot, n), 'utf8')))).join('\n') + await readFile(resolve(root, 'packages/galaxy-web/src/workspace.css'), 'utf8');
  frontend = createServer((req, res) => { if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); } else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); } else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body class="galaxy-site"><main class="workspace" style="max-width:920px;margin:24px auto;padding:20px" id="panel"></main><script src="/bundle.js"></script></body></html>'); } });
  await new Promise(r => frontend.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${frontend.address().port}`;
  browser = await chromium.launch({ headless: true });
  const config = who => ({ endpoint, subjectId: who?.actor.subjectId ?? null, bindingId: who?.actor.bindingId ?? null, capsuleId: version.capsuleId, versionId: version.id });
  async function open(who) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); contexts.push(context); context.setDefaultTimeout(15000);
    await context.route(endpoint + '/**', async route => {
      const req = route.request(), url = new URL(req.url()); browserCalls.push({ path: url.pathname, method: req.method(), subjectId: who?.actor.subjectId ?? null });
      if (failPreview && url.pathname === '/v2/capsules/preview') { failPreview = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic-preview-read-failed' }), headers: { 'access-control-allow-origin': origin } }); return; }
      const response = await context.request.fetch(apiOrigin + url.pathname + url.search, { method: req.method(), headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.credential}` } : {}) }, data: req.postData() ?? undefined });
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': origin } });
    });
    const page = await context.newPage(); page.on('pageerror', e => pageErrors.push(e.message)); await page.goto(origin); await page.waitForFunction(() => !!window.mount); await page.evaluate(c => window.mount(c), config(who)); return page;
  }
  const ownerPage = await open(requester), contributorPage = await open(contributor), outsiderPage = await open(outsider), publicPage = await open(null);
  const button = (page, name) => page.getByRole('button', { name, exact: true });
  const attribution = page => page.getByRole('region', { name: '来源归因与原介入回应', exact: true });
  async function showSources(page) { const disclosure = page.getByText('精确来源、参与者与外部链接', { exact: true }); await disclosure.waitFor(); if (!await disclosure.evaluate(e => e.parentElement.open)) await disclosure.click(); }
  async function refresh(page) { await button(page, '刷新当前来源与版本').click(); await showSources(page); }
  async function shot(page, name, mobile = false) { await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }); await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur?.(); }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.screenshot({ path: resolve(out, name + '.png'), fullPage: true }); }
  for (const page of [ownerPage, contributorPage]) { await showSources(page); await attribution(page).getByText('本次当前可读回应确认了这项介入。', { exact: true }).waitFor(); assert.equal((await page.locator('body').innerText()).includes('PRIVATE_RESPONSE_BODY'), false); }
  for (const page of [outsiderPage, publicPage]) { await showSources(page); await attribution(page).getByText(/原介入或其授权当前不可读/).waitFor(); assert.equal(await button(page, '打开原任务核对贡献').count(), 0); assert.equal((await page.locator('body').innerText()).includes(originalResponse.eventId), false); }
  await shot(contributorPage, 'authorized-original-response-desktop'); await shot(outsiderPage, 'public-capsule-private-source-mobile', true);
  assert.deepEqual((await requester.db.query('SELECT id,payload_text,payload_hash FROM case_events WHERE case_id=$1 ORDER BY version', [caseId])).rows, initialRows);
  await button(contributorPage, '打开原任务核对贡献').click(); await contributorPage.getByRole('heading', { name: task.title, exact: true }).waitFor(); assert.equal(await contributorPage.evaluate(() => window.lastNavigation), `/app/tasks/${taskId}?section=collaboration#original-help`);
  await contributorPage.evaluate(c => window.mount(c), config(contributor)); await showSources(contributorPage);
  checks.push({ check: 'Three actual signed synthetic subjects and anonymous reader see different current authorization projections; public Capsule exposes no private response ID/body; read-only display writes no original events; original Task link performs a fresh authorized GET', passed: true });
  await button(ownerPage, '基于此版整理新版本').click();
  const authoring = ownerPage.getByRole('heading', { name: '整理一个独立新版本', exact: true }).locator('..');
  await button(ownerPage, '读取我的真实工作与参与记录').click(); await authoring.getByRole('combobox', { name: '来源工作', exact: true }).selectOption(caseId);
  await authoring.getByRole('combobox', { name: '已经报告达到目标的来源结果', exact: true }).selectOption(result.eventId + ':1');
  await authoring.locator('article').filter({ hasText: intervention.description }).getByRole('checkbox', { name: /将来源作者列为此项贡献者/ }).check();
  await button(ownerPage, '读取明确授予我的许可').click(); await authoring.getByRole('checkbox', { name: /我已核对即将发布的原文/ }).check();
  await button(ownerPage, '核对公开来源条件（不发布）').click(); await authoring.getByText('本次当前可读回应确认了这项介入。', { exact: true }).waitFor();
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await authoring.getByRole('region', { name: '来源归因与原介入回应', exact: true }).screenshot({ path: resolve(out, 'authoring-preview-attribution-mobile.png') });
  assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await ownerPage.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(Number((await requester.db.query('SELECT count(*) n FROM capsule_events WHERE capsule_id=$1', [version.capsuleId])).rows[0].n), 1);
  failPreview = true; await button(ownerPage, '核对公开来源条件（不发布）').click(); await ownerPage.getByRole('alert').filter({ hasText: 'synthetic-preview-read-failed' }).waitFor(); assert.equal(await authoring.getByRole('region', { name: '来源归因与原介入回应' }).count(), 0);
  checks.push({ check: 'Actual authoring current-source preview renders the same scoped response without publication; failed preview refresh removes stale confirmation', passed: true });
  await ownerPage.evaluate(c => window.mount(c), config(requester)); await showSources(ownerPage);
  const partial = await respond('partial', []);
  await refresh(ownerPage); await attribution(ownerPage).getByText('本次当前可读回应仅部分确认这项介入。', { exact: true }).waitFor();
  await refresh(contributorPage); await attribution(contributorPage).getByText('本次当前可读回应未提供确认。', { exact: true }).waitFor(); assert.equal((await attribution(contributorPage).innerText()).includes('原任务请求者'), false);
  await shot(contributorPage, 'new-private-response-withholds-old-confirmation-mobile', true);
  await post(requester, `/v1/consents/${partial.grant.consentId}/revoke`, {}); await refresh(ownerPage); await attribution(ownerPage).getByText('本次当前可读回应未提供确认。', { exact: true }).waitFor();
  const dispute = await respond('disputed'); await refresh(contributorPage); await attribution(contributorPage).getByText('本次当前可读回应包含对这项介入的争议。', { exact: true }).waitFor();
  await attribution(contributorPage).getByText('这条回应的精确引用', { exact: true }).click(); await attribution(contributorPage).getByText(dispute.value.eventId, { exact: true }).waitFor();
  assert.equal((await contributorPage.locator('body').innerText()).includes('PRIVATE_RESPONSE_BODY'), false);
  checks.push({ check: 'Latest private response withholds the earlier accepted record; revoking latest Consent does not revive old acceptance; later authorized dispute appears without its private body', passed: true });
  const current = (await requester.db.query('SELECT version FROM cases WHERE id=$1', [caseId])).rows[0].version;
  const correction = { ...intervention, eventId: randomUUID(), expectedVersion: current, supersedes: { id: intervention.eventId, version: 1 }, description: '合成修正后的介入范围' };
  await post(contributor, '/v2/cases/events', await signed(contributor, correction, 'case.teaser.publish', [requester.actor.subjectId]));
  const newVersionResponse = await respond('accepted', [contributor.actor.subjectId], 2);
  await refresh(contributorPage); await attribution(contributorPage).getByText(/以下仍是对本 Capsule 所引用 v1 的回应/).waitFor(); await attribution(contributorPage).getByText('本次当前可读回应包含对这项介入的争议。', { exact: true }).waitFor();
  assert.equal((await attribution(contributorPage).innerText()).includes(newVersionResponse.value.eventId), false); await shot(contributorPage, 'old-intervention-version-retains-own-response-mobile', true);
  checks.push({ check: 'Corrected Intervention is labelled superseded while Capsule keeps its exact v1 dispute; v2 acceptance cannot migrate into the old attribution', passed: true });
  const ownView = await post(requester, '/v2/capsules/read', { capsuleId: version.capsuleId, versionId: version.id });
  await publicPage.evaluate(items => window.compatibility(items), ownView.attributions.map(a => ({ ...a, contributionResponses: 'read-original-intervention-under-its-own-permission' })));
  await publicPage.getByText(/当前服务未提供可读的原介入回应/).waitFor(); assert.equal(await publicPage.getByText('本次当前可读回应确认了这项介入。', { exact: true }).count(), 0);
  const immutable = (await requester.db.query('SELECT payload_text,payload_hash FROM capsule_events WHERE id=$1', [version.id])).rows[0];
  await post(contributor, `/v1/consents/${interventionGrant.consentId}/revoke`, {}); await button(contributorPage, '刷新当前来源与版本').click();
  await contributorPage.getByText('原来源当前不可用，正文已隐藏。历史操作回执不恢复当前阅读权限。', { exact: true }).waitFor(); assert.equal(await attribution(contributorPage).count(), 0);
  await button(ownerPage, '刷新当前来源与版本').click(); await ownerPage.getByText('原来源当前不可用，正文已隐藏。历史操作回执不恢复当前阅读权限。', { exact: true }).waitFor(); assert.equal(await attribution(ownerPage).count(), 0);
  const receipt = await post(requester, '/v2/capsules/receipt', { type: 'publication', operationId: version.id, payloadHash: digest(JSON.stringify(version)) }); assert.equal(receipt.state, 'acknowledged'); assert.equal(receipt.currentReadPermissionConfirmed, false);
  assert.deepEqual((await requester.db.query('SELECT payload_text,payload_hash FROM capsule_events WHERE id=$1', [version.id])).rows[0], immutable);
  assert.equal(Number((await requester.db.query('SELECT count(*) n FROM capsule_uses_v2 WHERE capsule_id=$1', [version.capsuleId])).rows[0].n), 0);
  assert.equal(browserCalls.filter(c => ['/v2/capsules/events', '/v2/capsules/uses', '/v2/cases/events'].includes(c.path)).length, 0);
  await shot(contributorPage, 'source-revocation-removes-attribution-mobile', true); assert.deepEqual(pageErrors, []);
  checks.push({ check: 'Legacy string response remains readable without invented confirmation; source Consent revocation removes old attribution/body, preserves original Capsule bytes and receipt, and creates zero reuse or browser writes', passed: true });
  console.log(JSON.stringify({ passed: checks.length, report: resolve(out, 'report.json') }));
} catch (error) {
  checks.push({ passed: false, error: error.message });
  for (let i = 0; i < contexts.length; i++) { const page = contexts[i].pages()[0]; if (page) { await page.screenshot({ path: resolve(out, 'failure-' + i + '.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(out, 'failure-' + i + '.txt'), await page.locator('body').innerText()).catch(() => {}); } }
  throw error;
} finally {
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ actualBrowser: true, actualHttp: true, actualPGlite: true, actualSignedConsent: true, syntheticSubjects: 3, anonymousReader: true, browserTransport: 'fixture credential routing; Map local draft fixture; production CapsuleWorkspace and CapsuleAuthoring', realBrowserIdentityEnrollment: false, realHumanConfirmation: false, realCoauthorshipVerified: false, checks, pageErrors, browserCalls }, null, 2));
  for (const context of contexts) await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await browser?.close(); if (frontend?.listening) await new Promise(r => frontend.close(r)); if (api.listening) await new Promise(r => api.close(r)); await requester.db.close();
}
