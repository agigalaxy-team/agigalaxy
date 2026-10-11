import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import {receiptStatusFixture} from '../../galaxy-official/test/receipt-status-workflow.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const out=fileURLToPath(new URL('../../../../../../07-logs/development/choice-retained-ui-20261002/',import.meta.url));
const events=[],errors=[];
const directory=await mkdtemp(join(tmpdir(),'galaxy-choice-retained-ui-')),t=await receiptStatusFixture();
let vite,browser,api,page;
await mkdir(out,{recursive:true});
const bootstrap=`import React from 'react';
 import {createRoot} from 'react-dom/client';
 import {HelpSearchWorkspace} from '/packages/galaxy-web/src/help-search-workspace.tsx';
 import {SiteShell} from '/packages/galaxy-web/src/site-shell.tsx';
 import '/app/globals.css';import '/packages/galaxy-web/src/workspace.css';
 window.uiRoot=createRoot(document.getElementById('root'));
 window.mountPage=async(runtime=window.runtime)=>{const status=await runtime.status();
  window.uiRoot.render(React.createElement(SiteShell,{path:'/app/search',connected:!!status.connection,subjectId:status.identity?.subjectId,navigate:()=>{}},
   React.createElement(HelpSearchWorkspace,{runtime,subjectId:status.identity?.subjectId,connected:!!status.connection,navigate:()=>{}})));};`;
try{
 const port=t.api.address().port,target='http://127.0.0.1:'+port;
 const key=join(directory,'key.pem'),certificate=join(directory,'cert.pem');
 await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=127.0.0.1','-days','1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',certificate],{windowsHide:true});
 vite=await createServer({root:repository,configFile:false,logLevel:'error',resolve:{alias:{'@':repository}},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','jose','zod/v4','lucide-react','@base-ui/react/button','@base-ui/react/input','class-variance-authority','clsx','tailwind-merge']},css:{postcss:{plugins:[tailwindcss()]}},plugins:[react(),{name:'retained-ui-fixture',resolveId(id){if(id==='/__retained_ui_bootstrap.jsx')return '\0galaxy-retained-ui.jsx';},load(id){if(id==='\0galaxy-retained-ui.jsx')return bootstrap;},configureServer(server){
  server.middlewares.use('/app/search',(_q,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>银河原回执</title><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/__retained_ui_bootstrap.jsx"></script>`);});
 }}],server:{host:'127.0.0.1',port:0,https:{key:await readFile(key),cert:await readFile(certificate)},proxy:{'/v1':target,'/v2':target},fs:{allow:[repository]}}});
 await vite.listen();const origin='https://127.0.0.1:'+vite.httpServer.address().port;
 t.api.closeAllConnections();await new Promise(done=>t.api.close(done));
 api=createApi({...t.f,receiptStatus:t.receiptStatus,retirement:t.retirement,browserOrigins:[origin],rateLimit:1000});await new Promise(done=>api.listen(port,'127.0.0.1',done));
 browser=await chromium.launchPersistentContext(directory,{headless:true,ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},reducedMotion:'reduce',executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)events.push({httpError:response.status(),path:new URL(response.url()).pathname});});page.setDefaultTimeout(20000);
 const config={endpoint:t.f.access.endpoint,signingKeys:[...t.trustedKeys].map(([kid,pin])=>({kid,...pin}))};
 async function setup(){await page.goto(origin+'/app/search');await page.waitForFunction(()=>typeof window.mountPage==='function');
  await page.evaluate(async({config,time})=>{
   const {createWebRuntime}=await import('/packages/galaxy-web/src/runtime.mjs');const {openDeviceKeyStore}=await import('/packages/galaxy-core/src/domain/device-key-store.mjs');
   const {createChoiceSyncClient}=await import('/packages/galaxy-web/src/choice-sync-client.mjs');const {createHelpSearchClient}=await import('/packages/galaxy-web/src/help-search-client.mjs');
   window.clock=time;window.calls=[];window.readHook=null;window.writeHook=null;window.afterResponse=null;window.offline=false;window.drop=false;
   window.rawStore=await openDeviceKeyStore({name:'choice-retained-ui-real-idb'});const store={...window.rawStore,get:async key=>{const v=await window.rawStore.get(key);if(window.readHook)await window.readHook(key);return v;},put:async(key,v)=>{await window.rawStore.put(key,v);if(window.writeHook)await window.writeHook(key);}};
   window.runtimeConfig={endpoint:config.endpoint,trustedKeys:new Map(config.signingKeys.map(({kid,...pin})=>[kid,pin]))};
   window.fetcher=async(url,options)=>{if(new URL(url).origin!==config.endpoint)throw Error('Wrong fixture endpoint');const path=new URL(url).pathname;
    window.calls.push({path,bearer:Object.hasOwn(options.headers??{},'Authorization')});if(window.offline)throw Error('synthetic offline');const response=await fetch(path,options);
    if(window.drop&&path==='/v2/choice-snapshots/put'){window.drop=false;throw Error('synthetic committed lost ACK');}
    if(window.afterResponse)await window.afterResponse(path);return response;};
   window.runtime=await createWebRuntime(window.runtimeConfig,{store,fetch:window.fetcher,now:()=>window.clock});
   window.startChoices=async()=>{const subjectId=(await window.runtime.status()).identity.subjectId;window.cloud=createChoiceSyncClient(window.runtime,{subjectId});window.search=createHelpSearchClient(window.runtime,{subjectId,authenticated:true});};
   window.publishChoice=async()=>{const results=await window.search.query({type:'history',query:{query:'Retained receipt source'}}),candidate=window.search.candidateKey(results.items[0]),id=crypto.randomUUID();
    await window.search.saveChoice({id,expectedVersion:0,localTaskRef:'Private retained task',visibleRationale:'Private retained reason',rationaleAuthor:'user',candidateKeys:[candidate],selectedKeys:[candidate],resultRefs:[]});
    const p=await window.cloud.preferences();await window.cloud.savePreference({endpoint:config.endpoint,expectedRevision:p.revision,enabled:true,snapshotIds:[...p.snapshotIds,id]});window.drop=true;
    let lost=false;try{await window.cloud.sync(id);}catch(e){lost=e.message.includes('lost ACK');}if(!lost)throw Error('Expected actual committed lost ACK');return(await window.cloud.retainedReceiptOperations()).find(row=>row.snapshotId===id);};
   window.emptyLocal=()=>window.runtime.putLocal('help-choices-v2',{schemaVersion:2,storage:'local',cloudSyncEnabled:false,choices:[],referenceStates:{}});
  },{config,time:t.now()});
 }
 async function openDirectory(){const summary=page.getByText('本机选择与跨设备使用',{exact:true});if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();const region=page.getByRole('region',{name:'本机原操作回执'});
  await region.getByRole('button',{name:'查看本机原操作目录',exact:true}).click();return region;}
 async function select(versionId){const row=page.locator(`[data-choice-operation="${versionId}"]`);await row.getByRole('button',{name:'选择这条原操作',exact:true}).click();}
 async function shot(name){await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{window.scrollTo(0,0);document.activeElement?.blur();});await page.screenshot({path:join(out,name+'.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:1440,height:1000});}
 await setup();const operations=await page.evaluate(async()=>{await window.runtime.createIdentity({confirmed:true});await window.runtime.connect({confirmed:true});await window.startChoices();
  const pending=await window.publishChoice(),stopped=await window.publishChoice();await window.cloud.discardPending(stopped.snapshotId);await window.emptyLocal();await window.mountPage();return{pending,stopped};});
 await page.getByRole('heading',{name:'寻找可用的帮助',exact:true}).waitFor();let region=await openDirectory();await page.locator('[data-choice-operation]').first().waitFor();
 await select(operations.pending.versionId);await page.evaluate(()=>{window.afterResponse=async path=>{if(path==='/v2/receipt-status/query'){window.afterResponse=null;await window.runtime.connect({confirmed:true});}};});
 await region.getByRole('button',{name:'只查询原回执',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-choice-operation]'));
 assert.equal(await region.getByText('服务已接收原操作',{exact:false}).count(),0);events.push({check:'same GUID actual binding replacement during response hides old directory/result',passed:true});
 await page.evaluate(async()=>{window.runtime.disconnect();await window.mountPage();window.readHook=async key=>{if(key.endsWith(':choice-cloud-v2')){window.readHook=null;await window.runtime.connect({confirmed:true});window.runtime.disconnect();}};});
 region=await openDirectory();await page.waitForFunction(()=>!document.querySelector('[data-choice-operation]'));await page.waitForTimeout(300);assert.equal(await page.locator('[data-choice-operation]').count(),0);
 events.push({check:'actual IndexedDB read completion null to real connect to null ABA withholds old directory',passed:true});
 region=await openDirectory();await page.locator('[data-choice-operation]').first().waitFor();await select(operations.pending.versionId);
 await page.evaluate(()=>{window.afterResponse=async path=>{if(path!=='/v2/receipt-status/query')return;window.afterResponse=null;
  const {createWebRuntime}=await import('/packages/galaxy-web/src/runtime.mjs');const {openDeviceKeyStore}=await import('/packages/galaxy-core/src/domain/device-key-store.mjs');
  window.foreignStore=await openDeviceKeyStore({name:'choice-retained-ui-other-identity'});window.foreignRuntime=await createWebRuntime(window.runtimeConfig,{store:window.foreignStore,fetch:window.fetcher,now:()=>window.clock});
  await window.foreignRuntime.createIdentity({confirmed:true});await window.mountPage(window.foreignRuntime);};});
 await region.getByRole('button',{name:'只查询原回执',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-choice-operation]'));await page.waitForTimeout(300);
 assert.equal(await page.locator('[data-choice-operation]').count(),0);events.push({check:'actual second identity activation during old response exposes no original-owner row or ACK',passed:true});
 await page.evaluate(async()=>{window.foreignRuntime.close();window.foreignStore.close();await window.mountPage();});
 await page.evaluate(()=>{window.runtime.disconnect();window.cloud.close();window.search.close();window.runtime.close();window.rawStore.close();});
 t.setTime(t.policy.takeoutUntil+1);const bindings=(await t.f.db.query('SELECT * FROM bindings ORDER BY id')).rows,preferences=(await t.f.db.query('SELECT * FROM choice_snapshot_preferences ORDER BY subject_id')).rows;
 await setup();await page.evaluate(()=>window.mountPage());await page.getByRole('heading',{name:'寻找可用的帮助',exact:true}).waitFor();
 const start=await page.evaluate(()=>window.calls.length);region=await openDirectory();await page.locator('[data-choice-operation]').first().waitFor();
 assert.equal(await page.getByRole('button',{name:'读取当前同步范围',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'读取本人云端记录',exact:true}).isDisabled(),true);
 assert.equal(await page.evaluate(n=>window.calls.length-n,start),0);assert.equal(await page.locator('[data-choice-operation]').count(),2);assert.equal((await region.innerText()).includes('Private retained'),false);
 events.push({check:'actual page reload with expired sessions and only journal mounts explicit zero-network body-free directory; ordinary cloud controls disabled',passed:true});
 await select(operations.pending.versionId);const beforeCancel=await page.evaluate(()=>window.calls.length);await region.getByRole('button',{name:'取消核对',exact:true}).click();assert.equal(await page.evaluate(n=>window.calls.length-n,beforeCancel),0);
 await select(operations.pending.versionId);await page.evaluate(()=>window.offline=true);await region.getByRole('button',{name:'只查询原回执',exact:true}).click();await region.getByRole('alert').waitFor();assert.ok((await region.getByRole('alert').innerText()).includes('状态仍未知'));
 await shot('offline-original-operation');await page.evaluate(()=>window.offline=false);await region.getByRole('button',{name:'只查询原回执',exact:true}).click();await page.locator(`[data-choice-operation="${operations.pending.versionId}"]`).getByRole('status').waitFor();
 assert.ok((await region.innerText()).includes('服务已接收原操作'));events.push({check:'cancel emits zero request; offline remains unknown; explicit retry queries same original receipt only',passed:true});
 await select(operations.stopped.versionId);await region.getByRole('button',{name:'只查询原回执',exact:true}).click();await page.locator(`[data-choice-operation="${operations.stopped.versionId}"]`).getByRole('status').waitFor();
 await t.f.db.query('UPDATE choice_snapshot_versions SET state=$2,expires_at=$3 WHERE version_id=$1',[operations.stopped.versionId,'expired',new Date(t.now()*1000-1000).toISOString()]);
 await select(operations.stopped.versionId);await region.getByRole('button',{name:'只查询原回执',exact:true}).click();await page.getByText('服务已接收原操作；正文期限已到。',{exact:true}).waitFor();
 await t.f.db.query('UPDATE choice_snapshot_versions SET request_hash=$2 WHERE version_id=$1',[operations.stopped.versionId,'0'.repeat(64)]);await select(operations.stopped.versionId);await region.getByRole('button',{name:'只查询原回执',exact:true}).click();await page.getByText('原 ID 与 hash 不一致；没有重发或修改原操作。',{exact:true}).waitFor();
 await t.f.db.query('DELETE FROM choice_snapshot_versions WHERE version_id=$1',[operations.pending.versionId]);await select(operations.pending.versionId);await region.getByRole('button',{name:'只查询原回执',exact:true}).click();await page.getByText('服务未保留这条本人原操作；可能未接收或最小记录已清理，不能据此判定从未发生。',{exact:true}).waitFor();
 await shot('expired-absent-conflict');events.push({check:'actual metadata expired/absent/conflict rendered separately without contents, current authorization or TTL renewal',passed:true});
 assert.ok((await page.evaluate(()=>window.calls)).every(call=>call.path.startsWith('/v2/receipt-status/')&&!call.bearer));assert.deepEqual((await t.f.db.query('SELECT * FROM bindings ORDER BY id')).rows,bindings);assert.deepEqual((await t.f.db.query('SELECT * FROM choice_snapshot_preferences ORDER BY subject_id')).rows,preferences);
 await page.evaluate(()=>{window.readHook=async key=>{if(key.endsWith(':choice-cloud-v2')){window.readHook=null;window.runtime.disconnect();}};});await region.getByRole('button',{name:'刷新本机原操作目录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-choice-operation]'));
 events.push({check:'actual IndexedDB completion plus null lifecycle replacement hides old operation view',passed:true});
 await page.evaluate(async()=>{const {createWebRuntime}=await import('/packages/galaxy-web/src/runtime.mjs');const other=await createWebRuntime({...window.runtimeConfig,endpoint:'https://another-fixture.example.org'},{store:window.rawStore,fetch:()=>{throw Error('Endpoint change must not network');},now:()=>window.clock});window.otherRuntime=other;await window.mountPage(other);});
 await page.waitForTimeout(300);assert.equal(await page.getByRole('region',{name:'本机原操作回执'}).count(),0);assert.equal(await page.locator('[data-choice-operation]').count(),0);events.push({check:'different endpoint runtime with no owner never exposes prior directory or requests network',passed:true});
 assert.equal(errors.length,0);
}catch(error){events.push({failed:error.message});if(page){await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(out,'failure.txt'),await page.locator('body').innerText());}throw error;
}finally{
 await writeFile(join(out,'report.json'),JSON.stringify({actualFullHelpSearchPage:true,actualHttp:true,actualPersistentIndexedDB:true,database:'PGlite',syntheticIdentity:true,events,pageErrors:errors,limitations:['setup creates Choice through actual browser runtime; model/tool actions are not invoked','synthetic identity and Account quotas','not physical multi-device or PostgreSQL concurrency']},null,2));
 await browser?.close();await vite?.close();if(api){api.closeAllConnections();await new Promise(done=>api.close(done));}await t.close();assert.ok(directory.startsWith(join(tmpdir(),'galaxy-choice-retained-ui-')));await rm(directory,{recursive:true,force:true});
}
