import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,join,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {McpServer} from '@modelcontextprotocol/server';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {registerNativeCompactApps} from './server.mjs';
import {syntheticMessageTransport} from './purpose-fixture.mjs';

const compact=fileURLToPath(new URL('.',import.meta.url)),root=resolve(compact,'../../..');
const previewMode=process.argv.includes('--preview');
const out=resolve(root,'../../../07-logs/development/ui-reconstruction-20261009/native-first-batch');await mkdir(out,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'galaxy-purpose-browser-')),f=await serviceFixture(browserScopes),checks=[],errors=[],calls=[],opened=[];
let api,runtime,mcp,client,registration,frontend,browser,failure,drop=false,sendCalls=0;
const report={actualBrowser:true,actualOfficialAppBridge:true,actualMcpServer:true,actualSignedHttp:true,actualNativeFilesystem:true,
 syntheticMessageTransport:true,syntheticCommunityEligibility:true,physicalAiHostUi:false,realProsodyDelivery:false,realUserAcceptance:false,modelCalls:0,checks,pageErrors:errors};
try{
 api=createApi({...f,rateLimit:1000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
 runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
  fetch:async(url,options)=>{const path=new URL(url).pathname;if(path.endsWith('/send'))sendCalls++;const result=await fetch(base+path,options);if(drop&&path.endsWith('/send')&&result.status===200){drop=false;throw Error('synthetic_lost_ack');}return result;},
  openBrowser:async url=>{opened.push(url);return{launched:true};}});
 await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});const subjectId=runtime.api.snapshot().subjectId;
 f.chat.requireAccountWithin=async(_tx,actor)=>assert.equal(actor.subjectId,subjectId);f.chat.transport=syntheticMessageTransport();
 const roomId=randomUUID(),grantId=randomUUID();await runtime.api.call('/v2/chat/rooms/create',{roomId,operationId:randomUUID(),title:'合成：继续文档解析工作',kind:'ordinary',taskRefs:[],retentionDays:90});
 await runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-grant',{grantId,bindingId:runtime.api.snapshot().bindingId,mode:'respond',primaryResponder:false,expiresAt:f.now+3600});
 const message=text=>runtime.api.call('/v2/chat/rooms/'+roomId+'/send',{clientMessageId:randomUUID(),text,replyTo:null,agentGrantId:grantId});
 await message('合成内容：已找到解析错误的位置，先检查这个小片段。');
 const child=await build({entryPoints:[resolve(compact,'browser.mjs')],bundle:true,write:false,format:'esm',platform:'browser'}),html='<main id="galaxy"></main><script type="module" src="/child.js"></script>';
 mcp=new McpServer({name:'synthetic-purpose-browser-fixture',version:'1'});registration=registerNativeCompactApps(mcp,{runtime,artifact:{html,manifest:{uri:'ui://galaxy/synthetic-purpose-browser.html',sha256:createHash('sha256').update(html).digest('hex')}}});
 client=new Client({name:'synthetic-browser-host',version:'1'},{capabilities:{}});const[a,b]=InMemoryTransport.createLinkedPair();await mcp.connect(a);await client.connect(b);
 const result=await client.callTool({name:'galaxy_panel',arguments:{object:{kind:'room',id:roomId},origin:{host:'synthetic-browser-host',workRef:'private-original-work'}}});
 const parent=await build({stdin:{resolveDir:compact,contents:`
  import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
  const frame=document.createElement('iframe');frame.title='Actual MCP App';frame.style='width:100%;height:910px;border:0';document.body.append(frame);
  const bridge=new AppBridge(null,{name:'synthetic-browser-host',version:'1'},{serverTools:{},updateModelContext:{text:{}}},{hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen']}});
  bridge.oncalltool=async input=>(await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).json();
  bridge.onupdatemodelcontext=async input=>{window.handoffs??=[];window.handoffs.push(input);return{};};
  bridge.onrequestdisplaymode=async({mode})=>{bridge.setHostContext({displayMode:mode,availableDisplayModes:['inline','fullscreen']});return{mode};};
  bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await(await fetch('/result')).json());};
  await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/child';
 `},bundle:true,write:false,format:'esm',platform:'browser'});
 frontend=createServer(async(req,res)=>{try{if(req.url==='/call'){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);calls.push(input);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await client.callTool(input)));return;}
   if(req.url==='/result'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}
   res.setHeader('Content-Type',req.url?.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/child.js'?child.outputFiles[0].text:req.url==='/parent.js'?parent.outputFiles[0].text:req.url==='/child'?html:'<meta charset="utf-8"><style>body{margin:0;background:#faf9f6}#host-focus{margin:8px}</style><button id="host-focus">合成宿主：原工作焦点</button><script type="module" src="/parent.js"></script>');
  }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.code??'synthetic_fixture_failed'}));}});
 await new Promise(ok=>frontend.listen(0,'127.0.0.1',ok));
 if(previewMode){report.previewUrl='http://127.0.0.1:'+frontend.address().port;console.log(JSON.stringify({previewUrl:report.previewUrl,syntheticMessageTransport:true,physicalAiHostUi:false}));await new Promise(ok=>{process.once('SIGINT',ok);process.once('SIGTERM',ok);});}
 else{
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 const page=await browser.newPage({viewport:{width:390,height:1000},reducedMotion:'reduce'});page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+frontend.address().port);
 const panel=page.frameLocator('iframe'),reply=panel.getByRole('textbox',{name:'回复',exact:true}),note=panel.getByRole('textbox',{name:'仅在本机保留的笔记'});
 await panel.getByRole('heading',{name:'合成：继续文档解析工作'}).waitFor();await panel.getByText('合成内容：已找到解析错误的位置，先检查这个小片段。',{exact:true}).waitFor();
 assert.equal(await panel.locator('pre').count(),0);assert.equal(await panel.getByText(/回执|operationId|payloadHash|准确来源与版本/).count(),0);assert.equal(await panel.locator('html').evaluate(el=>el.scrollWidth>el.ownerDocument.defaultView.innerWidth),false);
 await page.screenshot({path:resolve(out,'conversation-mobile.png'),fullPage:true});checks.push({name:'390px panel opens on actual permitted messages and reply; no technical record wall or horizontal overflow',passed:true});
 await panel.getByText('本机笔记',{exact:true}).focus();await page.keyboard.press('Enter');await page.keyboard.press('Tab');assert.equal(await note.evaluate(el=>el===el.ownerDocument.activeElement),true);await note.fill('本机未发送的合成笔记');
 await reply.fill('未发送的合成回复');await panel.getByText('草稿已保存在本机。',{exact:true}).waitFor();
 const before=sendCalls;drop=true;await reply.fill('合成回复：继续原来的解析工作。');await panel.getByRole('button',{name:'发送',exact:true}).click();await panel.getByText('合成回复：继续原来的解析工作。',{exact:true}).waitFor();assert.equal(await reply.inputValue(),'');assert.equal(sendCalls,before+1);
 await panel.getByText('草稿已保存在本机。',{exact:true}).waitFor({state:'hidden'});await page.screenshot({path:resolve(out,'conversation-sent-mobile.png'),fullPage:true});
 assert.equal((await f.db.query('SELECT count(*)::int n FROM chat_message_refs')).rows[0].n,2);checks.push({name:'Actual MCP/HTTP reply sends once, lost response reconciles automatically, composer and saved-draft hint clear only after acceptance',passed:true});
 await reply.fill('返回后继续写的合成回复');await panel.getByText('草稿已保存在本机。',{exact:true}).waitFor();await panel.getByRole('button',{name:'打开完整对话',exact:true}).click();await panel.getByRole('link',{name:'打开同一对象'}).waitFor();assert.deepEqual(opened,['https://selected.example/app/rooms/'+roomId]);
 await message('合成更新：网页期间新增的内容。');const priorReturns=calls.filter(x=>x.name==='galaxy_panel_return').length;
 await page.locator('#host-focus').click();await panel.getByRole('heading',{name:'合成：继续文档解析工作'}).click();await panel.getByText('合成更新：网页期间新增的内容。',{exact:true}).waitFor();
 assert.ok(calls.filter(x=>x.name==='galaxy_panel_return').length>priorReturns);assert.equal(await reply.inputValue(),'返回后继续写的合成回复');assert.equal(await note.inputValue(),'本机未发送的合成笔记');checks.push({name:'Actual browser focus return reopens original navigation automatically and retains both drafts',passed:true});
 await reply.focus();await page.setViewportSize({width:720,height:1000});assert.equal(await reply.evaluate(el=>el===el.ownerDocument.activeElement),true);assert.equal(await reply.inputValue(),'返回后继续写的合成回复');await page.screenshot({path:resolve(out,'conversation-desktop.png'),fullPage:true});
 await runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-revoke',{grantId});await page.locator('#host-focus').click();await panel.getByRole('heading',{name:'合成：继续文档解析工作'}).click();await panel.getByRole('button',{name:'打开完整对话回复'}).waitFor();assert.equal(await reply.isVisible(),false);checks.push({name:'Current grant revocation removes sending and preserves same-web-conversation fallback',passed:true});
 await runtime.api.call('/v2/chat/rooms/'+roomId+'/leave',{});await page.locator('#host-focus').click();await panel.getByRole('heading',{name:'合成：继续文档解析工作'}).click();await panel.getByText('这份内容暂时无法读取。输入仍然保留。',{exact:true}).waitFor();assert.equal(await panel.getByText('合成更新：网页期间新增的内容。',{exact:true}).count(),0);assert.equal(await note.inputValue(),'本机未发送的合成笔记');checks.push({name:'Leaving room hides all formerly readable messages and retains device-local note',passed:true});
 assert.deepEqual(errors,[]);report.messageRows=(await f.db.query('SELECT count(*)::int n FROM chat_message_refs')).rows[0].n;report.sendCalls=sendCalls;report.navigationUrls=opened;report.calls=calls.map(c=>c.name);
 }
}catch(e){failure=e;report.failure={message:e.message,code:e.code??null};}
finally{report.success=!failure;report.recordedAt=new Date().toISOString();const reportPath=resolve(out,previewMode?'preview-report.json':'report.json');await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({success:report.success,checks,errors,reportPath,failure:report.failure??null}));await browser?.close();if(frontend?.listening)await new Promise(ok=>frontend.close(ok));await client?.close();registration?.close();await mcp?.close();runtime?.close();if(api?.listening)await new Promise(ok=>api.close(ok));await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-purpose-browser-'));await rm(target,{recursive:true,force:true});}
if(failure)throw failure;
