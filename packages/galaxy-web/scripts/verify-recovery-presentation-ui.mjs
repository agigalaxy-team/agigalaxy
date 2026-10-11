import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createServices} from '../../galaxy-official/src/services.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)),out=resolve(root,'../../../07-logs/development/ui-resume-20261002/recovery-presentation');await mkdir(out,{recursive:true});
let clock=Math.floor(Date.now()/1000);const f=await serviceFixture(browserScopes,null,{now:clock}),key=generateKeyPairSync('ed25519'),kid='privacy-ui';
const trustedKeys=new Map([[kid,{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:clock-1,notAfter:clock+200000,revoked:false}]]),endpoint=f.access.endpoint;
const services=createServices({db:f.db,endpoint,kid,signingKey:key.privateKey,trustedKeys,allowedScopes:browserScopes,operator:'Synthetic privacy UI fixture',region:'test',now:()=>clock});
const eligible=new Set();services.chat.requireAccountWithin=async(_tx,actor)=>assert.ok(eligible.has(actor.subjectId));services.chat.transport={available:true,project:async()=>{},read:async()=>[]};
let api,frontend,browser,page,context,loseAck=false,expireAfterPage=null;const calls=[],downloads=[],checks=[],pageErrors=[];
try{
 api=createApi({...services,browserOrigins:['https://galaxy-ui.example.org'],rateLimit:10000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const apiOrigin='http://127.0.0.1:'+api.address().port;
 const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {createWebRuntime,loadWebConfiguration} from './packages/galaxy-web/src/runtime.mjs';
 import {openDeviceKeyStore} from './packages/galaxy-core/src/domain/device-key-store.mjs';
 import {PrivacyWorkspace} from './packages/galaxy-web/src/privacy-workspace.tsx';
 import {ChatAgentWorkspace} from './packages/galaxy-web/src/chat-agent-workspace.tsx';
 const root=createRoot(document.getElementById('root'));
 window.arm=(kind,match)=>{window.gate={kind,match};window.gateEntered=false;window.gatePromise=new Promise(resolve=>window.releaseGate=resolve);};
 async function gate(kind,text){if(window.gate?.kind===kind&&text.includes(window.gate.match)){window.gate=null;window.gateEntered=true;await window.gatePromise;}}
 const originalDigest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=async(algorithm,bytes)=>{const value=await originalDigest(algorithm,bytes);await gate('digest',new TextDecoder().decode(bytes));return value;};
 window.boot=async()=>{const store=await openDeviceKeyStore();window.store=store;
 const gated={...store,get:async key=>{const value=await store.get(key);await gate('get',key);return value;},put:async(key,value)=>{await store.put(key,value);await gate('put',key);}};
 window.rt=await createWebRuntime(await loadWebConfiguration(),{store:gated});let state=await rt.status();if(!state.identity)await rt.createIdentity({confirmed:true});await rt.connect({confirmed:true});state=await rt.status();window.owner=state.identity.subjectId;window.deviceId=state.identity.deviceId;
 root.render(<><p>合成资料管理场景 · 实际浏览器身份、钥库与签名 HTTP</p><PrivacyWorkspace runtime={rt} connected subjectId={window.owner} navigate={()=>{}}/></>);return window.owner;};
 window.showAgent=room=>root.render(<><p>合成 Agent 权限展示恢复 · 实际身份、钥库和签名 HTTP</p><ChatAgentWorkspace runtime={rt} room={room} navigate={()=>{}}/></>);
 window.closePage=()=>{root.unmount();rt.close();document.getElementById('root').textContent='资料管理页已关闭';};
 `,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root}});
 const cssDir=resolve(root,'packages/galaxy-web/dist/assets'),css=(await Promise.all((await readdir(cssDir)).filter(x=>x.endsWith('.css')).map(x=>readFile(resolve(cssDir,x),'utf8')))).join('\n')+await readFile(resolve(root,'packages/galaxy-web/src/workspace.css'),'utf8');
 frontend=createServer((req,res)=>{if(req.url==='/galaxy-web-config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,endpoint,signingKeys:[...trustedKeys].map(([kid,pin])=>({kid,...pin}))}));}else if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body class="galaxy-site"><main class="workspace site-content" id="root"></main><script src="/bundle.js"></script></body></html>');}});await new Promise(ok=>frontend.listen(0,'127.0.0.1',ok));
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});context=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:'UTC',reducedMotion:'reduce',acceptDownloads:true});context.setDefaultTimeout(15000);
 await context.addInitScript(now=>{window.testNow=now;Date.now=()=>window.testNow*1000;},clock);
 await context.route(endpoint+'/**',async route=>{const req=route.request(),url=new URL(req.url()),entry={path:url.pathname,method:req.method()};calls.push(entry);
  const response=await context.request.fetch(apiOrigin+url.pathname+url.search,{method:req.method(),headers:{...req.headers(),origin:'https://galaxy-ui.example.org'},data:req.postDataBuffer()??undefined});entry.status=response.status();
  if(entry.path==='/v1/data-exports/page'&&expireAfterPage){clock=expireAfterPage;expireAfterPage=null;}
  if(loseAck&&entry.path==='/v1/deletion-requests/submit'){loseAck=false;assert.equal(entry.status,200);await route.abort('failed');return;}await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':'http://127.0.0.1:'+frontend.address().port}});
 });
 page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));page.on('download',d=>downloads.push(d));await page.goto('http://127.0.0.1:'+frontend.address().port);const owner=await page.evaluate(()=>window.boot());eligible.add(owner);
 const button=name=>page.getByRole('button',{name,exact:true});const idle=()=>page.waitForFunction(()=>!document.querySelector('#privacy-export button')?.disabled);
 const shot=async(name,mobile=false)=>{await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1100});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});};
 const marker='SYNTHETIC_PRIVATE_EXPORT_'+randomUUID(),id=randomUUID();await page.evaluate(async({id,marker})=>{const value={id,kind:'case',localRef:crypto.randomUUID(),title:'合成隐私导出材料',summary:marker,source:{kind:'local',reference:'privacy-ui'},participants:[{subjectId:window.owner,role:'requester'}]};await rt.api.call('/v1/cases',await rt.api.authorizePayload(value,{action:'case.teaser.publish',objectId:id,confirmed:true}));},{id,marker});
 async function createExport(labels=['案例事件']){await button('读取当前可导出范围').click();await button('清空选择').click();const summary=page.getByText(/^所选本人数据集（/);if(!await summary.evaluate(e=>e.parentElement.open))await summary.click();for(const label of labels)await page.getByLabel(label,{exact:true}).check();await summary.click();await button('确认此范围，创建下载').click();await idle();return page.evaluate(async()=>{const value=await rt.privacy.exportOperation();return value.ticket.id;});}
 async function startGate(kind,match,action){await page.evaluate(({kind,match})=>window.arm(kind,match),{kind,match});await action();await page.waitForFunction(()=>window.gateEntered);}
 async function rebindRelease(){const before=await page.evaluate(()=>rt.api.snapshot());await page.evaluate(async()=>{await rt.connect({confirmed:true});window.releaseGate();});await idle();const after=await page.evaluate(()=>rt.api.snapshot());assert.equal(after.subjectId,before.subjectId);assert.notEqual(after.generation,before.generation);}

 const submitCount=()=>calls.filter(x=>x.path==='/v1/deletion-requests/submit').length;

 const ticket=await createExport(['案例事件','公开身份材料']),expiry=clock+2;
 await f.db.query('UPDATE data_exports SET expires_at=$2 WHERE id=$1',[ticket,new Date(expiry*1000).toISOString()]);expireAfterPage=expiry+1;
 await button('读取所选资料').click();await button('保存未完成清单').waitFor();await idle();
 await page.getByText('下载记录已过期或撤销。已合法读取的部分可保存；继续前请关闭原下载记录后重新选择。',{exact:true}).waitFor();
 assert.equal((await page.locator('body').innerText()).includes('export_expired'),false);
 await button('保存资料文件').click();await button('保存未完成清单').click();await page.waitForFunction(()=>true);assert.equal(downloads.length,2);
 const content=await readFile(await downloads[0].path(),'utf8'),manifest=JSON.parse(await readFile(await downloads[1].path(),'utf8'));
 assert.equal(manifest.complete,false);assert.equal(manifest.pages.length,1);assert.equal(manifest.dataSha256,createHash('sha256').update(content).digest('hex'));assert.equal(manifest.incompleteReason,'export_expired');assert.ok(content.includes(marker)||content.includes(owner));
 await shot('expired-ticket-partial-readable-mobile',true);await button('清除此页内存副本').click();await button('关闭下载记录').click();await idle();await page.evaluate(value=>window.testNow=value,clock);
 checks.push({check:'Actual export ticket expiry between signed pages keeps lawful partial bytes/hash and original manifest machine code, while page explains expiry in Chinese',passed:true});

 await page.locator('label').filter({hasText:'所需资料'}).locator('select').selectOption('not-needed');await button('查看申请预览').click();await button('签名并提交此操作').waitFor();
 const device=await page.evaluate(()=>window.deviceId);await startGate('get','device:'+owner+':'+device,()=>button('签名并提交此操作').click());await rebindRelease();
 assert.equal(submitCount(),0);assert.equal(await button('签名并提交此操作').count(),0);
 await page.getByRole('alert').filter({hasText:'旧预览已收起'}).waitFor();assert.equal((await page.locator('body').innerText()).includes('privacy_authority_changed'),false);
 await shot('expired-private-preview-hidden-mobile',true);
 await button('查看申请预览').click();await button('签名并提交此操作').waitFor();await startGate('put',':deletion-operation',()=>button('签名并提交此操作').click());await rebindRelease();
 assert.equal(await button('签名并提交此操作').count(),0);assert.equal(submitCount(),0);
 const pending=await page.evaluate(()=>rt.privacy.pendingDeletion());assert.equal(pending.intent.subjectId,owner);assert.equal(pending.payloadHash,createHash('sha256').update(pending.payloadJson).digest('hex'));
 await button('查询原操作').click();await idle();await page.getByText('尚未查到原操作的受理事件。',{exact:true}).waitFor();assert.equal(submitCount(),0);const retained=await page.evaluate(()=>rt.privacy.pendingDeletion());assert.equal(retained.intent.id,pending.intent.id);assert.equal(retained.payloadHash,pending.payloadHash);
 checks.push({check:'Actual privacy signer and pending IDB completion reconnect hide stale deletion preview, show actionable Chinese message and retain original ID/hash with zero dispatch; explicit original query stays read-only',passed:true});

 const room=await page.evaluate(()=>rt.chat.create({title:'合成 Agent 恢复提示'},{confirmed:true}));await page.evaluate(room=>window.showAgent(room),room);await page.getByText('我的 Agent 与 AI 子区',{exact:true}).click();
 const agentIdle=()=>page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='创建 AI 子区')?.disabled);
 await agentIdle();const before=await page.evaluate(()=>rt.api.snapshot());const select=label=>page.locator('label').filter({hasText:label}).locator('select');
 await select('我的客户端').selectOption(before.bindingId);await select('参与方式').selectOption('read');await button('查看这次授权').click();await button('确认这项权限操作').waitFor();
 await startGate('put',':chat-agent-operation:',()=>button('确认这项权限操作').click());await page.evaluate(async()=>{await rt.connect({confirmed:true});window.releaseGate();});await agentIdle();
 await page.getByRole('status').filter({hasText:'旧权限预览已收起'}).waitFor();assert.equal(await button('确认这项权限操作').count(),0);assert.equal(await button('查询并继续原操作').count(),1);
 assert.equal((await page.locator('body').innerText()).includes('receipt_status_authority_changed'),false);assert.equal(calls.filter(x=>x.path.endsWith('/agent-grant')).length,0);
 const journal=await page.evaluate(id=>rt.getLocal('chat-agent-operation:'+id),room.roomId);assert.equal(journal.subjectId,owner);assert.equal(journal.input.bindingId,before.bindingId);assert.equal(journal.acknowledged,undefined);
 await shot('agent-stale-preview-hidden-original-operation-visible-mobile',true);
 checks.push({check:'Full ChatAgentWorkspace actual IDB-save reconnect hides old confirm button, explains current connection failure and exposes original pending operation without grant/retry/model call',passed:true});
 assert.deepEqual(pageErrors,[]);const report={passed:checks.length,checks,pageErrors,counts:{deletionSubmits:submitCount(),agentGrants:calls.filter(x=>x.path.endsWith('/agent-grant')).length,browserDownloads:downloads.length},limitations:['Complete production PrivacyWorkspace and ChatAgentWorkspace with actual WebRuntime/WebCrypto/IndexedDB and signed HTTP/PGlite; no full main router or live-user claim.','Synthetic case, account eligibility, empty room transport and short ticket expiry only; actual client errors and local journals are not replaced.','Existing consent clients, runtime and main remain unchanged. No automatic original-operation retry or deletion.']};await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+String.fromCharCode(10));console.log(JSON.stringify(report));
}catch(error){if(page){await writeFile(resolve(out,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:resolve(out,'failure.png'),fullPage:true});}throw error;}finally{if(browser)await browser.close();if(frontend)await new Promise(ok=>frontend.close(ok));if(api){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f.db.close();}
