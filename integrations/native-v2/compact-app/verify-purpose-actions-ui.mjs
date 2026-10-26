import {chromium} from 'playwright';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,join,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {sourceCapsule} from '../../../packages/galaxy-official/test/capsule-origin-continuity-v2-workflow.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../../../packages/galaxy-edge-mcp/src/native-v2/server.mjs';

const compact=fileURLToPath(new URL('.',import.meta.url)),preview=process.argv.includes('--preview');
const portArg=process.argv.find(value=>value.startsWith('--port=')),port=portArg?Number(portArg.slice(7)):0;
assert.ok(Number.isSafeInteger(port)&&(port===0||port>=1024&&port<=65535),'Valid loopback preview port required');
const out=fileURLToPath(new URL('../../../outputs/compact-purpose-actions/tmp/',import.meta.url));await mkdir(out,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'galaxy-purpose-actions-browser-')),f=await serviceFixture(browserScopes),checks=[],errors=[],calls=[];
let api,runtime,mcp,client,frontend,browser,failure,drop=false,writes=0;
const report={actualBrowser:true,actualOfficialAppBridge:true,actualMcpServer:true,actualNativeRuntime:true,actualSignedHttp:true,database:'PGlite',syntheticCapsuleSourceFacts:true,syntheticCurrentWork:true,physicalAiHostUi:false,realUserAcceptance:false,modelCalls:0,checks,pageErrors:errors};
try{
 const capsule=await sourceCapsule(f);
 api=createApi({...f,rateLimit:1000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
 runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
  fetch:async(url,options)=>{const path=new URL(url).pathname;if(path==='/v2/tasks'&&options.method==='POST')writes++;const response=await fetch(base+path,options);if(drop&&path==='/v2/tasks'&&response.status===200){drop=false;throw Error('synthetic_lost_original_ack');}return response;},openBrowser:async()=>({launched:false})});
 await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
 const help=await runtime.helpFlow.start({localTaskRef:'synthetic-original-work'}),operationId=randomUUID();
 const payload={operationId,taskId:randomUUID(),caseId:null,intent:'proactive-review',workContext:{goal:'检查文档解析条件',currentSituation:'合成当前工作：需要一个可执行的方法',attemptRefs:[]},title:'合成：接着完成文档解析',summary:'只发送所选解析问题与目标，不发送完整会话。',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
 const html='<meta charset="utf-8"><main id="galaxy"></main><script type="module" src="/child.js"></script>';
 mcp=createNativeToolServer(runtime,{compactArtifact:{html,manifest:{uri:'ui://galaxy/synthetic-purpose-actions.html',sha256:createHash('sha256').update(html).digest('hex')}}});
 client=new Client({name:'synthetic-purpose-actions-host',version:'1'},{capabilities:{}});const[a,b]=InMemoryTransport.createLinkedPair();await mcp.connect(a);await client.connect(b);
 const initial=await client.callTool({name:'galaxy_panel',arguments:{helpSessionId:help.id,origin:{host:'synthetic-purpose-actions-host',workRef:'synthetic-original-work'}}});
 await client.callTool({name:'galaxy_panel_action_prepare',arguments:{viewId:initial.structuredContent.viewId,action:{kind:'publish-task',payloadJson:JSON.stringify(payload,null,2)}}});
 const currentResult=async(kind='action')=>{
  if(kind==='error')return client.callTool({name:'galaxy_panel_refresh',arguments:{viewId:randomUUID()}});
  if(kind==='method')return client.callTool({name:'galaxy_panel',arguments:{object:{kind:'capsule',id:capsule.capsuleId,versionId:capsule.id},origin:{host:'synthetic-purpose-actions-host',workRef:'synthetic-original-work'}}});
  const shown=await client.callTool({name:'galaxy_panel',arguments:{helpSessionId:help.id,origin:{host:'synthetic-purpose-actions-host',workRef:'synthetic-original-work'}}});
  const op=shown.structuredContent.help.actionOperations.find(row=>row.operationId===operationId);
  return ['prepared','absent','conflict'].includes(op?.state)?client.callTool({name:'galaxy_panel_action_preview',arguments:{viewId:shown.structuredContent.viewId,operationId}}):shown;
 };
 const parent=await build({stdin:{resolveDir:compact,contents:`
  import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
  const frame=document.createElement('iframe');frame.title='Actual Native App';frame.style='width:100%;flex:1;min-height:0;border:0';document.body.append(frame);
  const bridge=new AppBridge(null,{name:'synthetic-purpose-actions-host',version:'1'},{serverTools:{},updateModelContext:{text:{}},openLinks:{}},{hostContext:{displayMode:'inline',availableDisplayModes:['inline']}});
  bridge.oncalltool=async input=>(await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).json();
  bridge.onopenlink=async({url})=>{window.open(url,'_blank');return{};};
  bridge.onupdatemodelcontext=async input=>{window.handoffs??=[];window.handoffs.push(input);document.getElementById('received').hidden=false;return{};};
  bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await(await fetch('/result?kind='+new URL(location.href).searchParams.get('kind'))).json());};
  await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/child';
 `},bundle:true,write:false,format:'esm',platform:'browser'});
 frontend=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/call'){let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);calls.push(input.name);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await client.callTool(input)));return;}
  if(url.pathname==='/result'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await currentResult(url.searchParams.get('kind')??'action')));return;}
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');
  if(url.pathname==='/child.js'){const child=await build({entryPoints:[resolve(compact,'browser.mjs')],bundle:true,write:false,format:'esm',platform:'browser'});res.end(child.outputFiles[0].text);return;}
  res.end(url.pathname==='/parent.js'?parent.outputFiles[0].text:url.pathname==='/child'?html:'<meta charset="utf-8"><style>body{margin:0;background:#faf9f6;height:100dvh;display:flex;flex-direction:column;overflow:hidden}#host-focus{margin:8px;align-self:flex-start}#received{padding:12px;margin:8px;background:white}</style><button id="host-focus">合成宿主：原工作焦点</button><p id="received" hidden>合成宿主：原工作已收到当前接续引用。</p><script type="module" src="/parent.js"></script>');
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.code??'synthetic_fixture_failed'}));}});
 await new Promise(ok=>frontend.listen(port,'127.0.0.1',ok));report.previewUrl='http://127.0.0.1:'+frontend.address().port;
 if(preview){console.log(JSON.stringify({previewUrl:report.previewUrl,methodUrl:report.previewUrl+'/?kind=method',errorUrl:report.previewUrl+'/?kind=error',actualNativeRuntime:true,physicalAiHostUi:false}));await new Promise(ok=>{process.once('SIGINT',ok);process.once('SIGTERM',ok);});}
 else{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:900},reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));await page.goto(report.previewUrl);const panel=page.frameLocator('iframe');
  await panel.getByText(payload.summary,{exact:true}).waitFor();assert.equal(writes,0);assert.equal(await panel.locator('pre').count(),0);assert.equal(await panel.getByText(/payloadHash|authorizationRequestId/).count(),0);
  await page.screenshot({path:resolve(out,'native-choice-input-mobile.png'),fullPage:true});
  const popup=page.waitForEvent('popup');await panel.getByRole('button',{name:'发布',exact:true}).click();const choice=await popup;await choice.waitForLoadState('domcontentloaded');
  assert.match(choice.url(),/^http:\/\/127\.0\.0\.1:\d+\/review\/[a-f0-9]{48}$/);await choice.getByText(payload.summary,{exact:true}).waitFor();assert.equal(writes,0);assert.equal(await panel.getByRole('button',{name:'等待你的选择',exact:true}).isDisabled(),true);assert.equal(await panel.getByRole('button',{name:'刷新',exact:true}).count(),0);
  await choice.screenshot({path:resolve(out,'native-real-choice-mobile.png'),fullPage:true});checks.push({name:'First actual user action opens the same trusted loopback review with readable content and blocks duplicate sending; opening alone writes zero tasks',passed:true});
  drop=true;await choice.getByRole('button',{name:'允许本次操作',exact:true}).click();await choice.getByText('已允许本次显示的操作。回到原聊天继续。',{exact:true}).waitFor();
  await page.bringToFront();await page.locator('#host-focus').click();await panel.getByRole('heading',{name:payload.title,exact:true}).waitFor();assert.equal(writes,1);assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1);
  checks.push({name:'Actual browser allows the exact review; the existing Native gate and signed HTTP submit one task and recover a dropped ACK without manual refresh',passed:true});
  await page.reload();await panel.getByRole('heading',{name:payload.title,exact:true}).waitFor();assert.equal(writes,1);assert.equal(await panel.getByRole('button',{name:'发布',exact:true}).count(),0);await page.screenshot({path:resolve(out,'native-choice-result-mobile.png'),fullPage:true});
  checks.push({name:'Reload reads the same original operation and task without another submission or another choice',passed:true});
  await page.goto(report.previewUrl+'/?kind=method');await panel.getByText('Compare selected conditions',{exact:true}).waitFor();await panel.getByRole('heading',{name:'解决方法',exact:true}).waitFor();assert.equal(await panel.locator('pre').count(),0);assert.equal(await panel.getByText(capsule.id,{exact:true}).count(),0);
  await page.screenshot({path:resolve(out,'method-mobile.png'),fullPage:true});await page.setViewportSize({width:780,height:900});await page.screenshot({path:resolve(out,'method-desktop.png'),fullPage:true});const beforeUses=Number((await f.db.query('SELECT count(*)::int n FROM capsule_uses_v2')).rows[0].n);
  await panel.getByRole('button',{name:'继续原工作',exact:true}).click();await page.getByText('合成宿主：原工作已收到当前接续引用。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.handoffs.length),1);assert.equal(Number((await f.db.query('SELECT count(*)::int n FROM capsule_uses_v2')).rows[0].n),beforeUses);
  checks.push({name:'Actual Capsule source/version read shows its authored method and returns current references to the original work; reading and returning create no reuse fact',passed:true});
  await page.goto(report.previewUrl+'/?kind=error');await panel.getByRole('heading',{name:'当前内容暂不可用',exact:true}).waitFor();assert.equal(await panel.getByRole('textbox',{name:'回复',exact:true}).isVisible(),false);assert.equal(await panel.getByRole('textbox',{name:'仅在本机保留的笔记'}).isVisible(),false);assert.equal(await panel.getByText('Compare selected conditions',{exact:true}).count(),0);await page.screenshot({path:resolve(out,'native-error-desktop.png'),fullPage:true});
  checks.push({name:'Initial read failure has a useful error and original-work return, without an empty conversation shell or formerly readable method',passed:true});
  assert.deepEqual(errors,[]);report.taskWrites=writes;report.calls=calls;report.capsuleReuseRows=Number((await f.db.query('SELECT count(*)::int n FROM capsule_uses_v2')).rows[0].n);
 }
}catch(error){failure=error;report.failure={message:error.message,code:error.code??null};}
finally{report.success=!failure;report.recordedAt=new Date().toISOString();const reportPath=resolve(out,preview?'native-preview-report.json':'native-report.json');await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({success:report.success,checks,errors,reportPath,failure:report.failure??null}));await browser?.close();if(frontend?.listening)await new Promise(ok=>frontend.close(ok));await client?.close();await mcp?.close();await runtime?.close();if(api?.listening){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-purpose-actions-browser-'));await rm(target,{recursive:true,force:true});}
if(failure)throw failure;
