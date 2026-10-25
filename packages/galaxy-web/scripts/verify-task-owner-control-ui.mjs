import { chromium } from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { createApi } from '../../galaxy-official/src/http.mjs';
import { oidcProviderFixture } from '../../galaxy-official/test/oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../../galaxy-official/src/oidc-login.mjs';
import { createRetirementController } from '../../galaxy-official/src/retirement.mjs';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';

const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
const out = fileURLToPath(new URL('../../../../../../07-logs/development/ui-resume-20261002/task-owner-control/', import.meta.url));
await mkdir(out, { recursive: true });
const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic owner control OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
let phaseNow=now;
const retirement=createRetirementController({version:1,id:'owner-control-ui',endpoint,operator:'Synthetic fixture',reason:'Read-only UI boundary',announcedAt:now+1,stopWritesAt:now+2,takeoutUntil:now+3,statusUntil:now+4,contactUrl:endpoint+'/contact',deletionPolicyUrl:endpoint+'/deletion'},{endpoint,now:()=>phaseNow});
const fixture = await serviceFixture(browserScopes, null, { now, retirement, identityProviders:[provider], syntheticCommunityQuota: false });
const api = createApi({ ...fixture, browserOrigins: ['https://galaxy-ui.example.org'], rateLimit: 10000 });
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve)); const apiOrigin = `http://127.0.0.1:${api.address().port}`;
const frontend = createServer(async (request, response) => {
  try {
    if (request.url === '/galaxy-web-config.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: 1, endpoint, operator: 'Synthetic isolated owner read',
        signingKeys: [...fixture.bindings.trustedKeys].map(([kid, pin]) => ({ kid, ...pin })) })); return;
    }
    if(request.url==='/__fixture/login'&&request.method==='POST'){let raw='';for await(const chunk of request)raw+=chunk;const input=JSON.parse(raw);assert.equal(new URL(input.authorizationUrl).origin,issuer.issuer);issuer.setAccount('synthetic-owner-control-requester');const callback=await issuer.authorize(input.authorizationUrl);const result=await fetch(apiOrigin+callback.pathname+callback.search);response.setHeader('content-type','application/json');response.end(JSON.stringify({state:(await result.json()).state}));return;}
    const upstream = await fetch('http://127.0.0.1:5179' + request.url);
    response.statusCode = upstream.status;
    for (const [key, value] of upstream.headers) if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key)) response.setHeader(key, value);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { response.writeHead(500); response.end('synthetic_fixture_failure'); }
});
await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${frontend.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe' });
const contexts = [], events = [], calls = [], pageErrors = [];
let page, dropConsent = false, dropControl=false, failReceipt=false, failLegacySend=false, holdPrepare=false, releasePrepare, signalHeld;let heldPrepare;
async function open() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  contexts.push(context); context.setDefaultTimeout(15000); await context.addInitScript(now => { Date.now = () => now * 1000; }, now);
  await context.route(endpoint + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let action;
    if (url.pathname === '/v1/consents') action = JSON.parse(Buffer.from(JSON.parse(request.postData()).signedIntent.split('.')[1], 'base64url')).action;
    calls.push({ path: url.pathname, action, method:request.method() });
    if(failReceipt&&url.pathname==='/v2/tasks/receipt'){await route.abort('failed');return;}
    if(failLegacySend&&/^\/v2\/tasks\/[^/]+\/events$/.test(url.pathname)){failLegacySend=false;await route.abort('failed');return;}
    try {
      const response = await context.request.fetch(apiOrigin + url.pathname + url.search, { method: request.method(),
        headers: { ...request.headers(), origin: 'https://galaxy-ui.example.org' }, data: request.postData() ?? undefined });
      if(holdPrepare&&url.pathname.endsWith('/owner-control/prepare')){holdPrepare=false;signalHeld();await new Promise(resolve=>{releasePrepare=resolve;});}
      if(dropControl && url.pathname.endsWith('/owner-control')) {dropControl=false;assert.equal(response.status(),200);await route.abort('failed');return;}
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
async function shot(name) { await page.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo(0,0);}); await page.screenshot({ path: resolve(out, name + '.png'), fullPage: true, mask: [page.locator('textarea.recovery-code,textarea[autocomplete="off"]')] }); }
const ownerConsents = () => calls.filter(item => item.action === 'task.owner-read').length;
const bodyReads = () => calls.filter(item => item.path.endsWith('/owner-read')).length;
try {
  const source = await open(); page = source.page; await page.goto(origin + '/app/publish'); await identity(page);
  await page.getByRole('button', { name: '创建我的银河身份', exact: true }).click(); await page.getByRole('heading', { name: '当前银河身份', exact: true }).waitFor(); const subjectId = await page.locator('.identity-id').textContent();
  await page.getByRole('button', { name: '准备或更换恢复码', exact: true }).click(); const codeField = page.getByRole('textbox', { name: '新的恢复码', exact: true }); await codeField.waitFor(); const recoveryCode = await codeField.inputValue();
  await page.getByRole('button', { name: '我已保存', exact: true }).click(); await page.getByRole('button', { name: '连接并返回', exact: true }).click(); await page.waitForURL(origin + '/app/publish');
  await page.evaluate(async()=>{const {createWebRuntime,loadWebConfiguration}=await import('/app/src/runtime.mjs');const r=await createWebRuntime(await loadWebConfiguration());try{await r.connect({confirmed:true});const login=await r.api.call('/v1/identity/begin',{providerId:'fixture'});const result=await (await fetch('/__fixture/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({authorizationUrl:login.authorizationUrl})})).json();if(result.state!=='awaiting-local-signature')throw Error('synthetic account not ready');await r.confirmAccountLink(login.loginId,{confirmed:true});}finally{r.close();}});
  const title = '恢复同一身份后读取本人原请求', summary = '合成保留内容：只通过精确的新本人读取授权披露。';
  await page.getByLabel('目标（用一句话说明）', { exact: true }).fill(title); await page.getByLabel('说说需要什么帮助', { exact: true }).fill(summary);
  await page.getByRole('button', { name: '下一步：协助与范围', exact: true }).click(); await page.getByRole('combobox', { name: /可见范围/ }).selectOption('Public');
  await page.getByRole('button', { name: '预览这份请求', exact: true }).click(); await page.getByRole('button', { name: '确认并发布这份任务', exact: true }).click(); await page.waitForURL(/\/app\/tasks\/[0-9a-f-]{36}$/);
  const target = page.url() + '?section=collaboration#original-help', taskId = new URL(target).pathname.split('/').at(-1);
  const other=await serviceFixture(browserScopes,fixture.db,{migrateDatabase:false,now,syntheticCommunityQuota:false});
  const proposal=await page.evaluate(async({taskId,peer})=>{const {createWebRuntime,loadWebConfiguration}=await import('/app/src/runtime.mjs'),r=await createWebRuntime(await loadWebConfiguration());try{await r.connect({confirmed:true});const task=await r.api.call('/v2/tasks/'+taskId,null,{method:'GET'});return await r.proposeParticipation(taskId,{subjectId:peer,role:'advice',agreedScope:'仅合成边界检查，不代表整体解决。',expectedTaskVersion:task.version},{confirmed:true});}finally{r.close();}},{taskId,peer:other.actor.subjectId});
  const participationId=proposal.participationId;
  const confirmation={kind:'confirm',eventId:crypto.randomUUID(),expectedParticipationVersion:1,scopeVersion:1};
  await fixture.assistance.submitParticipationEvent(other.actor,participationId,await other.authorize(confirmation,'assistance.publish',{objectId:confirmation.eventId,viewers:[subjectId]}));
  const seeded=await page.evaluate(async({taskId,peer,now})=>{const {createWebRuntime,loadWebConfiguration}=await import('/app/src/runtime.mjs'),{getFactClient}=await import('/app/src/features/work-records/client.mjs'),{createContextClientV2}=await import('/app/@fs/C:/Users/USER1/Documents/ChatGPT/projects/active/银河项目/agi-galaxy-network/05-build/repos/galaxy-founding-beta/packages/galaxy-official/src/context-v2-client.mjs');const r=await createWebRuntime(await loadWebConfiguration());try{await r.connect({confirmed:true});let task=await r.api.call('/v2/tasks/'+taskId,null,{method:'GET'});const participant=task.participations.find(p=>p.subjectId===peer);const contexts=createContextClientV2({api:r.api,getLocal:r.getLocal,putLocal:r.putLocal});const prepared=await contexts.prepareGrant({schemaVersion:2,id:crypto.randomUUID(),taskId,participationId:participant.participationId,participantId:peer,scopeVersion:participant.scopeVersion,scopeEventId:participant.scopeEventId,expiresAt:now+1800,materials:[{id:crypto.randomUUID(),label:'原协作资料',mediaType:'text/plain',content:'SYNTHETIC_RETAINED_CONTEXT_NOT_NEW_CONTROL_AUTHORITY'}]});await contexts.execute(prepared,{confirmed:true});const facts=getFactClient(r,task.requesterId);await facts.submitFact(task,null,null,{kind:'intervention',types:['scope-clarification'],affectsAttemptIds:[],description:'合成已实际确认材料范围',sourceRefs:[],observedEffect:'已分开所选材料和整体解决判断'},{confirmed:true,viewers:[peer],caseSummary:'独立合成测试中的原工作事实',synthetic:true});task=await r.api.call('/v2/tasks/'+taskId,null,{method:'GET'});return {caseId:task.caseId};}finally{r.close();}},{taskId,peer:other.actor.subjectId,now});
  const retained=async()=>({participations:(await fixture.db.query('SELECT * FROM task_participations WHERE task_id=$1',[taskId])).rows,case:(await fixture.db.query('SELECT * FROM cases WHERE id=$1',[seeded.caseId])).rows,caseEvents:(await fixture.db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version',[seeded.caseId])).rows,context:(await fixture.db.query('SELECT * FROM context_grants_v2 WHERE task_id=$1',[taskId])).rows});
  const retainedBefore=await retained();assert.equal(retainedBefore.participations.length,1);assert.equal(retainedBefore.context.length,1);assert.equal(retainedBefore.case.length,1);assert.equal(retainedBefore.caseEvents.length,2);
  const originalRows=(await fixture.db.query('SELECT * FROM task_events WHERE task_id=$1 ORDER BY version',[taskId])).rows;
  await page.evaluate(()=>{history.pushState({},'', '/app/publish');dispatchEvent(new PopStateEvent('popstate'));});
  await page.getByLabel('目标（用一句话说明）',{exact:true}).fill('第二项原请求：结束征集');await page.getByLabel('说说需要什么帮助',{exact:true}).fill('单独检验结束征集，不把它描述成取消或问题解决。');await page.getByRole('button',{name:'下一步：协助与范围',exact:true}).click();await page.getByRole('combobox',{name:/可见范围/}).selectOption('Private');await page.getByRole('button',{name:'预览这份请求',exact:true}).click();await page.getByRole('button',{name:'确认并发布这份任务',exact:true}).click();await page.waitForURL(/\/app\/tasks\/[0-9a-f-]{36}$/);const closeTarget=page.url(),closeId=new URL(closeTarget).pathname.split('/').at(-1);
  await page.evaluate(()=>{history.pushState({},'','/app/publish');dispatchEvent(new PopStateEvent('popstate'));});await page.getByLabel('目标（用一句话说明）',{exact:true}).fill('第三项原请求：旧操作接续');await page.getByLabel('说说需要什么帮助',{exact:true}).fill('原操作未知时不允许偷偷创建替代事件。');await page.getByRole('button',{name:'下一步：协助与范围',exact:true}).click();await page.getByRole('combobox',{name:/可见范围/}).selectOption('Private');await page.getByRole('button',{name:'预览这份请求',exact:true}).click();await page.getByRole('button',{name:'确认并发布这份任务',exact:true}).click();await page.waitForURL(/\/app\/tasks\/[0-9a-f-]{36}$/);const legacyTarget=page.url(),legacyId=new URL(legacyTarget).pathname.split('/').at(-1);
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

  const control=page.locator('.task-owner-control'),controlWrites=()=>calls.filter(c=>c.path.endsWith('/owner-control')).length,writeConsents=()=>calls.filter(c=>c.action==='assistance.publish').length;
  const beforeConsents=writeConsents();
  await control.getByRole('combobox',{name:'如何处理原请求',exact:true}).selectOption('cancel');await control.getByRole('textbox',{name:'说明原因',exact:true}).fill('仅取消这项合成原请求，保留全部事实。');await control.getByRole('button',{name:'核对这项处理的准确范围',exact:true}).click();await control.getByRole('button',{name:'确认取消请求',exact:true}).waitFor();
  assert.equal(controlWrites(),0);assert.equal(writeConsents(),beforeConsents);await shot('control-cancel-preview-narrow');await control.getByRole('button',{name:'暂不提交',exact:true}).click();assert.equal(controlWrites(),0);assert.equal(writeConsents(),beforeConsents);
  await control.getByRole('button',{name:'停止本机重试…',exact:true}).click();await control.getByRole('button',{name:'确认只停止本机重试',exact:true}).click();await control.getByLabel('已停止的原操作',{exact:true}).waitFor();assert.equal(controlWrites(),0);assert.equal(writeConsents(),beforeConsents);
  events.push({check:'cancel preview and dismiss create no Consent or execute; explicit stop checks original receipt then retains locator without claiming server cancellation',passed:true});
  await control.getByRole('textbox',{name:'说明原因',exact:true}).fill('明确取消原请求，保留已发生事实。');await control.getByRole('button',{name:'核对这项处理的准确范围',exact:true}).click();await control.getByRole('button',{name:'确认取消请求',exact:true}).waitFor();dropControl=true;await control.getByRole('button',{name:'确认取消请求',exact:true}).click();await control.getByRole('alert').waitFor();assert.equal(controlWrites(),1);assert.equal(writeConsents(),beforeConsents+1);
  await page.reload();await identity(page);await page.getByRole('button',{name:'连接并返回',exact:true}).click();await page.waitForURL(target);await control.getByRole('button',{name:'只核对原操作回执',exact:true}).waitFor();assert.equal(await control.getByRole('button',{name:'确认取消请求',exact:true}).count(),0);await control.getByRole('button',{name:'只核对原操作回执',exact:true}).click();await control.getByRole('heading',{name:'原操作已被服务接受',exact:true}).waitFor();assert.equal(controlWrites(),1);assert.equal(writeConsents(),beforeConsents+1);
  const afterRows=(await fixture.db.query('SELECT * FROM task_events WHERE task_id=$1 ORDER BY version',[taskId])).rows;assert.deepEqual(afterRows.slice(0,-1),originalRows);assert.equal(afterRows.at(-1).kind,'cancel');assert.deepEqual(await retained(),retainedBefore);assert.equal(calls.filter(c=>/settlement|resolution/.test(c.path)).length,0);assert.equal((await fixture.db.query('SELECT snapshot FROM task_requests WHERE id=$1',[taskId])).rows[0].snapshot.state,'canceled');assert.equal(await page.getByRole('tab',{name:'参与与交付',exact:true}).count(),0);await shot('control-cancel-accepted-receipt-narrow');events.push({check:'actual accepted cancel with lost ACK survives full reload as metadata only; original receipt resolves with exactly one new Consent and one execute, all original Task/Case/Intervention/Participation/Context rows byte-for-byte retained, no settlement/resolution call and ordinary GET remains denied',passed:true});
  await page.evaluate(url=>{history.pushState({},'',url);dispatchEvent(new PopStateEvent('popstate'));},closeTarget);await page.getByRole('heading',{name:'当前任务暂未读到。',exact:true}).waitFor();await control.getByRole('textbox',{name:'说明原因',exact:true}).fill('停止征集新参与，不表示已解决。');await control.getByRole('button',{name:'核对这项处理的准确范围',exact:true}).click();await control.getByRole('button',{name:'确认结束征集',exact:true}).waitFor();
  phaseNow=now+2;await control.getByRole('button',{name:'确认结束征集',exact:true}).click();await control.getByText('服务当前未明确允许业务写入。可以核对原回执，暂不能确认取消或结束征集。',{exact:true}).waitFor();assert.equal(controlWrites(),1);assert.equal(writeConsents(),beforeConsents+1);assert.equal(await control.getByRole('button',{name:'确认结束征集',exact:true}).count(),0);await control.getByRole('button',{name:'只核对原操作回执',exact:true}).click();await control.getByRole('heading',{name:'本次核对未找到原操作',exact:true}).waitFor();await shot('control-retirement-readonly-narrow');events.push({check:'service changes to actual takeout after preview: fresh status check prevents Consent and execute while original receipt remains usable',passed:true});
  phaseNow=now;await control.getByRole('button',{name:'重新核对服务状态',exact:true}).click();await control.getByRole('button',{name:'重新核对这项原操作',exact:true}).click();await control.getByRole('button',{name:'确认结束征集',exact:true}).click();await control.getByRole('heading',{name:'服务已接受结束征集',exact:true}).waitFor();assert.equal(controlWrites(),2);assert.equal(writeConsents(),beforeConsents+2);assert.equal((await fixture.db.query('SELECT snapshot FROM task_requests WHERE id=$1',[closeId])).rows[0].snapshot.state,'closed');await page.setViewportSize({width:1440,height:1000});await shot('control-close-accepted-desktop');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);events.push({check:'independent close confirmation stores closed, not canceled or resolved; does not execute settlement or grant complete access',passed:true});

  await page.evaluate(url=>{history.pushState({},'',url);dispatchEvent(new PopStateEvent('popstate'));},legacyTarget);await control.getByRole('textbox',{name:'说明原因',exact:true}).fill('迟到预览不能继承新的连接');const beforeLate=writeConsents();heldPrepare=new Promise(resolve=>{signalHeld=resolve;});holdPrepare=true;await control.getByRole('button',{name:'核对这项处理的准确范围',exact:true}).click();await heldPrepare;
  await identity(page);await page.getByRole('button',{name:'断开本次连接',exact:true}).click();await page.getByRole('button',{name:'连接并返回',exact:true}).click();await page.waitForURL(legacyTarget);const lateResponse=page.waitForResponse(r=>r.url().endsWith('/owner-control/prepare'));releasePrepare();await lateResponse;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await control.getByLabel('原请求处理确认范围',{exact:true}).count(),0);assert.equal(await control.getByLabel('本机保留的原请求操作',{exact:true}).count(),0);assert.equal(writeConsents(),beforeLate);assert.equal(controlWrites(),2);events.push({check:'actual delayed prepare response across identity navigation and new binding is fenced; no stale preview or pending record, no Consent or execute',passed:true});
  failLegacySend=true;const legacy=await page.evaluate(async taskId=>{const {createWebRuntime,loadWebConfiguration}=await import('/app/src/runtime.mjs'),r=await createWebRuntime(await loadWebConfiguration());try{await r.connect({confirmed:true});try{await r.taskEvent(taskId,{kind:'cancel',expectedTaskVersion:1,reason:'旧入口待核对的原取消请求'},{confirmed:true});}catch{const v=await r.getLocal('task-event:'+taskId);if(!v)throw Error('Original queue missing');return {eventId:v.eventId,payloadHash:v.payloadHash,payloadJson:v.payloadJson};}throw Error('Fault did not block old write');}finally{r.close();}},legacyId);
  await page.evaluate(()=>{history.pushState({},'','/app/participate');dispatchEvent(new PopStateEvent('popstate'));});await page.evaluate(url=>{history.pushState({},'',url);dispatchEvent(new PopStateEvent('popstate'));},legacyTarget);const old=control.getByLabel('旧入口保留的原操作',{exact:true});await old.waitFor();await old.getByText('查看旧操作定位',{exact:true}).click();await old.getByText(legacy.eventId,{exact:false}).waitFor();assert.equal(await old.getByText('旧入口待核对的原取消请求',{exact:true}).count(),0);
  const beforeBridge=writeConsents();failReceipt=true;await old.getByRole('button',{name:'只核对旧入口原回执',exact:true}).click();await control.getByRole('alert').waitFor();assert.equal(writeConsents(),beforeBridge);assert.equal(controlWrites(),2);failReceipt=false;
  await old.getByRole('button',{name:'只核对旧入口原回执',exact:true}).click();await control.getByRole('heading',{name:'本次核对未找到原操作',exact:true}).waitFor();await control.getByRole('textbox',{name:'说明原因',exact:true}).fill('独立新审阅的结束征集，不能覆盖原取消');await control.getByRole('button',{name:'核对这项处理的准确范围',exact:true}).click();await control.getByText('旧入口还有原操作需要核对。不会绕过未知结果另建授权；如需另起操作，请先明确停止旧入口的本机重试，再核对原回执。',{exact:true}).waitFor();assert.equal(writeConsents(),beforeBridge);assert.equal(controlWrites(),2);
  await old.getByRole('button',{name:'核对并停止旧入口本机重试…',exact:true}).click();await control.getByLabel('旧入口停止本机重试确认',{exact:true}).waitFor();await control.getByRole('button',{name:'保留旧入口原操作',exact:true}).click();assert.equal(writeConsents(),beforeBridge);await old.getByRole('button',{name:'核对并停止旧入口本机重试…',exact:true}).click();await control.getByRole('button',{name:'确认只停止旧入口本机重试',exact:true}).click();await old.getByText('本机保存的状态：已停止本机重试。最近结果以上方明确查询的回执为准。这里只列出定位，不恢复旧正文，也不会自动发送。',{exact:true}).waitFor();assert.equal(await old.getByRole('button',{name:'核对并停止旧入口本机重试…',exact:true}).count(),0);
  await control.getByRole('button',{name:'核对这项处理的准确范围',exact:true}).click();await control.getByRole('button',{name:'确认结束征集',exact:true}).click();await control.getByRole('heading',{name:'服务已接受结束征集',exact:true}).waitFor();assert.equal(writeConsents(),beforeBridge+1);assert.equal(controlWrites(),3);const legacyRows=(await fixture.db.query('SELECT id,kind,payload_hash FROM task_events WHERE task_id=$1 ORDER BY version',[legacyId])).rows;assert.equal(legacyRows.length,2);assert.notEqual(legacyRows.at(-1).id,legacy.eventId);assert.equal(legacyRows.at(-1).kind,'close');await old.getByRole('button',{name:'只核对旧入口原回执',exact:true}).click();await control.getByRole('heading',{name:'本次核对未找到原操作',exact:true}).waitFor();assert.equal(controlWrites(),3);assert.equal(writeConsents(),beforeBridge+1);await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await shot('legacy-stopped-and-independent-new-review-narrow');events.push({check:'actual old task-event write failure leaves IDB queue; metadata-only directory checks exact old receipt, offline/absent cannot silently replace operation; explicit local-stop then independent review creates one distinct close; stopped original remains query-only',passed:true});
  await page.evaluate(url=>{history.pushState({},'',url);dispatchEvent(new PopStateEvent('popstate'));},target);await area.getByRole('button',{name:'核对可读取的本人记录范围',exact:true}).click();await area.getByRole('button',{name:'授权读取所列本人记录',exact:true}).click();await area.getByRole('heading',{name:'已读取 1 项本人保留记录',exact:true}).waitFor();
  const sourceConsent = (await fixture.db.query('SELECT consent_id FROM task_events WHERE task_id=$1 ORDER BY version LIMIT 1', [taskId])).rows[0].consent_id;
  await fixture.db.query('UPDATE consents SET revoked_at=$2 WHERE id=$1', [sourceConsent, new Date(now * 1000).toISOString()]);
  await area.getByRole('button', { name: '核对可读取的本人记录范围', exact: true }).click(); await area.getByText('原授权已失效、正文已不再保留，或这项来源不符合恢复后本人读取条件。请保留原任务地址。', { exact: true }).waitFor();
  assert.equal(await area.getByRole('heading', { name: title, exact: true }).count(), 0); assert.equal(ownerConsents(), 2); assert.equal(bodyReads(), 2); await shot('owner-read-source-unavailable-narrow');
  events.push({ check: 'explicit fresh review after source revocation drops the displayed old body and honestly fails without signing or further body read', passed: true, syntheticFaultInjection: 'exact original Consent revoked in isolated fixture database' });
  assert.deepEqual(pageErrors, []);
} catch (error) { releasePrepare?.(); events.push({ failed: error.message, url: page?.url() }); if (page) await shot('failure'); throw error; }
finally {
  await writeFile(resolve(out, 'ui-report.json'), JSON.stringify({ actualBrowser: true, actualSignedHttp: true, noQuotaBypass: true, syntheticOidcAccountVerified: true, retainedPrerequisitesThroughSignedApis: true,
    syntheticIdentitiesOnly: true, noRecoveryCodesInEvidence: true, events, pageErrors }, null, 2));
  for (const context of contexts) await context.unrouteAll({ behavior: 'ignoreErrors' });
  await browser.close(); frontend.closeAllConnections();await new Promise(resolve => frontend.close(resolve));api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await fixture.db.close();await issuer.close();
}
