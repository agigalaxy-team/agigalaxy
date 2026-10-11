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

const compact=fileURLToPath(new URL('.',import.meta.url)),root=resolve(compact,'../../..'),out=resolve(root,'../../../07-logs/development/ui-resume-20261002/view-draft-return');
await mkdir(out,{recursive:true});const directory=await mkdtemp(join(tmpdir(),'galaxy-view-draft-return-')),f=await serviceFixture(browserScopes),checks=[],errors=[],calls=[],opened=[];
let api,runtime,mcp,client,registration,frontend,browser,failure;
const report={actualBrowser:true,actualOfficialAppBridge:true,actualMcpServer:true,actualNativeFilesystem:true,actualHostUi:false,modelCalls:0,fixtureRooms:2,syntheticAccountEligibility:true,checks,pageErrors:errors};
try{
 api=createApi({...f,rateLimit:1000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
 runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,fetch:(url,options)=>fetch(base+new URL(url).pathname,options),openBrowser:async url=>{opened.push(url);return{launched:true,state:'launch-requested'};}});
 await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
 // This display-only exercise does not test account verification. Limit the
 // eligibility fixture to the single actual enrolled Native identity.
 const subjectId=runtime.api.snapshot().subjectId;f.chat.requireAccountWithin=async(_tx,actor)=>assert.equal(actor.subjectId,subjectId);
 const rooms=[];for(const title of ['合成：原工作房间','合成：另一个房间']){const roomId=randomUUID();await runtime.api.call('/v2/chat/rooms/create',{roomId,operationId:randomUUID(),title,kind:'ordinary',taskRefs:[],retentionDays:90});rooms.push({kind:'room',id:roomId});}
 const child=await build({entryPoints:[resolve(compact,'browser.mjs')],bundle:true,write:false,format:'esm',platform:'browser'}),html='<div id="galaxy"></div><script type="module" src="/child.js"></script>';
 mcp=new McpServer({name:'synthetic-draft-return-fixture',version:'1'});registration=registerNativeCompactApps(mcp,{runtime,artifact:{html,manifest:{uri:'ui://galaxy/synthetic-draft-return.html',sha256:createHash('sha256').update(html).digest('hex')}}});
 client=new Client({name:'synthetic-draft-return-host',version:'1'},{capabilities:{}});const[a,b]=InMemoryTransport.createLinkedPair();await mcp.connect(a);await client.connect(b);
 const results=[];for(const object of rooms)results.push(await client.callTool({name:'galaxy_panel',arguments:{object,origin:{host:'synthetic-draft-return-host',workRef:'local-private-origin'}}}));
 const parent=await build({stdin:{resolveDir:compact,contents:`
 import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
 const frame=document.createElement('iframe');frame.title='Actual MCP App';frame.style='width:100%;height:820px;border:0';document.body.append(frame);
 const bridge=new AppBridge(null,{name:'synthetic-draft-return-host',version:'1'},{serverTools:{}},{hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen']}});
 bridge.oncalltool=async input=>(await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).json();
 bridge.onrequestdisplaymode=async({mode})=>{bridge.setHostContext({displayMode:mode,availableDisplayModes:['inline','fullscreen']});return{mode};};
 window.show=async index=>{const result=await(await fetch('/result/'+index)).json();await bridge.sendToolResult(result);};
 window.collapse=()=>frame.hidden=true;window.expand=()=>frame.hidden=false;
 window.closeResource=async()=>{await bridge.teardownResource({});await bridge.close();};
 bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await window.show(0);};
 await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/child';
 `},bundle:true,write:false,format:'esm',platform:'browser'});
 frontend=createServer(async(req,res)=>{try{if(req.url==='/call'){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);calls.push(input);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await client.callTool(input)));return;}
  if(req.url?.startsWith('/result/')){const original=results[Number(req.url.slice(8))];const refreshed=await client.callTool({name:'galaxy_panel_refresh',arguments:{viewId:original.structuredContent.viewId}});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(refreshed));return;}
  res.setHeader('Content-Type',req.url?.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/child.js'?child.outputFiles[0].text:req.url==='/parent.js'?parent.outputFiles[0].text:req.url==='/child'?html:'<meta charset="utf-8"><style>body{margin:0}</style><button id="host-toggle">合成宿主外部焦点</button><script type="module" src="/parent.js"></script>');}catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.code??'fixture_failed'}));}});
 await new Promise(ok=>frontend.listen(0,'127.0.0.1',ok));browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 const page=await browser.newPage({viewport:{width:960,height:980}});page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+frontend.address().port);
 const panel=page.frameLocator('iframe'),draft=panel.getByRole('textbox',{name:'仅在本机保留的笔记'}),summary=panel.getByText('本机笔记',{exact:true});
 await panel.getByRole('heading',{name:'合成：原工作房间',exact:true}).waitFor();await summary.focus();await page.keyboard.press('Enter');await page.keyboard.press('Tab');assert.equal(await draft.evaluate(el=>el===el.ownerDocument.activeElement),true);
 const noteA='原房间未发送，也未点击本机保存的笔记',noteB='另一个房间独立未发送笔记';await draft.fill(noteA);await page.setViewportSize({width:390,height:900});assert.equal(await draft.inputValue(),noteA);assert.equal(await draft.evaluate(el=>el===el.ownerDocument.activeElement),true);
 assert.equal(await panel.locator('html').evaluate(el=>el.scrollWidth>el.ownerDocument.defaultView.innerWidth),false);checks.push({name:'Narrow viewport retains unsent text and focused textarea; keyboard opens notes and enters editor',passed:true});
 await page.evaluate(()=>window.collapse());await page.locator('#host-toggle').focus();await page.evaluate(()=>window.expand());await summary.focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.keyboard.press('Tab');assert.equal(await draft.inputValue(),noteA);assert.equal(await draft.evaluate(el=>el===el.ownerDocument.activeElement),true);checks.push({name:'Host hide/show and keyboard-only notes collapse/expand preserve current object and unsent draft',passed:true});
 // Tab through the actual iframe, with no programmatic focus on the target.
 let reached=false;for(let i=0;i<32;i++){await page.keyboard.press('Tab');if(await panel.getByRole('button',{name:'打开完整网页',exact:true}).evaluate(el=>el===el.ownerDocument.activeElement)){reached=true;break;}}
 assert.equal(reached,true);await page.keyboard.press('Enter');await panel.getByRole('link',{name:'打开同一对象',exact:true}).waitFor();assert.deepEqual(opened,['https://selected.example/app/rooms/'+rooms[0].id]);assert.equal(await draft.inputValue(),noteA);checks.push({name:'Keyboard reaches complete-page navigation and opens only exact original Room without private note or origin',passed:true});
 await page.evaluate(()=>window.show(1));await panel.getByRole('heading',{name:'合成：另一个房间',exact:true}).waitFor();assert.equal(await draft.inputValue(),'');await draft.fill(noteB);
 await page.evaluate(()=>window.show(0));await panel.getByRole('heading',{name:'合成：原工作房间',exact:true}).waitFor();const observed=await draft.inputValue();report.originalReturn={expected:noteA,actual:observed,retained:observed===noteA};await page.screenshot({path:resolve(out,'original-room-return-mobile.png'),fullPage:true});
 assert.equal(observed,noteA,'PRE-M15-A03: switching to another object and back must retain the original unsent text');
 await page.evaluate(()=>window.show(1));await panel.getByRole('heading',{name:'合成：另一个房间',exact:true}).waitFor();assert.equal(await draft.inputValue(),noteB);checks.push({name:'Two actual Room views retain distinct unsent notes when switching back, without save or send',passed:true});
 await page.screenshot({path:resolve(out,'separate-room-note-mobile.png'),fullPage:true});
 const oldScope=(await client.callTool({name:'galaxy_panel_refresh',arguments:{viewId:results[0].structuredContent.viewId}})).structuredContent.ownerScope;await runtime.connect({confirmed:true});
 const newScope=(await client.callTool({name:'galaxy_panel_refresh',arguments:{viewId:results[0].structuredContent.viewId}})).structuredContent.ownerScope;assert.notEqual(newScope,oldScope);
 await page.evaluate(()=>window.show(0));await panel.getByRole('heading',{name:'合成：原工作房间',exact:true}).waitFor();assert.equal(await draft.inputValue(),'');await page.evaluate(()=>window.show(1));await panel.getByRole('heading',{name:'合成：另一个房间',exact:true}).waitFor();assert.equal(await draft.inputValue(),'');checks.push({name:'Actual same-subject new binding ownerScope clears both cached editors; fresh source permission is rechecked on every return',passed:true});
 await draft.fill('关闭资源后不得回显的未保存文字');await page.evaluate(()=>window.closeResource());assert.equal(await panel.getByRole('textbox',{name:'仅在本机保留的笔记'}).count(),0);await page.reload();await panel.getByRole('heading',{name:'合成：原工作房间',exact:true}).waitFor();await summary.click();assert.equal(await draft.inputValue(),'');checks.push({name:'Actual resource teardown clears local editor memory; reopening never restores unsaved text from another lifecycle',passed:true});
 report.localSaveCalls=calls.filter(x=>x.name==='galaxy_panel_draft_save').length;report.messageRows=(await f.db.query('SELECT count(*)::int n FROM chat_message_refs')).rows[0].n;assert.equal(report.localSaveCalls,0);assert.equal(report.messageRows,0);assert.deepEqual(errors,[]);
}catch(error){failure=error;report.failure={message:error.message,code:error.code??null};}
finally{report.passed=checks.length;report.success=!failure;report.calls=calls.map(x=>({name:x.name}));report.recordedAt=new Date().toISOString();await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));await browser?.close();if(frontend?.listening)await new Promise(ok=>frontend.close(ok));await client?.close();registration?.close();await mcp?.close();runtime?.close();if(api?.listening)await new Promise(ok=>api.close(ok));await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-view-draft-return-'));await rm(target,{recursive:true,force:true});}
if(failure)throw failure;
