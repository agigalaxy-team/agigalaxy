import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,join,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {McpServer} from '@modelcontextprotocol/server';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {registerNativeCompactApps} from './server.mjs';
import {registerNativeWorkerTools} from '../worker-tools.mjs';
import {workerPanelResult} from './worker-result.mjs';
import {createNativeWorkerPackAdapter} from '../../../packages/galaxy-edge-mcp/src/native-v2/adapters/worker-pack.mjs';
import {createWorkerPackHostFlowV2} from '../../../packages/galaxy-a2a/src/worker-pack-flow-v2.mjs';

const compact=fileURLToPath(new URL('.',import.meta.url)),root=resolve(compact,'../../..'),out=resolve(root,'../../../07-logs/development/ui-resume-20261002/host-view-state');await mkdir(out,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'galaxy-host-view-browser-')),f=await serviceFixture(browserScopes),checks=[],errors=[],calls=[];
let api,runtime,mcp,client,registration,workerTools,workerAdapter,frontend,browser,heldRelease,heldReady,holdRead=false;
try{
 api=createApi({...f,rateLimit:1000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
 const options={dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,fetch:(url,options)=>fetch(base+new URL(url).pathname,options)};
 runtime=await createNativeRuntime(options);await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
 const child=await build({entryPoints:[resolve(compact,'browser.mjs')],bundle:true,write:false,format:'esm',platform:'browser'});
 const html='<div id="galaxy"></div><script type="module" src="/child.js"></script>',artifact={html,manifest:{uri:'ui://galaxy/synthetic-host-view.html',sha256:createHash('sha256').update(html).digest('hex')}};
 async function connectMcp(){mcp=new McpServer({name:'synthetic-host-view-fixture',version:'1'});registration=registerNativeCompactApps(mcp,{runtime,artifact});
  workerAdapter=createNativeWorkerPackAdapter({runtime,subjectId:runtime.api.snapshot().subjectId,now:()=>f.now});
  // Read-only configured catalog and real Native FS association list. No peer
  // or Pack operation is invoked by a display-preference exercise.
  const flow=createWorkerPackHostFlowV2({runtime:workerAdapter.runtime,a2a:{},packUses:workerAdapter.packUses,workers:[{id:'synthetic-catalog',peerId:'synthetic-catalog',pack:{builderId:'11111111-1111-4111-8111-111111111111',manifestId:'22222222-2222-4222-8222-222222222222',manifestHash:'a'.repeat(64)},sourceHash:'b'.repeat(64),version:'synthetic-display-only'}]});
  workerTools=registerNativeWorkerTools(mcp,{runtime,flow,review:async()=>{throw Error('display_fixture_has_no_execution');},render:data=>workerPanelResult(data,{componentOnly:true})});
  client=new Client({name:'synthetic-browser-host',version:'1'},{capabilities:{}});const[a,b]=InMemoryTransport.createLinkedPair();await mcp.connect(a);await client.connect(b);}
 await connectMcp();
 const parent=await build({stdin:{resolveDir:compact,contents:`
 import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
 let bridge,frame,workerMode=false;window.mode='inline';window.requests=[];window.denied=false;window.ready=0;
 const call=async input=>{const response=await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return response.json();};
 window.refreshPanel=async()=>{const r=await call(workerMode?{name:'galaxy_worker_host_read',arguments:{action:'list'}}:{name:'galaxy_panel',arguments:{}});await bridge.sendToolResult(r);};
 window.openPanel=async(name='synthetic-browser-host',modes=['inline','fullscreen'],worker=false)=>{
  if(bridge){await bridge.teardownResource({});await bridge.close();frame.remove();}
  workerMode=worker;window.mode='inline';frame=document.createElement('iframe');frame.title='Actual MCP App';frame.style='width:720px;height:690px;border:0';document.body.append(frame);
  bridge=new AppBridge(null,{name,version:'1'},{serverTools:{}},{hostContext:{displayMode:'inline',availableDisplayModes:modes}});
  bridge.oncalltool=call;bridge.onrequestdisplaymode=async({mode})=>{window.requests.push(mode);const actual=window.denied?'inline':mode;window.mode=actual;bridge.setHostContext({displayMode:actual,availableDisplayModes:modes});return{mode:actual};};
  bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await window.refreshPanel();window.ready++;};
  await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/child';
 };window.openPanel();
 `},bundle:true,write:false,format:'esm',platform:'browser'});
 frontend=createServer(async(req,res)=>{try{if(req.url==='/call'){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);calls.push({name:input.name,action:input.arguments?.action});const result=await client.callTool(input);if(holdRead&&input.name==='galaxy_host_view_state'&&input.arguments.action==='read'){holdRead=false;heldReady?.();await new Promise(ok=>heldRelease=ok);}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}
  res.setHeader('Content-Type',req.url?.endsWith('.js')?'text/javascript':'text/html');res.end(req.url==='/child.js'?child.outputFiles[0].text:req.url==='/parent.js'?parent.outputFiles[0].text:req.url==='/child'?html:'<script type="module" src="/parent.js"></script>');}catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.code??'fixture_failed'}));}});
 await new Promise(ok=>frontend.listen(0,'127.0.0.1',ok));browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 const page=await browser.newPage({viewport:{width:800,height:800}});page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+frontend.address().port);
 const panel=()=>page.frameLocator('iframe'),status=()=>panel().locator('.galaxy-host-view-status'),saveCount=()=>calls.filter(x=>x.name==='galaxy_host_view_state'&&x.action==='save').length;
 await status().filter({hasText:'显示偏好仅在你调整后'}).waitFor();assert.equal(saveCount(),0);
 await panel().getByRole('button',{name:'调整显示空间'}).click();await status().filter({hasText:'显示偏好已保存'}).waitFor();assert.equal(saveCount(),1);assert.equal(await page.evaluate(()=>window.mode),'fullscreen');
 await page.evaluate(()=>window.openPanel());await status().filter({hasText:'已恢复'}).waitFor();assert.equal(await page.evaluate(()=>window.mode),'fullscreen');assert.equal(saveCount(),1);checks.push({name:'Explicit host-confirmed choice persists across actual resource teardown/reopen through Native FS',passed:true});
 await page.screenshot({path:resolve(out,'restored-display-desktop.png')});
 await page.evaluate(()=>window.openPanel('another-synthetic-host'));await status().filter({hasText:'显示偏好仅在你调整后'}).waitFor();assert.equal(await page.evaluate(()=>window.mode),'inline');assert.equal(saveCount(),1);checks.push({name:'Distinct initialized host name has no inherited display preference',passed:true});
 await page.evaluate(()=>window.openPanel('synthetic-browser-host',['inline']));await status().filter({hasText:'当前不支持已保存'}).waitFor();await panel().getByRole('button',{name:'调整显示空间'}).click();await status().filter({hasText:'当前不支持所选'}).waitFor();assert.equal(saveCount(),1);checks.push({name:'Unsupported mode leaves persisted preference intact and makes no save',passed:true});
 await page.screenshot({path:resolve(out,'unsupported-host-preserves-preference.png')});
 await page.evaluate(()=>{window.denied=true;return window.openPanel();});await status().filter({hasText:'宿主采用了其他'}).waitFor();await panel().getByRole('button',{name:'调整显示空间'}).click();await status().filter({hasText:'宿主未采用'}).waitFor();assert.equal(saveCount(),1);await page.evaluate(()=>window.denied=false);checks.push({name:'Host rejection cannot overwrite remembered preference',passed:true});
 const ready=new Promise(ok=>heldReady=ok);holdRead=true;await page.evaluate(()=>window.openPanel());await ready;
 await runtime.connect({confirmed:true});await page.evaluate(()=>window.refreshPanel());await status().filter({hasText:'已恢复'}).waitFor();const requestCount=await page.evaluate(()=>window.requests.length);heldRelease();heldRelease=null;
 await page.waitForFunction(()=>window.mode==='fullscreen');await page.evaluate(()=>new Promise(ok=>setTimeout(ok,100)));assert.equal(await page.evaluate(()=>window.requests.length),requestCount);assert.equal(saveCount(),1);checks.push({name:'Same subject new binding fresh panel fences an old read response; no stale restore or save',passed:true});
 await client.close();registration.close();await workerTools.close();workerAdapter.close();await mcp.close();runtime.close();runtime=await createNativeRuntime(options);await runtime.connect({confirmed:true});await connectMcp();
 await page.evaluate(()=>window.openPanel());await status().filter({hasText:'已恢复'}).waitFor();assert.equal(await page.evaluate(()=>window.mode),'fullscreen');assert.equal(saveCount(),1);checks.push({name:'Actual NativeRuntime recreation from same filesystem retains only selected host preference',passed:true});
 const helpCalls=calls.filter(x=>x.name==='galaxy_panel').length;
 await page.evaluate(()=>window.openPanel('synthetic-direct-worker-host',['inline','fullscreen'],true));await status().filter({hasText:'显示偏好仅在你调整后'}).waitFor();await panel().getByText('在自己的宿主中继续工作',{exact:true}).waitFor();
 await panel().getByRole('button',{name:'调整显示空间'}).click();await status().filter({hasText:'显示偏好已保存'}).waitFor();assert.equal(saveCount(),2);
 await page.evaluate(()=>window.openPanel('synthetic-direct-worker-host',['inline','fullscreen'],true));await status().filter({hasText:'已恢复'}).waitFor();assert.equal(await page.evaluate(()=>window.mode),'fullscreen');assert.equal(saveCount(),2);assert.equal(calls.filter(x=>x.name==='galaxy_panel').length,helpCalls);
 assert.equal(calls.filter(x=>x.name.startsWith('galaxy_worker_')&&x.name!=='galaxy_worker_host_read').length,0);checks.push({name:'Direct Worker resource uses actual Native Worker ownerScope and FS association read; explicit preference saves and reopens without Help bootstrap',passed:true});await page.screenshot({path:resolve(out,'direct-worker-restored-display.png')});
 assert.deepEqual(errors,[]);const report={time:new Date().toISOString(),passed:checks.length,checks,pageErrors:errors,saveCalls:saveCount(),actualBrowser:true,actualOfficialAppBridge:true,actualMcpServer:true,actualNativeFilesystem:true,actualNativeRuntimeRecreated:true,actualDirectWorkerResource:true,actualHostUi:false,modelCalls:0,businessWrites:0};await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{heldRelease?.();await browser?.close();if(frontend?.listening)await new Promise(ok=>frontend.close(ok));await client?.close();registration?.close();await workerTools?.close();workerAdapter?.close();await mcp?.close();runtime?.close();if(api?.listening)await new Promise(ok=>api.close(ok));await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-host-view-browser-'));await rm(target,{recursive:true,force:true});}
