import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {verifyIdentityControlChain} from '../../galaxy-official/src/verification/identity-control.mjs';

// Actual WebCrypto/IndexedDB browser and separate Native FS devices against
// an isolated signed HTTP/PGlite authority. These are synthetic devices only.
const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=resolve(root,'../../../07-logs/development/ui-resume-20261002/device-management');
await mkdir(out,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'galaxy-device-management-ui-'));
const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
f.identityControl.now=()=>f.now;
const endpoint=f.access.endpoint,checks=[],calls=[],pageErrors=[],natives=[],contexts=[];
let api,frontend,browser,page,dropAfter=false,dropBefore=false,statusOffline=false;
let holdControl=false,arrived,release,arrival;
const count=()=>calls.filter(x=>x.path.endsWith('/identity/control/commit')&&x.dispatched).length;
try{
 api=createApi({...f,browserOrigins:['https://galaxy-ui.example.org'],rateLimit:10000});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const apiOrigin='http://127.0.0.1:'+api.address().port;
 const nativeConfig={endpoint,website:'https://galaxy.example',trustedKeys:f.access.trustedKeys,now:()=>f.now,
  fetch:async(url,options={})=>{assert.equal(new URL(url).origin,endpoint);return fetch(apiOrigin+new URL(url).pathname,options);}};
 async function native(name,initialize=false){const runtime=await createNativeRuntime({...nativeConfig,dataDirectory:join(directory,name)});natives.push(runtime);if(initialize){await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});}return runtime;}
 const old=await native('old',true),initial=await old.status(),subjectId=initial.identity,oldDeviceId=initial.connection.control.deviceId;
 const second=await native('second'),offer2=await second.device.offer(subjectId,{confirmed:true});
 await second.device.accept(await old.device.approve(offer2,{confirmed:true}),{confirmed:true});await second.connect({confirmed:true});
 const bundle=await build({stdin:{contents:`
  import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
  import {createWebRuntime,loadWebConfiguration} from './packages/galaxy-web/src/runtime.mjs';
  import {IdentityWorkspace} from './packages/galaxy-web/src/identity-workspace.tsx';
  const root=createRoot(document.getElementById('panel'));
  function App(){const [status,setStatus]=useState(window.currentStatus);window.refreshView=async()=>{const next=await rt.status();window.currentStatus=next;setStatus(next);return next;};
   return <><h1>身份与设备</h1><p>隔离验收 · 合成设备</p><IdentityWorkspace runtime={rt} subjectId={status.identity?.subjectId} connected={!!status.connection} controlsOpen={!status.identity} navigate={()=>{}} onChange={window.refreshView}/></>;}
  window.boot=async()=>{window.rt=await createWebRuntime(await loadWebConfiguration());if(!rt.deviceManagement)throw Error('Production runtime.deviceManagement is not wired');window.currentStatus=await rt.status();root.render(<App/>);};
 `,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root}});
 const cssPath=resolve(root,'packages/galaxy-web/dist/assets'),css=(await Promise.all((await readdir(cssPath)).filter(x=>x.endsWith('.css')).map(x=>readFile(resolve(cssPath,x),'utf8')))).join('\n')+await readFile(resolve(root,'packages/galaxy-web/src/workspace.css'),'utf8');
 frontend=createServer((req,res)=>{
  if(req.url==='/galaxy-web-config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,endpoint,signingKeys:[...f.bindings.trustedKeys].map(([kid,pin])=>({kid,...pin}))}));}
  else if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}
  else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}
  else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body class="galaxy-site"><main id="panel" class="workspace" style="max-width:900px;margin:24px auto;padding:20px"></main><script src="/bundle.js"></script></body></html>');}
 });await new Promise(r=>frontend.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+frontend.address().port;
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});contexts.push(context);context.setDefaultTimeout(15000);
 await context.addInitScript(now=>{window.__fixtureNow=now;Date.now=()=>window.__fixtureNow*1000;},f.now);
 await context.route(endpoint+'/**',async route=>{
  const req=route.request(),url=new URL(req.url()),body=req.postData();assert.ok(!body||!/PRIVATE KEY|galaxy-recovery-v1:/.test(body));
  const entry={path:url.pathname,method:req.method(),dispatched:false};calls.push(entry);
  try{
   if(statusOffline&&url.pathname.endsWith('/identity/control/status')){await route.abort('failed');return;}
   if(dropBefore&&url.pathname.endsWith('/identity/control/commit')){dropBefore=false;await route.abort('failed');return;}
   const response=await context.request.fetch(apiOrigin+url.pathname+url.search,{method:req.method(),headers:{...req.headers(),origin:'https://galaxy-ui.example.org'},data:body??undefined});entry.dispatched=true;entry.status=response.status();
   if(holdControl&&url.pathname.endsWith('/control')){holdControl=false;arrived();await new Promise(r=>release=r);}
   if(dropAfter&&url.pathname.endsWith('/identity/control/commit')){dropAfter=false;assert.equal(response.status(),200);await route.abort('failed');return;}
   await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':origin}});
  }catch{await route.abort('failed').catch(()=>{});}
 });
 page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));
 const button=name=>page.getByRole('button',{name,exact:true}),panel=()=>page.locator('#identity-device-management');
 async function boot(){await page.goto(origin);await page.waitForFunction(()=>!!window.boot);await page.evaluate(()=>window.boot());}
 async function ready(){await button('重新读取设备与原操作').waitFor();await page.waitForFunction(()=>{const b=[...document.querySelectorAll('#identity-device-management button')].find(x=>x.textContent==='重新读取设备与原操作');return b&&!b.disabled;});}
 async function show(){await panel().locator(':scope > summary').click();await ready();}
 async function refresh(){await button('重新读取设备与原操作').click();await ready();}
 async function shot(name,mobile=false){await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1000});await page.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo(0,0);});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});}
 const device=id=>page.getByRole('article',{name:'设备 '+id,exact:true});
 async function prepare(id){await device(id).getByRole('button').click();await page.getByRole('heading',{name:'核对要撤销的设备',exact:true}).waitFor();await ready();return page.evaluate(()=>rt.deviceManagement.pending());}
 await boot();await page.getByLabel('已有银河 ID',{exact:true}).fill(subjectId);await button('生成本机连接申请').click();await page.getByText('身份、设备与核对指纹',{exact:true}).click();await page.locator('#identity-public-request').waitFor();
 const offered=JSON.parse(await page.locator('#identity-public-request').inputValue()),approval=await old.device.approve(offered,{confirmed:true});
 await page.getByLabel('粘贴旧设备返回的批准',{exact:true}).fill(JSON.stringify(approval));await button('核对批准内容').click();await button('确认用本机钥加入同一身份').click();await panel().waitFor();await show();
 const browserDevice=offered.deviceId,baseline=await f.identityControl.publicState(subjectId),originalEvents=JSON.stringify(baseline.events);
 assert.equal(baseline.devices.length,3);assert.equal((await page.evaluate(()=>rt.status())).connection,null);
 assert.equal((await page.evaluate(()=>rt.deviceManagement.current())).canManage,true);
 let before=count();const firstPending=await prepare(oldDeviceId);assert.equal(count(),before);await shot('exact-device-revoke-review-desktop');
 await button('暂不提交').click();await button('确认停止本机重试').click();await ready();assert.equal(count(),before);assert.equal((await page.evaluate(()=>rt.deviceManagement.pending())).active,null);
 assert.equal((await f.identityControl.publicState(subjectId)).devices.find(x=>x.device_id===oldDeviceId).status,'active');
 assert.equal((await page.evaluate(()=>rt.deviceHandoff.pending())).state,'committed');
 checks.push({check:'Actual Native-to-browser handoff preserves one subject; disconnected browser reads three devices, exact preview dispatches no revoke, local stop does not cancel the independent handoff',passed:true});

 await page.evaluate(async()=>{await rt.connect({confirmed:true});await window.refreshView();});await ready();
 const lost=await prepare(oldDeviceId);before=count();dropAfter=true;await button('确认撤销所选设备').click();await ready();
 assert.equal((await page.evaluate(()=>rt.deviceManagement.pending())).active.state,'result-unknown');assert.equal(await button('重新核对此次撤销').count(),0);assert.equal(count(),before+1);
 await page.reload();await page.waitForFunction(()=>!!window.boot);await page.evaluate(()=>window.boot());await show();before=count();await button('只查询原设备操作').click();await ready();assert.equal(count(),before);
 assert.equal((await page.evaluate(()=>rt.deviceManagement.pending())).history[0].operationId,lost.active.operationId);
 await assert.rejects(old.api.call('/v2/consents/receipt',{consentId:crypto.randomUUID()}),/access_denied/);await assert.rejects(old.connect({confirmed:true}),/current_device_control_required/);
 const after=await f.identityControl.publicState(subjectId);assert.equal(JSON.stringify(after.events.slice(0,baseline.events.length)),originalEvents);assert.deepEqual(after.genesisProof,baseline.genesisProof);
 await shot('lost-ack-original-receipt-mobile',true);
 checks.push({check:'Browser confirmation commits once with lost ACK; IndexedDB reload queries the same original operation without repeated commit; revoked Native credential is denied and original genesis/events remain unchanged',passed:true});

 await prepare(offer2.deviceId);before=count();dropBefore=true;await button('确认撤销所选设备').click();await ready();assert.equal(count(),before);
 const unknown=(await page.evaluate(()=>rt.deviceManagement.pending())).active;
 await button('只查询原设备操作').click();await ready();assert.equal((await page.evaluate(()=>rt.deviceManagement.pending())).active.state,'requested');
 await button('重新核对此次撤销').click();await ready();const reviewed=(await page.evaluate(()=>rt.deviceManagement.pending())).active;assert.equal(reviewed.operationId,unknown.operationId);assert.equal(reviewed.challengeHash,unknown.challengeHash);
 await button('确认撤销所选设备').click();await ready();assert.equal(count(),before+1);assert.equal((await page.evaluate(()=>rt.deviceManagement.current())).devices.find(x=>x.currentDevice).canRevoke,false);
 assert.equal(await button('核对撤销本机').count(),0);await assert.rejects(second.connect({confirmed:true}),/current_device_control_required/);
 checks.push({check:'Never-dispatched submit is unknown until original status confirms requested; a new explicit same-operation review commits once; last browser manager without recovery cannot revoke itself',passed:true});

 const third=await native('third'),offer3=await third.device.offer(subjectId,{confirmed:true});
 const approved3=await page.evaluate(async offer=>rt.deviceHandoff.approveOffer(offer,{confirmed:true}),offer3);await third.device.accept(approved3,{confirmed:true});await third.connect({confirmed:true});await refresh();
 await prepare(offer3.deviceId);before=count();dropBefore=true;await button('确认撤销所选设备').click();await ready();statusOffline=true;
 await button('停止本机重试').click();await button('确认停止本机重试').click();await ready();assert.equal(count(),before);
 const stopped=(await page.evaluate(()=>rt.deviceManagement.pending())).active;assert.equal(stopped.localRetryStopped,true);assert.equal(stopped.serverCancellationConfirmed,false);assert.equal(await button('重新核对此次撤销').count(),0);
 await shot('unknown-stop-is-not-server-cancel-mobile',true);statusOffline=false;await button('只查询原设备操作').click();await ready();assert.equal((await page.evaluate(()=>rt.deviceManagement.pending())).active.state,'requested');assert.equal(count(),before);
 f.now+=181;await page.evaluate(now=>window.__fixtureNow=now,f.now);await button('只查询原设备操作').click();await ready();assert.equal((await page.evaluate(()=>rt.deviceManagement.pending())).history[0].state,'expired');assert.equal(count(),before);
 checks.push({check:'Unknown local stop retains original locator and forbids resend; recovered status does not revive retry; only actual authority-confirmed expiry closes the old slot, with zero extra commits',passed:true});

 await prepare(offer3.deviceId);before=count();
 await page.evaluate(async()=>{const recovery=await rt.prepareRecovery({confirmed:true});await rt.saveRecovery({operationId:recovery.operationId,confirmed:true});});
 await button('确认撤销所选设备').click();await ready();assert.equal(count(),before+1);await page.getByRole('alert').filter({hasText:'身份控制已经变化'}).waitFor();
 await button('停止本机重试').click();await button('确认停止本机重试').click();await ready();await prepare(offer3.deviceId);await button('确认撤销所选设备').click();await ready();
 assert.equal((await f.identityControl.publicState(subjectId)).recovery.generation,1);
 checks.push({check:'Actual recovery registration changes control chain, invalidates old preview and permits no stale revoke; fresh explicit target review succeeds without consuming recovery material',passed:true});

 arrival=new Promise(r=>arrived=r);holdControl=true;before=count();await button('重新读取设备与原操作').click();await arrival;
 await page.evaluate(async()=>{rt.api.disconnect();await window.refreshView();});release();await ready();assert.equal(count(),before);assert.equal(await button('核对撤销本机').count(),0);await refresh();assert.equal((await page.evaluate(()=>rt.deviceManagement.current())).canManage,true);
 assert.equal((await page.evaluate(()=>rt.status())).connection,null);
 checks.push({check:'In-flight old-binding control read is fenced across disconnect and offers no stale write; explicit fresh read restores public current metadata while disconnected without any management write',passed:true});

 await button('核对撤销本机').click();await page.getByRole('heading',{name:'确认撤销当前这台设备',exact:true}).waitFor();await ready();await shot('self-revoke-exact-review-mobile',true);before=count();await button('确认撤销当前设备').click();await ready();assert.equal(count(),before+1);
 const final=await page.evaluate(()=>rt.deviceManagement.current());assert.equal(final.canManage,false);assert.equal(final.devices.find(x=>x.deviceId===browserDevice).state,'revoked');assert.equal(final.recoveryConfigured,true);
 assert.equal((await f.identityControl.publicState(subjectId)).recovery.generation,1);assert.equal((await verifyIdentityControlChain(await f.identityControl.publicState(subjectId))).devices.length,0);
 assert.equal(await button('核对撤销本机').count(),0);await panel().getByText(/本机当前没有管理此身份设备的权限/).waitFor();
 await panel().getByText(/本机保存的设备操作记录/).click();before=count();await button('查看本机记录的回执').first().click();await ready();assert.equal(count(),before);await page.getByText(/本机保存的原回执表明/).first().waitFor();
 await shot('self-revoked-current-control-mobile',true);assert.equal(pageErrors.length,0);
 assert.ok(!/PRIVATE KEY|galaxy-recovery-v1:/.test(await panel().innerText()));
 checks.push({check:'Registered recovery permits explicit self-revoke; current state loses management, old local receipt grants no current access, recovery generation stays unchanged and UI reveals no recovery secret',passed:true});
 assert.ok(firstPending.active.operationId);console.log(JSON.stringify({passed:checks.length,pageErrors:pageErrors.length}));
}catch(error){checks.push({failed:error.message});if(page)await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{
 await writeFile(resolve(out,'report.json'),JSON.stringify({actualBrowser:true,actualHttp:true,actualPGlite:true,actualBrowserIndexedDB:true,actualNativeFS:true,syntheticDevicesOnly:true,realUserPhysicalDevices:false,noSecretValuesRecorded:true,checks,pageErrors,calls},null,2));
 release?.();for(const context of contexts)await context.unrouteAll({behavior:'ignoreErrors'});await browser?.close();for(const runtime of natives)runtime.close();
 if(frontend?.listening){frontend.closeAllConnections();await new Promise(r=>frontend.close(r));}if(api?.listening){api.closeAllConnections();await new Promise(r=>api.close(r));}await f.db.close();
 const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('galaxy-device-management-ui-'));await rm(target,{recursive:true,force:true});
}


