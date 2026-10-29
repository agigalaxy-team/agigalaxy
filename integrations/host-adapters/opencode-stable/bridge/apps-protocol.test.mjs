import {copyLegacyNativeFixture} from './legacy-native-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const require=createRequire(new URL('../../../native-v2/compact-app/package.json',import.meta.url));
const {Client,InMemoryTransport}=require('@modelcontextprotocol/client');
const {StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
const {App}=require('@modelcontextprotocol/ext-apps');
const {AppBridge}=require('@modelcontextprotocol/ext-apps/app-bridge');
const executable=process.env.GALAXY_GO_UI_TEST_BINARY;
const component=result=>result._meta?.galaxyLocalWork;

async function actualIframe(client,html,shown,title){
 const bundled=await build({stdin:{contents:`import {AppBridge,PostMessageTransport} from ${JSON.stringify(require.resolve('@modelcontextprotocol/ext-apps/app-bridge'))};window.mountGoPanel=async(html,result,capabilities)=>{const handlers=new Map();const client={getServerCapabilities:()=>capabilities,setNotificationHandler:(name,handler)=>handlers.set(name,handler),request:request=>window.actualGoRPC(request)};const frame=document.querySelector('iframe');const bridge=new AppBridge(client,{name:'synthetic-isolated-headless-host',version:'1'},{serverTools:{},logging:{}},{hostContext:{displayMode:'inline',availableDisplayModes:['inline'],theme:'light'}});window.goPanelBridge=bridge;bridge.oninitialized=()=>{window.goPanelInitialized=true;bridge.sendToolInput({arguments:{view:'history'}});bridge.sendToolResult(result);};await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.srcdoc=html;};`,resolveDir:process.cwd(),sourcefile:'isolated-app-host.mjs'},bundle:true,platform:'browser',format:'iife',write:false});
 const browser=await chromium.launch({headless:true});
 try{const context=await browser.newContext(),page=await context.newPage(),errors=[],calls=[];page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('actualGoRPC',async request=>{calls.push(request.method);if(request.method==='tools/call')return client.callTool(request.params);if(request.method==='tools/list')return client.listTools(request.params);if(request.method==='resources/read')return client.readResource(request.params);if(request.method==='resources/list')return client.listResources(request.params);throw Error('Unexpected actual host RPC '+request.method);});
  await page.setContent('<!doctype html><iframe title="Isolated Galaxy MCP App" sandbox="allow-scripts" style="width:1100px;height:760px"></iframe>');await page.addScriptTag({content:bundled.outputFiles[0].text});await page.evaluate(({html,shown,capabilities})=>window.mountGoPanel(html,shown,capabilities),{html,shown,capabilities:client.getServerCapabilities()});
  await page.waitForFunction(()=>window.goPanelInitialized===true);const panel=page.frameLocator('iframe');await panel.getByRole('button',{name:title,exact:true}).waitFor();await panel.getByRole('button',{name:title,exact:true}).click();await panel.getByRole('heading',{name:title,exact:true}).waitFor();
  await panel.getByRole('button',{name:'原会话',exact:true}).click();await panel.getByText('原会话',{exact:true}).first().waitFor();assert.ok(calls.includes('tools/call'));assert.deepEqual(errors,[]);await page.evaluate(()=>window.goPanelBridge.teardownResource({}));await context.close();
 }finally{await browser.close();}
}

test('official App/AppBridge reaches actual Go stdio and shipped local panel with private-only bodies and real browser choice',{skip:!executable&&'Set GALAXY_GO_UI_TEST_BINARY to a Go development binary with its existing dist artifact',timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-go-apps-')),dataDirectory=join(directory,'data'),configPath=join(directory,'native.json');let client,app,bridge,transport;
 try{
  await copyLegacyNativeFixture(dataDirectory);
  const expected=JSON.parse(await readFile(join(dataDirectory,'expected.json'),'utf8')),now=Math.floor(Date.now()/1000),key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  await writeFile(configPath,JSON.stringify({version:2,website:'https://selected.invalid',endpoint:'https://galaxy.invalid',dataDirectory,trustedKeys:{synthetic:{publicKeyPem:key,notBefore:now-1,notAfter:now+3600,revoked:false}}}));
  client=new Client({name:'synthetic-official-app-host',version:'1'},{capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
  transport=new StdioClientTransport({command:executable,args:['native','--config',configPath],stderr:'ignore'});await client.connect(transport);
  const tools=await client.listTools(),tool=tools.tools.find(item=>item.name==='galaxy_local_panel');assert.ok(tool,'Go server has not registered the real local panel');assert.equal(tools.tools.some(item=>/host.session.complete|host_session_complete|sessionComplete/.test(item.name)),false,'The owning-host notification is never a model tool');
  const uri=tool._meta.ui.resourceUri;assert.equal(tool._meta['ui/resourceUri'],uri);const resource=await client.readResource({uri});assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app');assert.ok(resource.contents[0].text.includes('银河'));assert.ok(!resource.contents[0].text.includes(expected.get.work.summary));
  const shown=await client.callTool({name:'galaxy_local_panel',arguments:{view:'history',workId:expected.get.work.workId}});assert.equal(shown.isError,undefined);assert.deepEqual(component(shown).selectedWork,expected.get);assert.ok(!JSON.stringify({content:shown.content,structuredContent:shown.structuredContent}).includes(expected.get.work.summary));
  bridge=new AppBridge(client,{name:'synthetic-official-app-bridge',version:'1'},{serverTools:{},updateModelContext:{text:{}},logging:{}});app=new App({name:'synthetic-Galaxy-local-panel',version:'1'},{},{autoResize:false});let received,teardown=false;app.ontoolresult=result=>{received=result;};app.onteardown=async()=>{teardown=true;return{};};
  const[a,b]=InMemoryTransport.createLinkedPair();await bridge.connect(a);await app.connect(b);await bridge.sendToolInput({arguments:{view:'history'}});await bridge.sendToolResult(shown);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(component(received).selectedWork,expected.get);
  const read=await app.callServerTool({name:'galaxy_local_panel_read',arguments:{view:'archive'}});assert.ok(component(read).archives.items.length>0);assert.equal(read.structuredContent.kind,'galaxy-local-work-panel');assert.equal(read.structuredContent.archives,undefined);
  const selection={galaxyId:expected.identity.id,enabled:false,sessions:[],autoCleanAfterDays:null};const pending=await app.callServerTool({name:'galaxy_local_panel_archive_save',arguments:selection});assert.equal(component(pending).choice.state,'user-choice-needs-browser');assert.equal(pending.structuredContent.choice,undefined);
  const url=component(pending).choice.url;const actual=await fetch(url,{method:'POST',headers:{origin:new URL(url).origin,'content-type':'application/x-www-form-urlencoded'},body:'action=allow'});assert.equal(actual.status,200);
  const saved=await app.callServerTool({name:'galaxy_local_panel_archive_save',arguments:selection});assert.equal(component(saved).archiveSettings.settings.enabled,false);assert.equal(component(saved).choice,undefined);
  const approve=async(name,args)=>{const pending=await app.callServerTool({name,arguments:args});assert.equal(component(pending).choice.state,'user-choice-needs-browser');const url=component(pending).choice.url;assert.equal((await fetch(url,{method:'POST',headers:{origin:new URL(url).origin,'content-type':'application/x-www-form-urlencoded'},body:'action=allow'})).status,200);const result=await app.callServerTool({name,arguments:args});assert.equal(result.isError,undefined);assert.equal(component(result).choice,undefined);return component(result);};
  const accounts=component(await app.callServerTool({name:'galaxy_local_panel_sync_accounts',arguments:{galaxyId:expected.identity.id}}));assert.equal(accounts.accountConnectionRequired,true);assert.deepEqual(accounts.accounts,[]);
  const settings=await approve('galaxy_local_panel_settings_save',{choiceId:randomUUID(),galaxyId:expected.identity.id,level:'local-only',conversationMode:'off',sessions:[],autoCleanAfterDays:null,restoreArchiveSessionIds:[]});assert.equal(settings.privacy.settings.level,'local-only');
  assert.equal((await approve('galaxy_local_panel_work_sync_save',{choiceId:randomUUID(),galaxyId:expected.identity.id,enabled:false,workIds:[],includeExisting:false,includeFutureWork:false,restoreWorkIds:[]})).workSync.choice.enabled,false);
  assert.equal((await approve('galaxy_local_panel_archive_sync_save',{choiceId:randomUUID(),galaxyId:expected.identity.id,enabled:false,archiveSessionIds:[],restoreArchiveSessionIds:[]})).archiveSync.choice.enabled,false);
  assert.equal(component(await app.callServerTool({name:'galaxy_local_panel_sync_flush',arguments:{galaxyId:expected.identity.id}})).privacy.settings.level,'local-only');
  assert.deepEqual(component(await app.callServerTool({name:'galaxy_local_panel_read',arguments:{view:'history',workId:expected.get.work.workId}})).selectedWork,expected.get,'The upload level never blocks the owner reading local work');
  await bridge.teardownResource({});assert.equal(teardown,true);
  await actualIframe(client,resource.contents[0].text,await client.callTool({name:'galaxy_local_panel',arguments:{view:'history'}}),expected.get.work.title);
 }finally{await app?.close();await bridge?.close();await client?.close();await transport?.close();const exact=resolve(directory);assert.ok(exact.startsWith(resolve(tmpdir())+sep));await rm(exact,{recursive:true,force:true});}
});
