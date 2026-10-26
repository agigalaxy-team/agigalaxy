import { chromium, browserToolOutput } from './browser-tool-runtime.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {oidcProviderFixture} from '../../galaxy-official/test/oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from "../../galaxy-official/src/identity/authentication/oidc-login.mjs";
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)),out=browserToolOutput(import.meta.url, process.env.GALAXY_UI_REPORT_DIR);await mkdir(out,{recursive:true});
const now=Math.floor(Date.now()/1000),endpoint='https://official.example.org',issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic fact OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
const f=await serviceFixture(browserScopes,null,{now,identityProviders:[provider],syntheticCommunityQuota:false}),checks=[],calls=[],pageErrors=[];
let api,frontend,browser,page,failure,loseFactAck=false,caseReadUnavailable=false,dropFactBeforeCommit=false,recoveryActor,recoveryOriginal,heldReceipt;
const secretValues=[];
const denyTaskBeforeReceipt=process.env.GALAXY_UI_DENY_TASK_PENDING==='1';
const report={actualFullMain:true,actualMainRuntimeObservationHook:true,actualBrowser:true,actualWebCryptoIndexedDB:true,actualSignedHttpPGlite:true,actualSyntheticOidc:true,denyTaskBeforeReceipt,physicalDeviceOrHostAcceptance:false,checks,pageErrors};
try{
 api=createApi({...f,browserOrigins:['https://galaxy-ui.example.org'],rateLimit:10000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const apiOrigin='http://127.0.0.1:'+api.address().port;
 const bundle=await build({stdin:{contents:"import './packages/galaxy-web/src/main.tsx';import {getFactClient} from './packages/galaxy-web/src/features/work-records/client.mjs';window.fixtureFactClient=getFactClient;import {createWebRuntime,loadWebConfiguration} from './packages/galaxy-web/src/runtime.mjs';import {taskDraft,publicationFromDraft} from './packages/galaxy-web/src/features/tasks/task-bounty-client.mjs';window.fixtureRuntime=async(connected=false)=>{const rt=await createWebRuntime(await loadWebConfiguration());if(connected)await rt.connect({confirmed:true});return rt;};window.fixtureRequest=title=>publicationFromDraft(taskDraft({title,summary:'仅合成入口接续任务，不代表真人工作',goal:title,situation:'隔离浏览器组合'}),[]);",resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root},loader:{'.css':'empty'},plugins:[{name:'observe-actual-main-runtime',setup(builder){builder.onLoad({filter:/galaxy-web[\\/]src[\\/]main\.tsx$/},async args=>{const source=await readFile(args.path,'utf8'),needle='setRuntime(value);setStatus(next);';assert.equal(source.split(needle).length,2);return{contents:source.replace(needle,'(globalThis as any).fixtureMainRuntime=value;'+needle),loader:'tsx',resolveDir:resolve(args.path,'..')};});}}]});
 const cssDir=resolve(root,'packages/galaxy-web/dist/assets'),cssNames=[...((await readFile(resolve(root,'packages/galaxy-web/dist/index.html'),'utf8')).matchAll(/href="\/app\/assets\/([A-Za-z0-9_.-]+\.css)"/g))].map(x=>x[1]);assert.ok(cssNames.length);report.builtStyleFiles=cssNames;
 const css=(await Promise.all(cssNames.map(x=>readFile(resolve(cssDir,x),'utf8')))).join('\n')+await readFile(resolve(root,'packages/galaxy-web/src/workspace.css'),'utf8');
 frontend=createServer(async(req,res)=>{try{if(req.url==='/galaxy-web-config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,endpoint,signingKeys:[...f.bindings.trustedKeys].map(([kid,pin])=>({kid,...pin}))}));}else if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}else if(req.url==='/fixture-login'&&req.method==='POST'){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);assert.ok(['A','B','C'].includes(input.actor));assert.equal(new URL(input.authorizationUrl).origin,issuer.issuer);issuer.setAccount('synthetic-fact-receipt-'+input.actor);const callback=await issuer.authorize(input.authorizationUrl),response=await fetch(apiOrigin+callback.pathname+callback.search);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:(await response.json()).state}));}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');}}catch{res.writeHead(500);res.end('fixture_error');}});
 await new Promise(ok=>frontend.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+frontend.address().port;
 browser=await chromium.launch({ headless:true });
 const button=(p,name)=>p.getByRole('button',{name,exact:true}),idle=p=>p.waitForFunction(()=>!document.querySelector('.operation-progress'));
 const nav=(p,path)=>p.evaluate(path=>{history.pushState({},'',path);dispatchEvent(new PopStateEvent('popstate'));},path);
 async function actor(name){const context=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:'UTC',reducedMotion:'reduce'});context.setDefaultTimeout(18000);await context.addInitScript(now=>{Date.now=()=>now*1000;},now);
  await context.route(endpoint+'/**',async route=>{const req=route.request(),url=new URL(req.url()),entry={actor:name,path:url.pathname,method:req.method(),input:req.postData()?JSON.parse(req.postData()):null};calls.push(entry);if(dropFactBeforeCommit&&req.method()==='POST'&&(url.pathname.endsWith('/case')||url.pathname==='/v2/cases/events'||url.pathname==='/v2/verification-records/submit')){dropFactBeforeCommit=false;entry.syntheticBeforeCommitDrop=true;await route.abort('failed');return;}if(caseReadUnavailable&&/^\/v2\/cases\/.+\/read$/.test(url.pathname)){entry.status=503;entry.syntheticTransportFailure=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic_case_read_unavailable'}),headers:{'access-control-allow-origin':origin}});return;}const response=await context.request.fetch(apiOrigin+url.pathname+url.search,{method:req.method(),headers:{...req.headers(),origin:'https://galaxy-ui.example.org'},data:req.postDataBuffer()??undefined});entry.status=response.status();if(url.pathname.includes('receipt')){const result=await response.json();entry.receiptState=result.state??null;entry.error=result.error??null;}if(loseFactAck&&req.method()==='POST'&&(url.pathname.endsWith('/case')||url.pathname==='/v2/cases/events'||url.pathname==='/v2/verification-records/submit')&&response.ok()){loseFactAck=false;entry.actualCommitAckDropped=true;await route.abort('failed');return;}if(heldReceipt?.path===url.pathname){const gate=heldReceipt;gate.arrived();await gate.wait;}await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':origin}});});
  const p=await context.newPage();page=p;p.on('pageerror',e=>pageErrors.push(e.message));await p.goto(origin+'/app/settings/identity');await button(p,'创建我的银河身份').click();await p.getByRole('heading',{name:'当前银河身份',exact:true}).waitFor();const id=await p.locator('.identity-id').textContent();await button(p,'准备或更换恢复码').click();const codeField=p.getByRole('textbox',{name:'新的恢复码',exact:true});await codeField.waitFor();const recoveryCode=await codeField.inputValue();secretValues.push(recoveryCode);await button(p,'我已保存').click();await codeField.waitFor({state:'detached'});await idle(p);await button(p,'连接并返回').click();await idle(p);
  await p.evaluate(async actor=>{const rt=await window.fixtureRuntime(true);try{const login=await rt.api.call('/v1/identity/begin',{providerId:'fixture'}),response=await(await fetch('/fixture-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actor,authorizationUrl:login.authorizationUrl})})).json();if(response.state!=='awaiting-local-signature')throw Error('OIDC fixture failed');await rt.confirmAccountLink(login.loginId,{confirmed:true});}finally{rt.close();}},name);return{name,id,page:p,context,recoveryCode};}
 async function shot(p,name,mobile=true){await p.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1100});await p.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo(0,0);});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await p.screenshot({path:resolve(out,name+'.png'),fullPage:true,mask:[p.locator('textarea.recovery-code,#recover-existing textarea')]});}


 const A=await actor('A');page=A.page;
 const writeCount=()=>calls.filter(x=>x.method==='POST'&&(x.path.endsWith('/case')||x.path==='/v2/cases/events'||x.path==='/v2/verification-records/submit')).length;
 const consentCount=()=>calls.filter(x=>x.path==='/v1/consents').length;
 const connectCurrent=async target=>{await nav(page,'/app/settings/identity');await page.getByRole('heading',{name:'当前银河身份',exact:true}).waitFor();await button(page,'连接并返回').click();await idle(page);await nav(page,target);};
 for(const kind of ['case-link','fact','verification']){
  if(kind==='verification'){recoveryActor=await actor('B');page=recoveryActor.page;}
  caseReadUnavailable=false;
  const title='合成：事实原回执 '+kind,marker='SYNTHETIC_PRIVATE_FACT_BODY_'+kind;
  const task=await page.evaluate(async({kind,title})=>{const rt=await window.fixtureRuntime(true);try{const published=await rt.publishTask(window.fixtureRequest(title),{confirmed:true}),task=await rt.api.call('/v2/tasks/'+published.taskId,null,{method:'GET'});if(kind!=='case-link'){const owner=(await rt.status()).identity.subjectId;await window.fixtureFactClient(rt,owner).submitFact(task,null,null,{kind:'intervention',types:['diagnosis'],affectsAttemptIds:[],description:'合成：已建立的检查目标',sourceRefs:[],observedEffect:'只提供此测试的真实记录目标'},{confirmed:true,caseSummary:'合成隔离测试',synthetic:true});return await rt.api.call('/v2/tasks/'+task.taskId,null,{method:'GET'});}return task;}finally{rt.close();}},{kind,title});
  const target='/app/tasks/'+task.taskId+'?section=collaboration';
  await page.goto(origin+target);await connectCurrent(target);await page.getByRole('heading',{name:title,exact:true}).waitFor();await page.getByText('工作进展、交付与验证',{exact:true}).click();
  await button(page,kind==='verification'?'记录反馈或已完成检查':'记录实际诊断、建议或介入').click();
  const form=page.locator('form').filter({has:page.getByRole('heading',{name:'记录本人的具体工作',exact:true})}),field=title=>form.locator('label').filter({hasText:title}).locator('textarea');
  if(kind==='case-link'){await field('关联Case的真实工作背景').fill('合成：只测试回执与当前材料权限');await form.getByLabel('本次是合成或演示案例',{exact:true}).check();}
  if(kind==='verification'){
   await form.locator('label').filter({hasText:'实际检查的目标版本'}).locator('select').selectOption({index:1});
   await field('本次检查或反馈仅涵盖什么').fill('只反馈合成目标');await field('实际环境、仓库版本及前提条件').fill('隔离浏览器合成环境');await field('实际命令或检查方法；反馈可写未执行测试').fill('未执行测试，只记录参与者反馈');await field('检查说明、结果与未覆盖之处').fill(marker);
  }else{await field('实际做了什么').fill(marker);await field('观察到的作用或尚未观察到什么').fill('仅浏览器夹具，不代表解决真实问题');}
  loseFactAck=true;await button(page,'确认保存本人的实际记录').click();await button(page,'查询原操作').waitFor();
  const original=await page.evaluate(async taskId=>{const rt=await window.fixtureRuntime();try{return await rt.getLocal('task-fact-pending:'+(await rt.status()).identity.subjectId+':'+taskId);}finally{rt.close();}},task.taskId);
  const operation=original?.active??original;assert.ok(operation.operationId);assert.ok(operation.items?.length);assert.ok(operation.payloadHash);
  assert.ok(calls.some(x=>x.actualCommitAckDropped&&x.input?.operationId===operation.operationId||x.actualCommitAckDropped&&JSON.stringify(x.input).includes(operation.operationId)),'the unknown operation must have actually committed before its acknowledgement was interrupted');
  if(kind==='verification')recoveryOriginal={taskId:task.taskId,target:target+'#original-fact-receipt',operationId:operation.operationId,payloadHash:operation.payloadHash,marker,title};
  const consentIds=operation.items.map(x=>x.submission?.consentId).filter(Boolean);assert.equal(consentIds.length,kind==='case-link'?2:1);
  await page.evaluate(async ids=>{const rt=await window.fixtureRuntime(true);try{for(const id of ids)await rt.api.call('/v1/consents/'+id+'/revoke',{});}finally{rt.close();}},consentIds);
  // Real Consent withdrawal and a separate controlled transport outage. The
  // current body may be partial after withdrawal; we do not relabel that 403.
  const beforeRecovery={consents:consentCount(),writes:writeCount(),callIndex:calls.length};caseReadUnavailable=true;
  await page.reload();await connectCurrent(target);await page.getByRole('heading',{name:title,exact:true}).waitFor();await page.getByText('工作进展、交付与验证',{exact:true}).click();await page.getByRole('alert').waitFor();
  const observation={kind,originalOperationId:operation.operationId,payloadHash:operation.payloadHash,realConsentsRevoked:consentIds.length,currentCaseReadTransportStatus:503,pendingQueryButtons:await button(page,'查询原操作').count(),privateBodyVisible:(await page.locator('body').innerText()).includes(marker)};
  await writeFile(resolve(out,kind+'-entry-observation.json'),JSON.stringify(observation,null,2)+'\n');await shot(page,kind+'-current-body-unavailable-original-receipt-entry');
  assert.equal(observation.privateBodyVisible,false);assert.equal(observation.pendingQueryButtons,1,'Original metadata receipt entry must survive current Case body read failure after real Consent withdrawal');
  const sourceConsent=(await f.db.query('SELECT consent_id FROM task_events WHERE task_id=$1 ORDER BY version LIMIT 1',[task.taskId])).rows[0].consent_id;
  if(denyTaskBeforeReceipt){
   await page.evaluate(id=>window.fixtureMainRuntime.api.call('/v1/consents/'+id+'/revoke',{}),sourceConsent);
   caseReadUnavailable=false;await page.reload();await connectCurrent(target);await page.getByRole('heading',{name:'当前任务暂未读到。',exact:true}).waitFor();
   assert.equal(calls.filter(x=>x.path==='/v2/tasks/'+task.taskId).at(-1)?.status,403);assert.ok(!(await page.locator('body').innerText()).includes(marker));
  }
  const beforeQueryReads=calls.filter(x=>/^\/v2\/cases\/.+\/read$/.test(x.path)).length;
  if(denyTaskBeforeReceipt&&kind==='case-link'){
   let release,arrived;const wait=new Promise(ok=>release=ok),arrival=new Promise(ok=>arrived=ok);heldReceipt={path:'/v2/tasks/'+task.taskId+'/case-link/receipt',wait,arrived};
   await button(page,'查询原事实操作').click();await arrival;
   const newBinding=await page.evaluate(async()=>{const rt=window.fixtureMainRuntime,before=rt.api.snapshot();await rt.connect({confirmed:true});const after=rt.api.snapshot();document.dispatchEvent(new Event('visibilitychange'));return{sameSubject:before.subjectId===after.subjectId,bindingChanged:before.bindingId!==after.bindingId||before.generation!==after.generation};});assert.deepEqual(newBinding,{sameSubject:true,bindingChanged:true});
   await page.getByRole('region',{name:'原事实操作回执',exact:true}).getByRole('status').filter({hasText:'正在核对本机原操作定位'}).waitFor();
   const heldPath=heldReceipt.path,oldResponse=page.waitForResponse(response=>new URL(response.url()).pathname===heldPath);heldReceipt=null;release();await oldResponse;
   // A round trip lets the released fetch continuation and React updates finish.
   await page.evaluate(async()=>{await fetch('/galaxy-web-config.json');await new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));});
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='查询原事实操作'&&!x.disabled));
   const newPanel=page.getByRole('region',{name:'原事实操作回执',exact:true});assert.equal(await newPanel.getByRole('status').filter({hasText:'这是历史回执'}).count(),0);assert.ok(await button(page,'查询原事实操作').isEnabled());
   const stillOriginal=await page.evaluate(taskId=>window.fixtureMainRuntime.getLocal('task-fact-pending:'+window.fixtureMainRuntime.api.snapshot().subjectId+':'+taskId),task.taskId);assert.equal(stillOriginal.operationId,operation.operationId);assert.equal(stillOriginal.payloadHash,operation.payloadHash);
   await shot(page,'late-receipt-after-rebinding-does-not-update-panel');
   checks.push({check:'Holding an actual successful receipt response across a real full-main runtime rebinding does not repaint the new Task403 panel with the old ACK or clear the original pending journal; the current query control becomes usable',passed:true});
  }
  await button(page,denyTaskBeforeReceipt?'查询原事实操作':'查询原操作').click();await page.getByRole('status').filter({hasText:'这是历史回执'}).waitFor();
  assert.equal(calls.filter(x=>/^\/v2\/cases\/.+\/read$/.test(x.path)).length,beforeQueryReads,'metadata ACK must not force a current Case body read');
  const text=await page.locator('body').innerText();assert.ok(!text.includes('已从精确原文找到原操作'));assert.ok(!text.includes(marker));assert.equal(consentCount(),beforeRecovery.consents);assert.equal(writeCount(),beforeRecovery.writes);
  const receipts=calls.slice(beforeRecovery.callIndex).filter(x=>x.path.includes('receipt'));assert.ok(receipts.some(x=>x.input?.payloadHash===operation.payloadHash));
  const acknowledged=await page.evaluate(async taskId=>{const rt=await window.fixtureRuntime();try{const owner=(await rt.status()).identity.subjectId;return{pending:await rt.getLocal('task-fact-pending:'+owner+':'+taskId),receipts:await rt.getLocal('task-fact-receipts:'+owner+':'+taskId)};}finally{rt.close();}},task.taskId);
  assert.equal(acknowledged.pending,null);assert.ok(acknowledged.receipts.some(x=>x.operationId===operation.operationId&&x.payloadHash===operation.payloadHash));assert.ok(!JSON.stringify(acknowledged).includes(marker));
  if(!denyTaskBeforeReceipt){await button(page,'刷新当前事实与来源').click();await page.getByRole('alert').waitFor();await page.getByRole('status').filter({hasText:'这是历史回执'}).waitFor();}
  await shot(page,kind+'-historical-ack-current-read-failure-separate');
  checks.push({check:kind+': actual full-main original Task reentry retains metadata receipt control after real Consent withdrawal and controlled current-body503; exact historical ACK is independent of body access, creates no Consent/write and retains only body-free receipt locator',passed:true,taskAlsoDeniedBeforeReceipt:denyTaskBeforeReceipt,operationId:operation.operationId,payloadHash:operation.payloadHash});

  // Withdraw the actual original Task publication Consent through its normal
  // owner API. A historical fact ACK must remain reachable from the saved URL
  // even when the Task itself can no longer supply the FactWorkspace props.
  if(!denyTaskBeforeReceipt)await page.evaluate(id=>window.fixtureMainRuntime.api.call('/v1/consents/'+id+'/revoke',{}),sourceConsent);
  caseReadUnavailable=false;
  await page.reload();await connectCurrent(target);await page.getByRole('heading',{name:'当前任务暂未读到。',exact:true}).waitFor();
  const deniedObservation={kind,taskId:task.taskId,operationId:operation.operationId,taskRead:calls.filter(x=>x.path==='/v2/tasks/'+task.taskId).at(-1)?.status,receiptButtons:await button(page,'查询原事实操作').count(),privateBodyVisible:(await page.locator('body').innerText()).includes(marker)};
  await writeFile(resolve(out,kind+'-task-denied-observation.json'),JSON.stringify(deniedObservation,null,2)+'\n');await shot(page,kind+'-task-denied-receipt-entry');
  assert.ok([403,404,410].includes(deniedObservation.taskRead));assert.equal(deniedObservation.privateBodyVisible,false);
  assert.equal(deniedObservation.receiptButtons,1,'Historical Case/Verification receipt must be reachable independently of denied current Task body');
  const beforeDeniedQuery={consents:consentCount(),writes:writeCount(),callIndex:calls.length};
  await button(page,'查询原事实操作').click();
  const receiptPanel=page.getByRole('region',{name:'原事实操作回执',exact:true});
  await receiptPanel.getByRole('status').filter({hasText:'这是历史回执'}).waitFor();
  await receiptPanel.getByText('查看原操作编号与载荷摘要',{exact:true}).click();
  assert.ok((await receiptPanel.innerText()).includes(operation.operationId));assert.ok((await receiptPanel.innerText()).includes(operation.payloadHash));
  assert.ok(!(await page.locator('body').innerText()).includes(marker));assert.ok(!(await page.locator('body').innerText()).includes(title));
  assert.equal(consentCount(),beforeDeniedQuery.consents);assert.equal(writeCount(),beforeDeniedQuery.writes);
  assert.ok(!calls.slice(beforeDeniedQuery.callIndex).some(x=>/^\/v2\/cases\/.+\/read$/.test(x.path)||/^\/v2\/verification-records\/.+\/read$/.test(x.path)||x.path.endsWith('/owner-read')));
  await shot(page,kind+'-task-denied-exact-historical-receipt');
  checks.push({check:kind+': actual original Task Consent revoked; denied full Task still provides exact archived metadata receipt, exposes no previous Task/fact body and causes zero current-body reads, Consent or business writes',passed:true});
 }

 // A separate absent operation: the transport stops before business dispatch,
 // while the actual original Consent and exact local bytes already exist.
 caseReadUnavailable=false;
 const retryTitle='合成：原事实明确续权',retryMarker='SYNTHETIC_EXACT_ORIGINAL_RETRY_BYTES';
 const retryTask=await page.evaluate(async title=>{const rt=await window.fixtureRuntime(true);try{return await rt.publishTask(window.fixtureRequest(title),{confirmed:true});}finally{rt.close();}},retryTitle);
 const retryTarget='/app/tasks/'+retryTask.taskId+'?section=collaboration';await page.goto(origin+retryTarget);await connectCurrent(retryTarget);await page.getByRole('heading',{name:retryTitle,exact:true}).waitFor();await page.getByText('工作进展、交付与验证',{exact:true}).click();await button(page,'记录实际诊断、建议或介入').click();
 const retryForm=page.locator('form').filter({has:page.getByRole('heading',{name:'记录本人的具体工作',exact:true})}),retryField=title=>retryForm.locator('label').filter({hasText:title}).locator('textarea');
 await retryField('关联Case的真实工作背景').fill('合成：原ID/字节/接收方不变');await retryField('实际做了什么').fill(retryMarker);await retryField('观察到的作用或尚未观察到什么').fill('未据此声称工作完成');await retryForm.getByLabel('本次是合成或演示案例',{exact:true}).check();dropFactBeforeCommit=true;await button(page,'确认保存本人的实际记录').click();await button(page,'查询原操作').waitFor();
 await button(page,'查询原操作').click();await page.getByRole('status').filter({hasText:'尚未找到原操作回执'}).waitFor();
 const retryOriginal=await page.evaluate(taskId=>window.fixtureMainRuntime.getLocal('task-fact-pending:'+window.fixtureMainRuntime.api.snapshot().subjectId+':'+taskId),retryTask.taskId);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM case_task_links WHERE operation_id=$1',[retryOriginal.operationId])).rows[0].n,0);
 const beforePreview={consents:consentCount(),writes:writeCount()},previewPanel=page.getByRole('region',{name:'原操作新的私有授权预览',exact:true});
 await button(page,'预览原载荷的新授权').click();await previewPanel.waitFor();assert.ok((await previewPanel.innerText()).includes(retryOriginal.operationId));assert.ok((await previewPanel.innerText()).includes(retryOriginal.payloadHash));
 const renderedBytes=await previewPanel.locator('pre').allTextContents();assert.deepEqual(renderedBytes,retryOriginal.items.map(x=>x.payloadJson));assert.ok((await previewPanel.innerText()).includes('仅本人，无其他接收方'));
 await button(page,'取消新的授权预览').click();assert.equal(await previewPanel.count(),0);assert.equal(consentCount(),beforePreview.consents);assert.equal(writeCount(),beforePreview.writes);
 checks.push({check:'Actual absent original operation shows exact raw bytes/hash and original Private audience; cancelling new authorization preview produces zero Consent and business dispatch and retains the original journal',passed:true});
 await button(page,'预览原载荷的新授权').click();await previewPanel.waitFor();
 const oldPreviewClick=await page.evaluate(async()=>{const rt=window.fixtureMainRuntime,before=rt.api.snapshot();await rt.connect({confirmed:true});const after=rt.api.snapshot(),button=Array.from(document.querySelectorAll('button')).find(x=>x.textContent==='确认按原文和接收方重新授权并提交');if(button)button.click();return{sameSubject:before.subjectId===after.subjectId,changedBinding:before.bindingId!==after.bindingId||before.generation!==after.generation,clicked:!!button};});assert.deepEqual(oldPreviewClick,{sameSubject:true,changedBinding:true,clicked:true});
 await page.getByRole('alert').filter({hasText:'身份或连接已改变'}).waitFor();await previewPanel.waitFor({state:'detached'});assert.equal(consentCount(),beforePreview.consents);assert.equal(writeCount(),beforePreview.writes);
 checks.push({check:'While the actual full-main preview remains visible, rebinding its real runtime then clicking that old confirmation rejects its captured lease, removes only that preview and creates zero Consent/business dispatch',passed:true});
 await button(page,'预览原载荷的新授权').click();await previewPanel.waitFor();assert.deepEqual(await previewPanel.locator('pre').allTextContents(),retryOriginal.items.map(x=>x.payloadJson));await button(page,'确认按原文和接收方重新授权并提交').click();await page.getByRole('status').filter({hasText:'这是历史回执'}).waitFor();
 assert.equal(consentCount(),beforePreview.consents+2);assert.equal(writeCount(),beforePreview.writes+1);assert.equal((await f.db.query('SELECT count(*)::int n FROM case_task_links WHERE operation_id=$1',[retryOriginal.operationId])).rows[0].n,1);
 const finalOperation=await page.evaluate(async taskId=>{const rt=window.fixtureMainRuntime,subject=rt.api.snapshot().subjectId;return{pending:await rt.getLocal('task-fact-pending:'+subject+':'+taskId),receipts:await rt.getLocal('task-fact-receipts:'+subject+':'+taskId)};},retryTask.taskId);assert.equal(finalOperation.pending,null);assert.ok(finalOperation.receipts.some(x=>x.operationId===retryOriginal.operationId&&x.payloadHash===retryOriginal.payloadHash));assert.ok(!JSON.stringify(finalOperation).includes(retryMarker));await shot(page,'explicit-current-preview-recovers-original-operation',false);
 checks.push({check:'A fresh preview under the current binding, explicitly confirmed, creates exactly the two precise original Consent grants and one original Case-link dispatch; original ID/hash stay fixed and the acknowledged journal retains no body',passed:true});

 // Switch identities using the actual recovery form in the same browser, so
 // IndexedDB contains B's archived locator while A must not see it. Recovering
 // B again restores that same identity namespace, never a replacement Task.
 const originalHref=origin+recoveryOriginal.target;
 await page.goto(originalHref);await button(page,'查看当前身份').waitFor();await button(page,'查看当前身份').click();await page.getByRole('heading',{name:'当前银河身份',exact:true}).waitFor();await button(page,'连接并返回').click();await page.waitForURL(originalHref);await button(page,'查询原事实操作').waitFor();
 const beforeIdentityRecovery={consents:consentCount(),writes:writeCount(),taskEvents:(await f.db.query('SELECT count(*)::int n FROM task_events')).rows[0].n,callIndex:calls.length};
 async function recoverAndReturn(code,expectedId){
  await button(page,'查看当前身份').click();await page.getByRole('heading',{name:'当前银河身份',exact:true}).waitFor();
  await page.locator('#recover-existing').evaluate(el=>el.open=true);await page.locator('#recover-existing textarea').fill(code);await button(page,'确认恢复同一身份').click();await idle(page);
  assert.equal(await page.locator('.identity-id').textContent(),expectedId);
  const replacementField=page.getByRole('textbox',{name:'新的恢复码',exact:true});await replacementField.waitFor();const replacement=await replacementField.inputValue();secretValues.push(replacement);assert.ok(replacement!==code);
  await button(page,'我已保存').click();await replacementField.waitFor({state:'detached'});await idle(page);
  await button(page,'连接并返回').click();await page.waitForURL(originalHref);await page.getByRole('heading',{name:'当前任务暂未读到。',exact:true}).waitFor();await button(page,'查询原事实操作').waitFor();
 }
 await recoverAndReturn(A.recoveryCode,A.id);
 let recoveryPanel=page.getByRole('region',{name:'原事实操作回执',exact:true});await button(page,'查询原事实操作').click();await recoveryPanel.getByRole('status').filter({hasText:'此身份在本机没有保存'}).waitFor();
 let recoveryText=await page.locator('body').innerText();assert.ok(!recoveryText.includes(recoveryOriginal.operationId));assert.ok(!recoveryText.includes(recoveryOriginal.payloadHash));assert.ok(!recoveryText.includes(recoveryOriginal.marker));assert.ok(!recoveryText.includes(recoveryOriginal.title));
 await shot(page,'recovery-other-identity-cannot-see-original-locator');
 checks.push({check:'Actual recovery from B to A in the same browser returns the exact original B Task URL including query and hash; A sees neither B archived operation/hash nor prior private Task or fact content',passed:true});
 await recoverAndReturn(recoveryActor.recoveryCode,recoveryActor.id);
 recoveryPanel=page.getByRole('region',{name:'原事实操作回执',exact:true});await button(page,'查询原事实操作').click();await recoveryPanel.getByRole('status').filter({hasText:'这是历史回执'}).waitFor();await recoveryPanel.getByText('查看原操作编号与载荷摘要',{exact:true}).click();
 recoveryText=await page.locator('body').innerText();assert.ok(recoveryText.includes(recoveryOriginal.operationId));assert.ok(recoveryText.includes(recoveryOriginal.payloadHash));assert.ok(!recoveryText.includes(recoveryOriginal.marker));assert.ok(!recoveryText.includes(recoveryOriginal.title));
 assert.equal(consentCount(),beforeIdentityRecovery.consents);assert.equal(writeCount(),beforeIdentityRecovery.writes);assert.equal((await f.db.query('SELECT count(*)::int n FROM task_events')).rows[0].n,beforeIdentityRecovery.taskEvents);
 assert.ok(!calls.slice(beforeIdentityRecovery.callIndex).some(x=>/^\/v2\/cases\/.+\/read$/.test(x.path)||x.path==='/v2/verification-records/read'||x.path.endsWith('/owner-read')));
 await shot(page,'recovered-original-identity-exact-receipt-same-task');
 checks.push({check:'Actual recovery back to original B in its existing browser, explicit replacement-code save and reconnect return the same URL and original archived operation/hash; current Task stays403, no private body, new Consent, task event or fact write occurs',passed:true});
 assert.deepEqual(pageErrors,[]);
}catch(error){failure=error;report.failure={message:error.message,code:error.code??null};if(page){let visible=await page.locator('body').innerText();for(const secret of secretValues)visible=visible.replaceAll(secret,'[recovery-code-redacted]');await writeFile(resolve(out,'failure.txt'),visible);await page.screenshot({path:resolve(out,'failure.png'),fullPage:true,mask:[page.locator('textarea.recovery-code,#recover-existing textarea')]});}}
finally{report.receiptTransport=calls.filter(x=>x.path.includes('receipt')).map(x=>({path:x.path,status:x.status,state:x.receiptState,error:x.error}));report.businessTransport=calls.filter(x=>x.method==='POST'&&(x.path.endsWith('/case')||x.path==='/v2/cases/events'||x.path==='/v2/verification-records/submit')).map(x=>({path:x.path,status:x.status,actualCommitAckDropped:x.actualCommitAckDropped===true,syntheticBeforeCommitDrop:x.syntheticBeforeCommitDrop===true}));report.recordedAt=new Date().toISOString();report.passed=checks.length;report.success=!failure;await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));await browser?.close();if(frontend){frontend.closeAllConnections();await new Promise(ok=>frontend.close(ok));}if(api){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f.db.close();await issuer.close();}
if(failure)throw failure;
