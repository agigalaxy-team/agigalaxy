import { chromium, browserToolOutput } from './browser-tool-runtime.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {readFile,readdir,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';

// Full production main entry. Reuse the same serviceFixture and Native runtime
// as the isolated device journey; do not duplicate its seven state-machine cases.
const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=browserToolOutput(import.meta.url, undefined);await mkdir(out,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'galaxy-device-management-app-ui-'));
const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
const endpoint=f.access.endpoint,checks=[],calls=[],pageErrors=[];
let api,frontend,browser,context,page,native;
try{
 api=createApi({...f,browserOrigins:['https://galaxy-ui.example.org'],rateLimit:10000});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const apiOrigin='http://127.0.0.1:'+api.address().port;
 const bundle=await build({entryPoints:[resolve(root,'packages/galaxy-web/src/main.tsx')],bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root},loader:{'.css':'empty'}});
 const cssPath=resolve(root,'packages/galaxy-web/dist/assets'),css=(await Promise.all((await readdir(cssPath)).filter(x=>x.endsWith('.css')).map(x=>readFile(resolve(cssPath,x),'utf8')))).join('\n')+await readFile(resolve(root,'packages/galaxy-web/src/workspace.css'),'utf8');
 frontend=createServer((req,res)=>{
  if(req.url==='/galaxy-web-config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,endpoint,operator:'Synthetic main-entry fixture',signingKeys:[...f.bindings.trustedKeys].map(([kid,pin])=>({kid,...pin}))}));}
  else if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}
  else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}
  else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');}
 });await new Promise(r=>frontend.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+frontend.address().port;
 browser=await chromium.launch({ headless:true });
 context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});context.setDefaultTimeout(15000);await context.addInitScript(now=>{Date.now=()=>now*1000;},f.now);
 await context.route(endpoint+'/**',async route=>{const req=route.request(),url=new URL(req.url());calls.push({path:url.pathname,method:req.method()});assert.ok(!req.postData()||!/PRIVATE KEY|galaxy-recovery-v1:/.test(req.postData()));
  const response=await context.request.fetch(apiOrigin+url.pathname+url.search,{method:req.method(),headers:{...req.headers(),origin:'https://galaxy-ui.example.org'},data:req.postData()??undefined});await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':origin}});
 });
 page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));
 const button=name=>page.getByRole('button',{name,exact:true});
 async function identity(){if(await button('打开菜单').isVisible()){await button('打开菜单').click();await page.locator('.mobile-personal a[href="/app/settings/identity"]').click();}else{await page.locator('.personal-menu > summary').click();await page.locator('.personal-menu a[href="/app/settings/identity"]').click();}await page.getByRole('heading',{name:'身份与设置',exact:true}).waitFor();}
 async function settled(){await page.waitForFunction(()=>!document.querySelector('.operation-progress'));}
 async function managed(){await page.locator('#identity-device-management > summary').click();await page.waitForFunction(()=>{const b=[...document.querySelectorAll('#identity-device-management button')].find(x=>x.textContent==='重新读取设备与原操作');return b&&!b.disabled;});}
 async function shot(name){await page.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo(0,0);});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});}
 const target=origin+'/app/search?q='+encodeURIComponent('合成设备入口')+'&source=public#original-help';
 await page.goto(target);await page.locator('.site-primary-nav').waitFor();await identity();await page.getByRole('button',{name:/^创建我的银河身份/}).click();await page.getByRole('heading',{name:'当前银河身份',exact:true}).waitFor();await settled();
 const subjectId=await page.locator('.identity-id').textContent();assert.match(subjectId,/^GUID[A-Z0-9]{28}$/);
 native=await createNativeRuntime({endpoint,website:'https://galaxy.example',trustedKeys:f.access.trustedKeys,dataDirectory:join(directory,'native'),now:()=>f.now,fetch:async(url,options)=>{assert.equal(new URL(url).origin,endpoint);return fetch(apiOrigin+new URL(url).pathname,options);}});
 const offer=await native.device.offer(subjectId,{confirmed:true});await page.locator('#existing-device > summary').click();await page.getByText('批准自己的新设备',{exact:true}).click();await page.locator('#identity-new-device-request').fill(JSON.stringify(offer));
 await button('查看设备与申请范围').click();await button('确认批准所选设备权限').click();await page.locator('#identity-return-approval').waitFor();
 const approval=JSON.parse(await page.locator('#identity-return-approval').inputValue());await native.device.accept(approval,{confirmed:true});await native.connect({confirmed:true});
 await button('连接并返回').click();await page.waitForURL(target);await settled();
 await page.setViewportSize({width:390,height:844});await identity();await button('断开本次连接').click();await settled();await managed();
 const before=(await f.identityControl.publicState(subjectId)),beforeEvents=JSON.stringify(before.events),commits=calls.filter(x=>x.path.endsWith('/identity/control/commit')).length;
 assert.equal(before.devices.length,2);await page.getByText('身份材料保存在本机，尚未连接当前服务。',{exact:true}).waitFor();
 const targetDevice=page.getByRole('article',{name:'设备 '+offer.deviceId,exact:true});await targetDevice.getByRole('button',{name:'核对撤销这台设备',exact:true}).click();await page.getByRole('heading',{name:'核对要撤销的设备',exact:true}).waitFor();
 await shot('full-main-device-preview-mobile');await button('暂不提交').click();await button('确认停止本机重试').click();await button('确认停止本机重试').waitFor({state:'hidden'});
 await button('回到原目标').click();await page.waitForURL(target);assert.equal(calls.filter(x=>x.path.endsWith('/identity/control/commit')).length,commits);
 assert.equal(JSON.stringify((await f.identityControl.publicState(subjectId)).events),beforeEvents);assert.equal((await f.identityControl.publicState(subjectId)).devices.find(x=>x.device_id===offer.deviceId).status,'active');
 await shot('returned-original-main-query-mobile');
 await identity();await managed();await page.getByText('本机保存的设备操作记录（1）',{exact:true}).click();await button('查看本机记录的回执').click();await page.getByText('已停止本机准备',{exact:true}).first().waitFor();
 await page.getByText('身份材料保存在本机，尚未连接当前服务。',{exact:true}).waitFor();assert.equal(await page.getByRole('article',{name:'本机设备管理原操作',exact:true}).count(),0);
 assert.equal(calls.filter(x=>x.path.endsWith('/identity/control/commit')).length,commits);await button('回到原目标').click();await page.waitForURL(target);assert.equal(pageErrors.length,0);
 checks.push({check:'Full production main/SiteShell desktop and mobile navigation: real browser identity and Native device approval, connect returns original query/hash, disconnect preserves public device control, exact revoke preview/local stop adds zero control events, original page returns and remount reads stopped local history',passed:true});
 console.log(JSON.stringify({passed:checks.length,pageErrors:pageErrors.length}));
}catch(error){checks.push({failed:error.message});if(page)await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{
 await writeFile(resolve(out,'report.json'),JSON.stringify({actualFullMainEntry:true,actualBrowser:true,actualWebRuntime:true,actualIndexedDB:true,actualHttp:true,actualNativeFS:true,actualPGlite:true,syntheticIdentityAndDevices:true,realUserPhysicalDeviceAcceptance:false,isolatedSevenCasesRepeated:false,checks,pageErrors,calls},null,2));
 await context?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();await native?.close();if(frontend?.listening){frontend.closeAllConnections();await new Promise(r=>frontend.close(r));}if(api?.listening){api.closeAllConnections();await new Promise(r=>api.close(r));}await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('galaxy-device-management-app-ui-'));await rm(target,{recursive:true,force:true});
}
