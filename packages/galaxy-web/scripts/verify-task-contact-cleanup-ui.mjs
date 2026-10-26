import { chromium, browserToolOutput } from './browser-tool-runtime.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = browserToolOutput(import.meta.url, process.env.GALAXY_UI_REPORT_DIR);
const baseline = process.env.GALAXY_CLEANUP_BASELINE === '1';
const paths = ["packages/galaxy-web/src/features/tasks/contact/task-contact-workspace.tsx", "packages/galaxy-web/src/features/tasks/contact/task-contact-client.mjs",
  "packages/galaxy-web/src/features/tasks/publish/task-preparation-client.mjs", 'packages/galaxy-web/scripts/verify-task-contact-cleanup-ui.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(resolve(root, path)))])));
await mkdir(out, {recursive: true});

// This isolated transport/storage fixture exercises the actual React component
// and its actual guarded contact/preparation clients. It deliberately omits
// signup, OIDC, physical devices, the full main entry and production services.
const harness = "\nimport React,{useLayoutEffect,useState} from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {TaskContactWorkspace} from './packages/galaxy-web/src/features/tasks/contact/task-contact-workspace.tsx';\nimport {sha256Hex} from './packages/galaxy-official/src/shared/web-primitives.mjs';\nconst A='GUID'+'A'.repeat(28),B='GUID'+'B'.repeat(28),recipient='GUID'+'C'.repeat(28);\nconst firstTask='00000000-0000-4000-8000-000000000001',nextTask='00000000-0000-4000-8000-000000000002';\nconst clone=value=>structuredClone(value),local=new Map(),receipts=new Map(),heldReads=[],heldSearches=[];\nlet binding={subjectId:A,endpoint:'https://synthetic.invalid',bindingId:'A-1',generation:1},scope={subjectId:A,taskId:firstTask};\nconst f=window.fixture={searches:[],writes:[],receiptQueries:[],scopeCommits:[],readErrors:0,refreshCalls:0,heldReads,heldSearches,\n readFailure:false,actionFailure:false,dropAck:false,armCleanup:false,holdSearchTask:null,gateTask:null};\nconst taskFor=(subjectId,taskId)=>({taskId,version:1,state:'open',requesterId:subjectId,request:{taskId,\n title:'合成：联系人清理与接续',summary:'仅验证本地最终消费者，非真实任务',goal:'保持原批次与身份归属',\n situation:'隔离UI',participation:'open',enrollmentExpiresAt:Math.floor(Date.now()/1000)+86400},participations:[],\n contacts:{suggestions:{items:[{subjectId:recipient,help:'合成：只向这个对象发送',basis:'合成已保存建议',conditions:'真实意愿未知',sourceRefs:[]}]},\n responses:{applications:[],invitations:[]}}});\nconst ownKey=(name,owner=binding.subjectId)=>owner+':'+name;\nconst runtime={api:{endpoint:'https://synthetic.invalid',snapshot:()=>({...binding}),\n call:async(path,input)=>{\n  if(path==='/v2/search/query'){\n   const taskId=input.query.context?.taskId??scope.taskId;f.searches.push({taskId,subjectId:binding.subjectId});\n   const result={type:input.type,items:[],nextCursor:null};\n   if(f.holdSearchTask===taskId)return new Promise(ok=>heldSearches.push(()=>ok(result)));\n   return result;\n  }\n  if(path==='/v2/tasks/receipt'){f.receiptQueries.push(clone(input));return clone(receipts.get(input.eventId)??{state:'absent'});}\n  if(path.startsWith('/v2/tasks/')){\n   if(f.actionFailure){f.readFailure=true;throw Error('合成：原邀请准备失败');}\n   return taskFor(binding.subjectId,path.split('/').at(-1));\n  }\n  throw Error('unexpected synthetic endpoint '+path);\n }},\n getLocal:async name=>{\n  const key=ownKey(name),value=clone(local.get(key)??null);\n  if(f.readFailure&&name.startsWith('task-contact-batch:')){f.readErrors++;throw Error('合成：本机批次读取失败');}\n  if(f.gateTask&&['task-contact-batch:','task-room-batch:'].some(prefix=>name===prefix+f.gateTask))\n   return new Promise(ok=>heldReads.push(()=>ok(value)));\n  return value;\n },\n putLocal:async(name,value,owner=binding.subjectId)=>{local.set(ownKey(name,owner),clone(value));},\n updateLocal:async(name,updater,owner=binding.subjectId)=>{\n  const key=ownKey(name,owner),value=clone(updater(clone(local.get(key)??null)));local.set(key,value);return clone(value);\n },\n stoppedTaskOperations:async()=>[],onTaskOperationStopped:()=>()=>{},status:async()=>({active:binding}),\n taskEvent:async(taskId,event)=>{\n  const payloadHash=await sha256Hex(JSON.stringify({taskId,event}));\n  const record={taskId,eventId:event.eventId,payloadHash};\n  local.set(ownKey('task-event:'+taskId),clone(record));f.writes.push(clone(record));\n  const receipt={state:'acknowledged',taskId,eventId:event.eventId,payloadHash,version:2};receipts.set(event.eventId,receipt);\n  if(f.dropAck){f.dropAck=false;throw Error('合成：提交已发生，ACK丢失');}\n  local.set(ownKey('task-event:'+taskId),null);return clone(receipt);\n },\n reconcileTaskEvent:async taskId=>{\n  const key=ownKey('task-event:'+taskId),pending=local.get(key),receipt=receipts.get(pending.eventId);\n  local.set(key,null);return clone(receipt);\n },chat:{}};\nfunction App(){const [view,setView]=useState(scope);\n useLayoutEffect(()=>{f.scopeCommits.push({...view,body:document.body.innerText});},[view]);\n f.switchScope=(kind)=>{\n const old=scope;scope={subjectId:kind==='binding'?B:A,taskId:nextTask};\n if(kind==='binding')binding={...binding,subjectId:B,bindingId:'B-2',generation:2};\n f.holdSearchTask=nextTask;f.switchedFrom=old;setView({...scope});\n };\n return <TaskContactWorkspace task={taskFor(view.subjectId,view.taskId)} runtime={runtime} subjectId={view.subjectId}\n connected={true} navigate={()=>{}} refresh={async()=>{f.refreshCalls++;if(f.armCleanup){f.armCleanup=false;f.gateTask=view.taskId;}}}/>;\n}\nf.armReadFailure=()=>{f.readFailure=true;};\nf.armActionFailure=()=>{f.actionFailure=true;};\nf.clearFailures=()=>{f.readFailure=false;f.actionFailure=false;};\nf.local=()=>Object.fromEntries(local);\nf.pending=()=>clone(local.get(ownKey('task-contact-batch:'+scope.taskId))??null);\nf.releaseReads=()=>{f.gateTask=null;for(const release of heldReads.splice(0))release();};\nf.releaseSearches=()=>{f.holdSearchTask=null;for(const release of heldSearches.splice(0))release();};\nf.seedPrivateBatch=()=>{const note='PRIVATE_OLD_SCOPE_ONLY';local.set(ownKey('task-contact-batch:'+scope.taskId),{\n batchId:'00000000-0000-4000-8000-000000000003',taskId:scope.taskId,requesterId:scope.subjectId,confirmed:false,\n items:[{eventId:'00000000-0000-4000-8000-000000000004',subjectId:recipient,note,state:'queued',expiresAt:Math.floor(Date.now()/1000)+600}]});};\ncreateRoot(document.getElementById('root')).render(<App/>);\n";

const bundle = await build({stdin: {contents: harness, resolveDir: root, loader: 'tsx'}, bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', alias: {'@': root}, loader: {'.css': 'empty'}});
const checks = [], pageErrors = [], liveUrls = [], contexts = [];
let server, browser, failure;
const report = {baseline, actualBrowser: true, actualReactContactComponent: true, actualGuardedClients: true,
  actualMainEntry: false, actualHttpBusinessService: false, actualAccountRegistration: false,
  actualPhysicalDeviceOrHost: false, actualUserAcceptance: false, syntheticTransportAndStorage: true,
  checks, pageErrors, liveUrls, sourceHashes};
const pause = () => new Promise(ok => setTimeout(ok, 100));
async function check(id, action) {
  let page;
  try {
    const context = await browser.newContext({viewport: {width: 1200, height: 900}, reducedMotion: 'reduce'});
    contexts.push(context); page = await context.newPage(); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', e => {errors.push(e.message); pageErrors.push({id, message: e.message});});
    await page.goto(liveUrls[0]);
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '查询当前清单' && !b.disabled));
    const observations = await action(page, errors);
    const passed = Object.values(observations.assertions).every(Boolean);
    checks.push({id, passed, ...observations});
    await page.screenshot({path: resolve(out, id + '.png'), fullPage: true});
  } catch (e) {
    checks.push({id, passed: false, failure: {message: e.message, code: e.code ?? null}});
    if (page) {await page.screenshot({path: resolve(out, id + '-failure.png'), fullPage: true}).catch(() => {});
      await writeFile(resolve(out, id + '-failure.txt'), await page.locator('body').innerText().catch(() => ''));
    }
  } finally {await page?.context().close();}
}
const query = page => page.getByRole('button', {name: '查询当前清单', exact: true});
const enabled = async page => {await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '查询当前清单' && !b.disabled));};

try {
  server = createServer((request, response) => {response.setHeader('content-type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html; charset=utf-8');
    response.end(request.url === '/bundle.js' ? bundle.outputFiles[0].text : '<!doctype html><html lang="zh-CN"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');});
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  liveUrls.push('http://127.0.0.1:' + server.address().port);
  browser = await chromium.launch({ headless: true });
  console.log(JSON.stringify({stage: 'isolated-local-ui-running', url: liveUrls[0], processId: process.pid}));

  await check('pending-read-failure-releases-ui', async (page, errors) => {
    await page.evaluate(() => window.fixture.armReadFailure()); await query(page).click();
    await page.waitForFunction(() => window.fixture.readErrors > 0); await pause();
    const body = await page.locator('body').innerText(), released = await query(page).isEnabled();
    let retry = false;
    if (released) {await page.evaluate(() => window.fixture.clearFailures()); const prior = await page.evaluate(() => window.fixture.searches.length);
      await query(page).click(); await enabled(page); retry = await page.evaluate(prior => window.fixture.searches.length === prior + 1, prior);}
    return {assertions: {noPageError: errors.length === 0, busyReleased: released, cleanupFailureVisible: body.includes('合成：本机批次读取失败'),
      nextOperationAllowed: retry, noBusinessWrite: await page.evaluate(() => window.fixture.writes.length === 0)}, errors};
  });

  await check('action-and-cleanup-failures-preserve-original-error', async (page, errors) => {
    await page.getByRole('checkbox').check(); await page.evaluate(() => window.fixture.armActionFailure());
    await page.getByRole('button', {name: '预览所选已保存建议的邀请', exact: true}).click();
    await page.waitForFunction(() => window.fixture.readErrors > 0); await pause();
    const text = await page.getByRole('alert').innerText(), released = await query(page).isEnabled();
    let retry = false;
    if (released) {await page.evaluate(() => window.fixture.clearFailures());
      await page.getByRole('button', {name: '预览所选已保存建议的邀请', exact: true}).click(); await enabled(page);
      retry = !!await page.evaluate(() => window.fixture.pending()?.items.length === 1);}
    return {assertions: {originalErrorPreserved: text.includes('合成：原邀请准备失败'), noPageError: errors.length === 0,
      busyReleased: released, canPrepareAfterFailure: retry, noBusinessWrite: await page.evaluate(() => window.fixture.writes.length === 0)}, alert: text, errors};
  });

  await check('unknown-ack-retains-original-invitation', async (page, errors) => {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', {name: '预览所选已保存建议的邀请', exact: true}).click(); await enabled(page);
    await page.evaluate(() => {window.fixture.dropAck = true;});
    await page.getByRole('button', {name: '确认逐人内容并发送本批', exact: true}).click(); await enabled(page);
    const pending = await page.evaluate(() => window.fixture.pending()), before = await page.locator('body').innerText();
    await page.getByRole('button', {name: '先核对原操作，再继续本批', exact: true}).click(); await enabled(page);
    const state = await page.evaluate(() => ({pending: window.fixture.pending(), writes: window.fixture.writes, queries: window.fixture.receiptQueries}));
    return {assertions: {unknownDisplayed: before.includes('结果待核对'), stableEvent: state.pending.items[0].eventId === pending.items[0].eventId,
      stablePayloadHash: state.pending.items[0].payloadHash === pending.items[0].payloadHash, oneBusinessWrite: state.writes.length === 1,
      receiptQueriedFirst: state.queries.some(q => q.eventId === pending.items[0].eventId && q.payloadHash === pending.items[0].payloadHash),
      acknowledgedDisplayed: (await page.locator('body').innerText()).includes('服务已记录'), noPageError: errors.length === 0,
      busyReleased: await query(page).isEnabled()}, state, errors};
  });

  for (const kind of ['binding', 'task']) await check(kind + '-switch-during-final-read', async (page, errors) => {
    await page.evaluate(() => {window.fixture.seedPrivateBatch();window.fixture.armCleanup = true;});
    await query(page).click(); await page.waitForFunction(() => window.fixture.heldReads.length === 2);
    await page.evaluate(kind => window.fixture.switchScope(kind), kind); await pause();
    const newSearchStarted = await page.evaluate(() => window.fixture.heldSearches.length > 0);
    await page.evaluate(() => window.fixture.releaseReads()); await pause();
    const newOperationStillBusy = !await query(page).isEnabled();
    await page.evaluate(() => window.fixture.releaseSearches());
    if (newSearchStarted) await enabled(page);
    const body = await page.locator('body').innerText(), state = await page.evaluate(() => ({searches: window.fixture.searches, writes: window.fixture.writes,
      scopeCommits: window.fixture.scopeCommits, local: window.fixture.local()}));
    return {assertions: {newOperationStarts: newSearchStarted, oldCompletionDoesNotReleaseNewBusy: newSearchStarted && newOperationStillBusy,
      oldPrivateBatchHidden: !body.includes('PRIVATE_OLD_SCOPE_ONLY'),
      oldPrivateBatchHiddenAtNewCommit: state.scopeCommits.filter(commit => commit.taskId.endsWith('2')).every(commit => !commit.body.includes('PRIVATE_OLD_SCOPE_ONLY')),
      oldErrorsHidden: !body.includes('身份或连接已改变'),
      noPageError: errors.length === 0, newBusyReleased: await query(page).isEnabled(), noBusinessWrite: state.writes.length === 0,
      oldBatchRetained: Object.values(state.local).some(value => value?.items?.some(item => item.note === 'PRIVATE_OLD_SCOPE_ONLY'))}, state, errors};
  });
  if (!baseline && checks.some(item => !item.passed)) failure = new Error('task-contact cleanup UI assertions failed');
} catch (e) {failure = e; report.failure = {message: e.message, code: e.code ?? null};}
finally {
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await browser?.close();
  if (server) {server.closeAllConnections();await new Promise(ok => server.close(ok));}
  report.recordedAt = new Date().toISOString(); report.passed = checks.filter(item => item.passed).length;
  report.failed = checks.filter(item => !item.passed).length; report.completed = !failure;
  report.sourceChangedDuringRun = [];
  for (const [path, prior] of Object.entries(sourceHashes)) if (hash(await readFile(resolve(root, path))) !== prior) report.sourceChangedDuringRun.push(path);
  report.localProcessesStopped = true; await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({reportPath: resolve(out, 'report.json'), baseline, passed: report.passed, failed: report.failed,
    pageErrorCount: pageErrors.length, sourceHashes, sourceChangedDuringRun: report.sourceChangedDuringRun, localProcessesStopped: report.localProcessesStopped}));
}
if (failure) throw failure;
