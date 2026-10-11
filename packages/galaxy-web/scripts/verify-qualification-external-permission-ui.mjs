import { chromium } from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import { build } from '../../../node_modules/esbuild/lib/main.js';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture, task, experience, review, ag, capabilityId } from '../../galaxy-official/test/qualification-v2-workflow.mjs';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { createApi } from '../../galaxy-official/src/http.mjs';
import { experienceReviewerSchema } from '../../galaxy-official/src/shared/experience-review-schema.mjs';
import { recordRuntimeConfig, runtimeConfigSnapshot } from '../../galaxy-official/src/operations/runtime-config-audit.mjs';

// Isolated component journey using the production TaskApplication, author inbox,
// runtime, IndexedDB, browser signatures, HTTP API and PGlite. All identities,
// reviewer registration and work are synthetic; no real expertise is asserted.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = resolve(root, '../../../07-logs/development/ui-resume-20261002/qualification-external-permission');
await mkdir(out, { recursive: true });
const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
const { f, policy } = await fixture(null, { now, extraScopes: browserScopes });
f.qualificationRequests.qualification = f.qualification.v2;
f.qualificationRequests.calculations = f.qualificationCalculations;
const api = createApi({ ...f, browserOrigins: ['https://galaxy-ui.example.org'], rateLimit: 10000 });
let frontend, browser;
const checks = [], calls = [], errors = [], contexts = [];
let dropCompute = false, holdPlan = false, held, releasePlan, signalPlan;
const planArrived = () => { held = new Promise(r => { signalPlan = r; }); holdPlan = true; return held; };
try {
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {createWebRuntime,loadWebConfiguration} from './packages/galaxy-web/src/runtime.mjs';
    import {TaskApplication} from './packages/galaxy-web/src/task-application.tsx';
    import {QualificationPermissionWorkspace,QualificationPermissionCollector} from './packages/galaxy-web/src/qualification-permission-workspace.tsx';
    const root=createRoot(document.getElementById('panel'));
    window.boot=async()=>{window.rt=await createWebRuntime(await loadWebConfiguration());await rt.createIdentity({confirmed:true});await rt.connect({confirmed:true});return (await rt.status()).identity.subjectId;};
      function App({task,mode,selected,subjectId}){const [view,setView]=useState(mode),[requestId,setRequestId]=useState();const navigate=path=>{if(path.includes('qualification-permissions')){setRequestId(path.split('/')[3]);setView('permissions');}else setView('application');};
        return <><h1>{view==='permissions'?'分别处理本人材料许可':task.request.title}</h1><p>隔离验收场景 · 合成身份与外部材料</p>
        {view==='permissions'?<QualificationPermissionWorkspace runtime={rt} subjectId={subjectId} connected navigate={navigate} initialRequestId={requestId}/>:view==='collector'?<QualificationPermissionCollector runtime={rt} subjectId={subjectId} connected task={task} selected={selected} navigate={navigate}/>:<TaskApplication runtime={rt} subjectId={subjectId} connected task={task} navigate={navigate} refresh={async()=>{}}/>}</>;}
    window.show=async(task,mode='application',selected=[])=>{const subjectId=(await rt.status()).identity.subjectId;window.target=task;
      root.render(<App key={mode} task={task} mode={mode} selected={selected} subjectId={subjectId}/>);};
    window.readTask=async id=>rt.api.call('/v2/tasks/'+id,undefined,{method:'GET',authenticated:true});
  `, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', alias: { '@': root } });
  const cssRoot = resolve(root, 'packages/galaxy-web/dist/assets');
  const css = (await Promise.all((await readdir(cssRoot)).filter(n => n.endsWith('.css')).map(n => readFile(resolve(cssRoot, n), 'utf8')))).join('\n') + await readFile(resolve(root, 'packages/galaxy-web/src/workspace.css'), 'utf8');
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  frontend = createServer((req, res) => {
    if (req.url === '/galaxy-web-config.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: 1, endpoint, signingKeys: [...f.bindings.trustedKeys].map(([kid, pin]) => ({ kid, ...pin })) })); }
    else if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
    else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body class="galaxy-site"><main class="workspace" style="max-width:900px;margin:24px auto;padding:20px" id="panel"></main><script src="/bundle.js"></script></body></html>'); }
  });
  await new Promise(r => frontend.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${frontend.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe' });
  async function open() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); contexts.push(context); context.setDefaultTimeout(15000);
    await context.addInitScript(now => { Date.now = () => now * 1000; }, now);
    await context.route(endpoint + '/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      const payload = body?.payloadJson ? JSON.parse(body.payloadJson) : null;
      calls.push({ path: url.pathname, method: req.method(), payload, input: payload ? null : body?.signedIntent ? null : body });
      try {
        const response = await context.request.fetch(apiOrigin + url.pathname + url.search, { method: req.method(), headers: { ...req.headers(), origin: 'https://galaxy-ui.example.org' }, data: req.postData() ?? undefined });
        if (holdPlan && url.pathname.endsWith('/permission-requests/plan')) { holdPlan = false; signalPlan(); await new Promise(r => { releasePlan = r; }); }
        if (dropCompute && payload?.kind === 'compute' && url.pathname.endsWith('/calculation-permissions')) { dropCompute = false; assert.equal(response.status(), 200); await route.abort('failed'); return; }
        await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': origin } });
      } catch { await route.abort('failed').catch(() => {}); }
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin); await page.waitForFunction(() => !!window.boot);
    const subjectId = await page.evaluate(() => window.boot()); return { page, subjectId };
  }
  const candidate = await open(), reviewer = await open();
  const page = candidate.page, author = reviewer.page;
  const registration = [{ subjectId: reviewer.subjectId, capabilityIds: [capabilityId], kinds: ['external-work', 'challenge'], scope: '合成限定核对', notBefore: now - 1, notAfter: now + 1000, authorityReference: 'synthetic-browser-reviewer-registration', synthetic: true }];
  f.experienceReviews.reviewers = registration.map(r => experienceReviewerSchema.parse(r));
  await recordRuntimeConfig(f.db, { endpoint, component: 'api', experienceReviewers: registration, qualificationPolicies: [policy], snapshot: runtimeConfigSnapshot({ governance: { experienceReviewers: registration, qualificationPolicies: [policy] } }) });
  await f.experienceReviews.useRegistry(); await f.qualification.useRegistry();
  const target = task(f, true); target.title = '合成：外部限定审核的资格材料许可';
  await f.assistance.createTask(f.actor, await ag(f, target, [candidate.subjectId]));
  const declaration = { ...experience({ actor: { subjectId: candidate.subjectId }, now }), kind: 'external-work', actualIntervention: '合成私有外部工作正文：只供作者及审核者', scope: '合成限定诊断范围' };
  const attestation = { ...review({ actor: { subjectId: reviewer.subjectId }, now }, declaration), scope: '合成限定外部审核', method: '合成私有核查方法', observations: '合成私有核查记录' };
  async function submitExperience(who, value, viewers) {
    return who.evaluate(async ({ value, viewers }) => { const input = await rt.api.authorizePayload(value, { action: 'experience.submit', objectId: value.operationId, visibility: 'Private', viewers, confirmed: true }); await rt.api.call('/v2/experience/submit', input, { authenticated: true }); return input.consentId; }, { value, viewers });
  }
  const declarationConsent = await submitExperience(page, declaration, [reviewer.subjectId]);
  await submitExperience(author, attestation, [candidate.subjectId]);
  const taskView = await page.evaluate(async id => { const task = await window.readTask(id); await rt.putLocal('qualification-collection:' + id, { expiresAt: new Date(Date.now() + 300000).toISOString() }); await window.show(task); return task; }, target.taskId);
  const button = (who, name) => who.getByRole('button', { name, exact: true });
  const count = kind => calls.filter(c => c.payload?.kind === kind && ['/v2/qualification/permission-requests/events', '/v2/qualification/calculation-permissions'].includes(c.path)).length;
  const confirm = async who => { await button(who, '确认这一项').click(); await button(who, '确认这一项').waitFor({ state: 'hidden' }); };
  async function shot(who, name, mobile = false) { await who.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }); await who.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); }); assert.equal(await who.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await who.screenshot({ path: resolve(out, name + '.png'), fullPage: true }); }
  await page.getByRole('combobox', { name: '材料来源', exact: true }).selectOption('external-review');
  await button(page, '读取我的当前材料').click(); await page.getByRole('checkbox', { name: /合成限定外部审核/ }).check();
  await button(page, '读取所选材料的原作者清单').click(); await button(page, '预览对此人的请求').waitFor();
  const firstPlan = calls.filter(c => c.path.endsWith('/permission-requests/plan')).at(-1).input;
  assert.deepEqual(firstPlan.externalReviewRefs, [{ id: attestation.id, version: 1 }]); assert.deepEqual(firstPlan.participationIds, []);
  await button(page, '预览对此人的请求').click(); assert.equal(count('request'), 0); await button(page, '返回修改').click(); assert.equal(count('request'), 0);
  await button(page, '预览对此人的请求').click(); await shot(page, 'external-request-review-desktop'); await confirm(page);
  assert.equal(count('request'), 1); const request = calls.find(c => c.payload?.kind === 'request').payload; assert.deepEqual(request.externalReviewRefs, firstPlan.externalReviewRefs);
  assert.deepEqual(request.sourceRefs.map(r => r.id), [attestation.operationId]);
  checks.push({ check: 'Actual TaskApplication selection carries exact external review version; request preview/cancel writes nothing, confirm sends one reviewer-owned source request', passed: true });
  await author.evaluate(task => window.show(task, 'permissions'), taskView); await button(author, '查看材料与回应').click();
  await author.getByText(/目标任务内容当前对你不可读/).waitFor(); assert.equal((await author.locator('body').innerText()).includes(declaration.actualIntervention), false);
  await button(author, '预览授予所选本人材料的许可').click(); assert.equal(count('source-permission'), 0); await shot(author, 'author-permission-review-mobile', true); await confirm(author);
  assert.equal(count('source-permission'), 1); assert.equal(count('record-permission'), 0);
  const permission = calls.find(c => c.payload?.kind === 'source-permission').payload;
  await author.getByRole('combobox', { name: '关联我已经授出的精确许可' }).selectOption(permission.id); await button(author, '预览关联所选许可').click(); await confirm(author); assert.equal(count('record-permission'), 1);
  await button(page, '读取所选材料的原作者清单').click(); await button(page, '预览本任务限定计算授权').click(); await shot(page, 'compute-review-mobile', true); assert.equal(count('compute'), 0); await confirm(page); assert.equal(count('compute'), 1);
  await button(page, '核对本人所选材料').click(); await page.getByText('当前材料不足', { exact: true }).waitFor(); await page.getByText(/依据本任务私有计算许可返回限定结论/).waitFor();
  const compute = calls.find(c => c.payload?.kind === 'compute').payload;
  assert.deepEqual(compute.evidence.externalReviewRefs, [{ id: attestation.id, version: 1 }]); assert.deepEqual(compute.permissionIds, [permission.id]);
  const bounded = await f.qualification.v2.evaluate(f.actor, { taskId: target.taskId, subjectId: candidate.subjectId, evidence: { ...compute.evidence, calculationGrantId: compute.id }, includeSimulation: true });
  assert.equal(bounded.state, 'insufficient-evidence'); assert.equal(bounded.simulation.state, 'satisfied'); assert.equal(bounded.simulation.grantsParticipation, false);
  for (const secret of [declaration.actualIntervention, declaration.id, attestation.id, reviewer.subjectId, attestation.method]) assert.equal(JSON.stringify(bounded).includes(secret), false);
  assert.equal(Number((await f.db.query('SELECT count(*) n FROM task_participations WHERE task_id=$1', [target.taskId])).rows[0].n), 0);
  await shot(page, 'bounded-current-result-mobile', true);
  checks.push({ check: 'Independent browser reviewer grants only its exact record, separately links response; candidate independently confirms compute and reads bounded current result; synthetic evidence grants no actual participation and requester receives no private source text/identity', passed: true });
  // Re-open the exact original selected review through the production chooser.
  await button(page, '移除此项').click(); await page.getByRole('checkbox', { name: /合成限定外部审核/ }).check(); await button(page, '读取所选材料的原作者清单').click();
  await button(page, '预览本任务限定计算授权').click(); dropCompute = true; await button(page, '确认这一项').click(); await page.getByRole('heading', { name: '原操作待取得回执', exact: true }).waitFor();
  assert.equal(count('compute'), 2); await button(page, '查询原操作').click(); await page.getByRole('heading', { name: '原操作待取得回执', exact: true }).waitFor({ state: 'hidden' }); assert.equal(count('compute'), 2);
  assert.equal(Number((await f.db.query("SELECT count(*) n FROM qualification_calculation_grants WHERE subject_id=$1", [candidate.subjectId])).rows[0].n), 2);
  checks.push({ check: 'Lost compute acknowledgement recovers the original operation and hash with a receipt read, without resending or inventing current source access', passed: true });
  const correction = { ...declaration, operationId: randomUUID(), expectedVersion: 1, reason: '合成来源更正', source: { ...declaration.source, contentVersion: '2' } };
  await submitExperience(page, correction, [reviewer.subjectId]); await button(page, '读取所选材料的原作者清单').click(); await page.getByRole('alert').filter({ hasText: '所选外部审核或其原来源已变化' }).waitFor();
  assert.equal(await button(page, '预览本任务限定计算授权').count(), 0); assert.equal(await button(page, '确认这一项').count(), 0);
  await shot(page, 'source-correction-removes-plan-mobile', true);
  const rereview = { ...attestation, operationId: randomUUID(), expectedVersion: 1, reason: '合成审核更新', experienceRef: { id: declaration.id, version: 2 } };
  await submitExperience(author, rereview, [candidate.subjectId]);
  await button(page, '移除此项').click(); await button(page, '读取我的当前材料').click(); await page.getByRole('checkbox', { name: /合成限定外部审核/ }).check();
  await button(page, '读取所选材料的原作者清单').click(); await button(page, '预览对此人的请求').waitFor();
  const nextPlan = calls.filter(c => c.path.endsWith('/permission-requests/plan')).at(-1).input;
  assert.deepEqual(nextPlan.externalReviewRefs, [{ id: attestation.id, version: 2 }]); assert.equal(await button(page, '预览本任务限定计算授权').isDisabled(), true);
  checks.push({ check: 'Corrected declaration invalidates original review plan; refreshed version 2 requires explicit reselection and new reviewer permission, never silently reuses old grant', passed: true });
  // Keep the component mounted while only the selected version changes.
  const selected = [{ id: attestation.id, kind: 'external-review', version: 2 }];
  await page.evaluate(({ taskView, selected }) => window.show(taskView, 'collector', selected), { taskView, selected });
  const wait = planArrived(); await button(page, '读取所选材料的原作者清单').click(); await wait;
  await page.evaluate(({ taskView, selected }) => window.show(taskView, 'collector', selected), { taskView, selected: [{ ...selected[0], version: 1 }] }); releasePlan();
  await page.waitForTimeout(150); assert.equal(await button(page, '预览对此人的请求').count(), 0);
  await button(page, '读取所选材料的原作者清单').click(); await page.getByRole('alert').filter({ hasText: '所选外部审核或其原来源已变化' }).waitFor();
  checks.push({ check: 'A late author plan for version 2 is withheld after selection switches to version 1; stale selected version is rejected by the real service', passed: true });
  await page.evaluate(({ taskView, id }) => window.show(taskView, 'collector', [{ kind: 'proof', id }]), { taskView, id: randomUUID() });
  await page.getByText(/先选择至少一项本人的实际参与记录或精确版本/).waitFor(); assert.equal(await button(page, '读取所选材料的原作者清单').isDisabled(), true);
  await page.evaluate(({ taskView, id }) => window.show(taskView, 'collector', [{ kind: 'participation', id }]), { taskView, id: randomUUID() });
  assert.equal(await button(page, '读取所选材料的原作者清单').isEnabled(), true); await button(page, '读取所选材料的原作者清单').click(); await page.getByRole('alert').waitFor();
  const participationInput = calls.filter(c => c.path.endsWith('/permission-requests/plan')).at(-1).input; assert.equal(participationInput.participationIds.length, 1); assert.deepEqual(participationInput.externalReviewRefs, []);
  checks.push({ check: 'CI-only selection cannot request this permission; original participation selection still sends its own ID and no fabricated external reference (unknown fixture ID correctly rejected)', passed: true });
  await page.evaluate(async consentId => rt.api.call('/v1/consents/' + consentId + '/revoke', {}, { authenticated: true }), declarationConsent);
  const after = await f.qualification.v2.evaluate(f.actor, { taskId: target.taskId, subjectId: candidate.subjectId, evidence: { ...compute.evidence, calculationGrantId: compute.id }, includeSimulation: true });
  assert.equal(after.state, 'insufficient-evidence'); assert.equal(after.simulation.state, 'insufficient-evidence'); assert.equal(after.capabilityVerified, false);
  assert.deepEqual(errors, []);
  checks.push({ check: 'Revoked original source cannot regain eligibility through an acknowledged old computation; browser reports zero unhandled page errors', passed: true });
  console.log(JSON.stringify({ passed: checks.length, report: resolve(out, 'report.json') }));
} catch (error) {
  checks.push({ passed: false, error: error.message });
  for (let i = 0; i < contexts.length; i++) { const page = contexts[i].pages()[0]; if (page) { await page.screenshot({ path: resolve(out, 'failure-' + i + '.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(out, 'failure-' + i + '.txt'), await page.locator('body').innerText()).catch(() => {}); } }
  throw error;
} finally {
  releasePlan?.();
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ actualBrowser: true, actualIndexedDbAndSignatures: true, actualHttp: true, actualPGlite: true, syntheticIdentitiesAndSources: true, componentJourneyNotWholeSite: true, realExpertiseVerified: false, checks, pageErrors: errors, requestCounts: { request: calls.filter(c => c.payload?.kind === 'request').length, permission: calls.filter(c => c.payload?.kind === 'source-permission').length, response: calls.filter(c => c.payload?.kind === 'record-permission').length, compute: calls.filter(c => c.payload?.kind === 'compute').length } }, null, 2));
  for (const context of contexts) await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await browser?.close(); if (frontend?.listening) await new Promise(r => frontend.close(r)); if (api.listening) await new Promise(r => api.close(r)); await f.db.close();
}
