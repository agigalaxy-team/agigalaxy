import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {a2aPurposeFixture} from '../a2a-purpose-fixture.mjs';
import {workerComponentResult} from './worker-result.mjs';
const directory=fileURLToPath(new URL('.',import.meta.url)),preview=process.argv.includes('--preview'),port=Number(process.argv.find(a=>a.startsWith('--port='))?.slice(7)??0);
assert.ok(Number.isSafeInteger(port)&&(port===0||port>=1024&&port<=65535));
const out=resolve(directory,'../../../../../../07-logs/development/ui-reconstruction-20261009/native-a2a-batch');await mkdir(out,{recursive:true});
const html='<meta charset="utf-8"><main id="galaxy"></main><script type="module" src="/child.js"></script>';
const x=await a2aPurposeFixture({longPreview:preview,compactArtifact:{html,manifest:{uri:'ui://galaxy/synthetic-a2a-purpose.html',sha256:createHash('sha256').update(html).digest('hex')}}});
const checks=[],errors=[],report={actualBrowser:true,actualOfficialAppBridge:true,actualNativeRuntime:true,actualMcpServer:true,actualSignedHttp:true,database:'PGlite',actualReferenceNodeProcess:true,syntheticSourceWork:true,physicalAiHostUi:false,actualOpenCodeTui:false,realUserAcceptance:false,modelCalls:0,checks,pageErrors:errors};
let frontend,browser,failure,current;
try{
 const prepare=(work,values)=>x.raw('galaxy_a2a_work_prepare',{peerId:x.peer.id,action:'send',...Object.fromEntries(['caseId','attemptId','attemptVersion'].map(k=>[k,work[k]])),text:JSON.stringify({operation:'sum',values})});
 current=await prepare(x.primary,[19,23]);
 const parent=await build({stdin:{resolveDir:directory,contents:`
  import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
  const frame=document.createElement('iframe');frame.title='Actual Native App';frame.style='width:100%;flex:1;min-height:0;border:0';document.body.append(frame);
  const original=document.createElement('section');original.id='original-work';original.hidden=true;original.style='font:16px/1.7 Segoe UI,Microsoft YaHei,sans-serif;padding:24px;white-space:pre-wrap;overflow:auto';document.body.append(original);
  const bridge=new AppBridge(null,{name:'synthetic-a2a-purpose-host',version:'1'},{serverTools:{},openLinks:{},updateModelContext:{text:{}}},{hostContext:{displayMode:'inline',availableDisplayModes:['inline']}});
  bridge.oncalltool=async input=>(await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).json();
  bridge.onopenlink=async({url})=>{const u=new URL(url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.search||u.hash||!/^\\/review\\/[a-f0-9]{48}$/.test(u.pathname))return{isError:true};window.open(url,'_blank','noopener');return{};};
  bridge.onupdatemodelcontext=async input=>{window.handoffs??=[];window.handoffs.push(input);const refs=JSON.parse(input.content[0].text);if(refs.kind!=='galaxy-return-to-current-work')return{};
   const r=await(await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'galaxy_a2a_work_read',arguments:{action:'get',peerId:refs.peerId,associationId:refs.associationId}})})).json();original.replaceChildren();const h=document.createElement('h2');h.textContent='合成宿主：原工作已接回当前内容';const p=document.createElement('p');p.textContent=r.content.filter(x=>x.type==='text').map(x=>x.text).join('\\n\\n');original.append(h,p);original.hidden=false;frame.hidden=true;document.getElementById('host-focus').hidden=true;return{};};
  bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await(await fetch('/result')).json());};await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/child';
 `},bundle:true,write:false,format:'esm',platform:'browser'});
 frontend=createServer(async(req,res)=>{try{if(req.url==='/call'){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await x.raw(input.name,input.arguments)));return;}
  if(req.url==='/result'){const p=workerComponentResult(current).preview,rows=await x.host.read(x.peer.id,'list');if(p&&rows.some(r=>r.id===p.associationId))current=await x.raw('galaxy_a2a_work_read',{action:'get',peerId:x.peer.id,associationId:p.associationId});
   else if(p&&Date.parse(p.expiresAt)<=Date.now())current=await prepare(x.primary,[19,23]);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(current));return;}
  res.setHeader('Content-Type',req.url?.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');if(req.url==='/child.js'){const child=await build({entryPoints:[resolve(directory,'browser.mjs')],bundle:true,write:false,format:'esm',platform:'browser'});res.end(child.outputFiles[0].text);return;}
  res.end(req.url==='/parent.js'?parent.outputFiles[0].text:req.url==='/child'?html:'<meta charset="utf-8"><style>body{margin:0;background:#faf9f6;height:100dvh;display:flex;flex-direction:column;overflow:hidden}#host-focus{margin:8px;align-self:flex-start}iframe[hidden]{display:none!important}</style><button id="host-focus">合成宿主：原工作焦点</button><script type="module" src="/parent.js"></script>');
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.code??'a2a_fixture_incomplete'}));}});await new Promise(ok=>frontend.listen(port,'127.0.0.1',ok));report.previewUrl='http://127.0.0.1:'+frontend.address().port;
 if(preview){console.log(JSON.stringify({previewUrl:report.previewUrl,actualNativeRuntime:true,actualReferenceNodeProcess:true,physicalAiHostUi:false}));await new Promise(ok=>{process.once('SIGINT',ok);process.once('SIGTERM',ok);});}
 else{browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});const page=await browser.newPage({viewport:{width:390,height:900}});page.on('pageerror',e=>errors.push(e.message));await page.goto(report.previewUrl);const panel=page.frameLocator('iframe');
  await panel.getByRole('heading',{name:'交给所选服务处理',exact:true}).waitFor();assert.equal(await panel.locator('pre').count(),0);assert.equal((await x.processPeer.observations()).starts,0);
  await page.screenshot({path:resolve(out,'a2a-input-mobile.png'),fullPage:true});
  async function choose(name){const popup=page.context().waitForEvent('page');await panel.getByRole('button',{name,exact:true}).click();const choice=await popup;await choice.waitForLoadState();assert.equal(await panel.getByRole('button',{name:'等待你的选择',exact:true}).isDisabled(),true);assert.equal(await choice.locator('pre').count(),0);
   if(!checks.length)await choice.screenshot({path:resolve(out,'a2a-local-choice-mobile.png'),fullPage:true});await choice.getByRole('button',{name:'允许本次操作',exact:true}).click();await choice.close();await page.locator('#host-focus').click();}
  await choose('选择发送');await panel.getByText('42',{exact:true}).waitFor();assert.equal((await x.processPeer.observations()).starts,1);checks.push('实际 Native 本机选择后经 A2A SDK 启动一次真实 Node 对端，输出显示合计 42，没有自动保留结果。');
  assert.equal(x.state.resultWrites,0);assert.equal(await panel.getByRole('button',{name:'刷新',exact:true}).count(),0);await page.screenshot({path:resolve(out,'a2a-result-mobile.png'),fullPage:true});await page.setViewportSize({width:900,height:900});await page.screenshot({path:resolve(out,'a2a-result-desktop.png'),fullPage:true});
  await panel.getByText('保留结果',{exact:true}).click();await panel.getByRole('combobox',{name:'结果判断'}).selectOption('partial');await panel.getByRole('textbox',{name:'限制或补充（可选）'}).fill('合成：这里只完成所选数字的计算，尚未处理整个原工作。');await panel.getByRole('button',{name:'查看保存内容',exact:true}).click();
  await panel.getByText('部分完成',{exact:true}).waitFor();assert.equal(await panel.getByText(/External A2A participant report|Association [0-9a-f-]{36}/).count(),0);const beforeDraft=(await x.host.read(x.peer.id,'list'))[0].resultImportV2;
  await page.reload();await panel.getByRole('button',{name:'选择保存',exact:true}).waitFor();await panel.getByText('部分完成',{exact:true}).waitFor();await panel.getByText('合成：这里只完成所选数字的计算，尚未处理整个原工作。',{exact:true}).waitFor();
  const afterDraft=(await x.host.read(x.peer.id,'list'))[0].resultImportV2;assert.equal(afterDraft.payloadHash,beforeDraft.payloadHash);assert.equal(afterDraft.authorization.requestId,beforeDraft.authorization.requestId);assert.equal((await x.processPeer.observations()).starts,1);assert.equal(x.state.resultWrites,0);checks.push('保存预览显示所选部分完成与真实用户限制；重载从既有原草稿接回，原 payloadHash 与 Consent requestId 不变，系统来源只保留准确诊断。');
  await page.screenshot({path:resolve(out,'a2a-result-draft-mobile.png'),fullPage:true});x.state.dropResultAck=true;await choose('选择保存');await panel.getByText('这次结果已保留。',{exact:true}).waitFor();
  assert.equal(x.state.resultWrites,1);const events=(await x.f.db.query("SELECT payload_text FROM case_events WHERE kind='result-recorded'")).rows;assert.equal(events.length,1);assert.equal(JSON.parse(events[0].payload_text).reportedOutcome,'partial');checks.push('保留实际输出时另行选择 partial；真实签名导入丢失 ACK 后自动查询原 hash，只写入一次，没有把对端 completed 当作原问题成功。');
  await panel.getByRole('button',{name:'回到原工作',exact:true}).click();await page.getByRole('heading',{name:'合成宿主：原工作已接回当前内容',exact:true}).waitFor();assert.match(await page.locator('#original-work').innerText(),/42/);assert.equal(await page.evaluate(()=>window.handoffs.length),1);assert.equal((await x.processPeer.observations()).starts,1);checks.push('一次实际 AppBridge 接回当前引用，外层原工作可见合计 42；没有重派或新的 Result。');
  await page.reload();await panel.getByText('42',{exact:true}).waitFor();assert.equal((await x.processPeer.observations()).starts,1);checks.push('重新加载自动读取原关联和当前结果，没有消费旧句柄重新派发。');
  current=await prepare(x.unknown,[5,8]);x.processPeer.state.loseSendAck=true;await page.reload();await choose('选择发送');await panel.getByText('正在确认原操作的结果。',{exact:true}).waitFor();const starts=(await x.processPeer.observations()).starts;await page.waitForTimeout(1800);assert.equal((await x.processPeer.observations()).starts,starts);assert.equal(starts,2);checks.push('初次发送实际完成但 ACK 丢失时，保留原关联并读取为未知；不猜 Task ID、不自动补发。');
  assert.deepEqual(errors,[]);report.resultWrites=x.state.resultWrites;report.peerObservations=await x.processPeer.observations();report.calls=x.calls;
 }
}catch(error){failure=error;report.failure={message:error.message};}
finally{report.success=!failure;report.recordedAt=new Date().toISOString();const reportPath=resolve(out,preview?'a2a-preview-report.json':'report.json');await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({success:report.success,checks,pageErrors:errors,reportPath,failure:report.failure??null}));await browser?.close();if(frontend?.listening){frontend.closeAllConnections();await new Promise(ok=>frontend.close(ok));}await x.close();}
if(failure)throw failure;
