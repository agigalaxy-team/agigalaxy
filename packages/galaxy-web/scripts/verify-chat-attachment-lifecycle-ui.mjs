import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {attachmentContractFixture} from '../../galaxy-official/test/chat-attachments-workflow.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=resolve(root,'../../../07-logs/development/ui-resume-20261002/chat-attachment-lifecycle');await mkdir(out,{recursive:true});
const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
const contract=attachmentContractFixture(),messages=new Map();let clock=f.now,syntheticAccountSubject;
Object.assign(f.attachments,contract);f.chat.now=()=>clock;f.attachments.now=()=>clock;
f.chat.requireAccountWithin=async(_db,actor)=>{assert.equal(actor.subjectId,syntheticAccountSubject,'isolated synthetic account registry');};
f.chat.transport={available:true,project:async()=>{},send:async x=>{messages.set(x.messageId,{archiveId:x.messageId,text:x.text,revision:1});return{archiveId:x.messageId};},read:async x=>x.ids.map(id=>messages.get(id)).filter(Boolean),erase:async x=>{messages.delete(x.archiveId??x.messageId);return{archiveDeleted:true};}};
const endpoint=f.access.endpoint,checks=[],calls=[],pageErrors=[],downloads=[];
let api,frontend,browser,context,page,crossSourceExpiry=false;
const originalGet=contract.store.get.bind(contract.store);
contract.store.get=async input=>{const bytes=await originalGet(input);if(crossSourceExpiry){crossSourceExpiry=false;clock+=2;}return bytes;};
try{
 api=createApi({...f,browserOrigins:['https://galaxy-ui.example.org'],rateLimit:10000});await new Promise(r=>api.listen(0,'127.0.0.1',r));const apiOrigin='http://127.0.0.1:'+api.address().port;
 const bundle=await build({stdin:{contents:`
  import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
  import {createWebRuntime,loadWebConfiguration} from './packages/galaxy-web/src/runtime.mjs';
  import {openDeviceKeyStore} from './packages/galaxy-core/src/domain/device-key-store.mjs';
  import {ChatWorkspace} from './packages/galaxy-web/src/chat-workspace.tsx';
  const root=createRoot(document.getElementById('root'));
  window.armGate=kind=>{window.gateKind=kind;window.gateEntered=false;window.gatePromise=new Promise(r=>window.releaseGate=r);};
  async function gate(kind,key){if(window.gateKind===kind&&key.includes(':chat-attachment-operation:')){window.gateKind=null;window.gateEntered=true;await window.gatePromise;}}
  function App({subjectId}){const [roomId,setRoomId]=useState();window.openRoom=id=>setRoomId(id);return <><p>隔离合成场景 · 实际浏览器钥库 · 存储、扫描与聊天传输 contract</p><ChatWorkspace runtime={rt} roomId={roomId} connected subjectId={subjectId} navigate={path=>{const id=/^\\/app\\/rooms\\/([0-9a-f-]{36})$/.exec(path)?.[1];window.currentRoom=id;setRoomId(id);}} needIdentity={()=>{}}/></>;}
  window.boot=async()=>{const store=await openDeviceKeyStore();window.deviceStore=store;
   const gated={...store,get:async key=>{const value=await store.get(key);await gate('get',key);return value;},put:async(key,value)=>{await store.put(key,value);await gate('put',key);}};
   window.rt=await createWebRuntime(await loadWebConfiguration(),{store:gated});await rt.createIdentity({confirmed:true});await rt.connect({confirmed:true});const subjectId=(await rt.status()).identity.subjectId;root.render(<App subjectId={subjectId}/>);return subjectId;};
 `,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root}});
 const cssPath=resolve(root,'packages/galaxy-web/dist/assets'),css=(await Promise.all((await readdir(cssPath)).filter(x=>x.endsWith('.css')).map(x=>readFile(resolve(cssPath,x),'utf8')))).join('\n')+await readFile(resolve(root,'packages/galaxy-web/src/workspace.css'),'utf8');
 frontend=createServer((req,res)=>{if(req.url==='/galaxy-web-config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,endpoint,signingKeys:[...f.bindings.trustedKeys].map(([kid,pin])=>({kid,...pin}))}));}
  else if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}
  else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body class="galaxy-site"><main class="workspace site-content" id="root"></main><script src="/bundle.js"></script></body></html>');}
 });await new Promise(r=>frontend.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+frontend.address().port;
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',acceptDownloads:true});context.setDefaultTimeout(15000);await context.addInitScript(now=>{Date.now=()=>now*1000;},f.now);
 await context.route(endpoint+'/**',async route=>{const req=route.request(),url=new URL(req.url());const call={path:url.pathname,method:req.method()};calls.push(call);
  const response=await context.request.fetch(apiOrigin+url.pathname+url.search,{method:req.method(),headers:{...req.headers(),origin:'https://galaxy-ui.example.org'},data:req.postDataBuffer()??undefined});call.status=response.status();
  if(url.pathname==='/v2/chat/attachments/prepare')call.attachmentId=JSON.parse(req.postData()).attachmentId;
  await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':origin}});
 });
 page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));page.on('download',download=>downloads.push(download));await page.goto(origin);await page.waitForFunction(()=>!!window.boot);const subjectId=await page.evaluate(()=>window.boot());syntheticAccountSubject=subjectId;
 const button=name=>page.getByRole('button',{name,exact:true}),file=Buffer.from('Synthetic attachment selected for one temporary room message.\n'),digest=createHash('sha256').update(file).digest('hex');
 const selectedFile={name:'synthetic-original.txt',mimeType:'text/plain',buffer:file};
 const uploadCount=()=>calls.filter(x=>x.path.endsWith('/upload')).length,prepareCount=()=>calls.filter(x=>x.path==='/v2/chat/attachments/prepare').length;
 async function idle(){await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(x=>['确认上传临时附件','确认恢复原上传'].includes(x.textContent));return b&&!document.querySelector('[role="status"]')?.textContent?.includes('正在上传')&&![...document.querySelectorAll('button')].some(x=>x.textContent==='中止本机传输');});}
 async function refresh(){await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
 async function shot(name,mobile=false){await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1000});await page.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo(0,0);});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});}
 await page.getByLabel('聊天名称',{exact:true}).fill('合成附件生命周期房间');await button('创建聊天').click();await page.getByRole('heading',{name:'合成附件生命周期房间',exact:true}).waitFor();const roomId=await page.evaluate(()=>window.currentRoom);
 await page.getByText('临时附件',{exact:true}).click();await page.locator('input[type=file]').waitFor();await page.waitForFunction(()=>!document.querySelector('input[type=file]').disabled);
 await page.locator('input[type=file]').setInputFiles(selectedFile);await page.getByText(/synthetic-original.txt ·/).waitFor();await page.locator('input[type=file]').setInputFiles([]);assert.equal(prepareCount(),0);assert.equal(uploadCount(),0);assert.ok(await button('确认上传临时附件').isDisabled());
 await page.locator('input[type=file]').setInputFiles(selectedFile);await page.evaluate(()=>window.armGate('get'));await button('确认上传临时附件').click();await page.waitForFunction(()=>window.gateEntered);
 const first=await page.evaluate(()=>rt.api.snapshot());await page.evaluate(async()=>{await rt.connect({confirmed:true});window.releaseGate();});await idle();const second=await page.evaluate(()=>rt.api.snapshot());assert.equal(first.subjectId,second.subjectId);assert.notEqual(first.bindingId,second.bindingId);assert.equal(prepareCount(),0);assert.equal(uploadCount(),0);
 assert.equal(Number((await f.db.query('SELECT count(*) n FROM chat_attachments')).rows[0].n),0);
 checks.push({check:'Actual ChatWorkspace file selection preview/cancel writes nothing; same-GUID real reconnect during an actual IndexedDB journal read prevents stale prepare and byte upload',passed:true});

 await page.locator('input[type=file]').setInputFiles(selectedFile);await page.evaluate(()=>window.armGate('put'));await button('确认上传临时附件').click();await page.waitForFunction(()=>window.gateEntered);
 await page.evaluate(async()=>{await rt.connect({confirmed:true});window.releaseGate();});await idle();assert.equal(prepareCount(),0);assert.equal(uploadCount(),0);
 const pending=await page.evaluate(roomId=>rt.getLocal('chat-attachment-operation:'+roomId),roomId);assert.equal(pending.input.sha256,digest);assert.equal(pending.bytes,undefined);assert.equal(pending.subjectId,subjectId);
 await button('确认恢复原上传').waitFor();await shot('reconnected-original-upload-retained-desktop');await page.locator('input[type=file]').setInputFiles(selectedFile);await button('确认恢复原上传').click();await idle();
 assert.equal(prepareCount(),1);assert.equal(uploadCount(),1);assert.equal(calls.find(x=>x.path==='/v2/chat/attachments/prepare').attachmentId,pending.input.attachmentId);
 await f.attachments.scanPending();await refresh();await page.getByRole('checkbox',{name:'随下一条消息发送',exact:true}).waitFor();
 const attachment=(await f.db.query('SELECT * FROM chat_attachments WHERE id=$1',[pending.input.attachmentId])).rows[0];assert.equal(Date.parse(attachment.expires_at)-Date.parse(attachment.uploaded_at),30*86400*1000);
 assert.equal(await page.evaluate(roomId=>rt.getLocal('chat-attachment-operation:'+roomId),roomId),null);
 checks.push({check:'Reconnect after actual IndexedDB journal write retains original ID/hash without file body; explicit same-file selection and retry uses that original ID once, scans, and preserves independent first-upload-plus-30-day expiry',passed:true});

 await page.getByRole('checkbox',{name:'随下一条消息发送',exact:true}).check();await button('撤销文件').click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(calls.filter(x=>x.path==='/v2/chat/attachments/revoke').length,0);
 await page.locator('.chat-compose textarea').fill('合成：仅把明确选中的临时文件随这条消息发送。');await button('发送').click();await page.getByLabel('消息附件',{exact:true}).waitFor();assert.equal(messages.size,1);
 const row=(await f.db.query('SELECT message_id FROM chat_attachments WHERE id=$1',[pending.input.attachmentId])).rows[0];assert.ok(row.message_id);
 await shot('explicit-selected-file-in-chat-mobile',true);
 checks.push({check:'Attachment revocation preview canceled with zero revoke; explicit selected reference is sent through production chat composer once and appears as a separately scoped message attachment',passed:true});

 await f.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1',[row.message_id,new Date((clock+1)*1000).toISOString()]);crossSourceExpiry=true;const beforeDownloads=downloads.length;
 await button('下载文件').click();await page.getByRole('alert').filter({hasText:'文件当前不可下载'}).waitFor();assert.equal(downloads.length,beforeDownloads);
 const contentCall=calls.filter(x=>x.path.endsWith('/content')).at(-1);assert.equal(contentCall.status,404);
 const still=(await f.db.query('SELECT state,expires_at FROM chat_attachments WHERE id=$1',[pending.input.attachmentId])).rows[0];assert.equal(still.state,'available');assert.ok(Date.parse(still.expires_at)>clock*1000);
 const downloadPromise=page.waitForEvent('download');await button('保存我的原文件').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),selectedFile.name);assert.equal(createHash('sha256').update(await readFile(await download.path())).digest('hex'),digest);
 assert.equal(calls.filter(x=>x.path.endsWith('/export-content')).at(-1).status,200);await refresh();await button('刷新').click();await page.getByText('当前页没有仍可见的消息。筛选或删除可能形成空页，有下一页时可以继续查看。',{exact:true}).waitFor();assert.equal(await button('下载文件').count(),0);
 await shot('expired-message-own-file-export-mobile',true);assert.equal(pageErrors.length,0);
 checks.push({check:'Source message expires across the actual storage await: normal download returns 404 with no downloaded body; owner independently exports exact retained file under current authorization with 200, and refreshed chat hides expired message/download',passed:true});
 console.log(JSON.stringify({passed:checks.length,pageErrors:pageErrors.length}));
}catch(error){checks.push({failed:error.message});if(page)await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{
 await writeFile(resolve(out,'report.json'),JSON.stringify({actualBrowser:true,productionChatWorkspace:true,productionAttachmentsUI:true,actualWebRuntime:true,actualWebCryptoIndexedDB:true,actualHttpPGlite:true,storage:'explicit contract Map object store',scanner:'explicit contract scanner',chatTransport:'explicit contract message transport',actualS3:false,actualProsody:false,accountRegistry:'explicit single synthetic-subject contract; public account verification not tested',deviceStore:'actual IndexedDB with deterministic post-read/post-write gates',syntheticOnly:true,checks,pageErrors,calls},null,2));
 await page?.evaluate(()=>{window.releaseGate?.();rt?.close();window.deviceStore?.close();}).catch(()=>{});await context?.unrouteAll({behavior:'ignoreErrors'});await browser?.close();if(frontend?.listening){frontend.closeAllConnections();await new Promise(r=>frontend.close(r));}if(api?.listening){api.closeAllConnections();await new Promise(r=>api.close(r));}await f.db.close();
}
