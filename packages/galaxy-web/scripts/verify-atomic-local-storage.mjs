import { chromium, browserToolOutput } from './browser-tool-runtime.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=browserToolOutput(import.meta.url, process.env.GALAXY_UI_REPORT_DIR);
await mkdir(out,{recursive:true});
const source=resolve(root,'packages/galaxy-core/src/domain/device-key-store.mjs'),sourceSha256=createHash('sha256').update(await readFile(source)).digest('hex');
const bundle=await build({stdin:{contents:"export {openDeviceKeyStore} from './packages/galaxy-core/src/domain/device-key-store.mjs';",resolveDir:root},bundle:true,write:false,platform:'browser',format:'esm'});
const server=createServer((req,res)=>{if(req.url==='/store.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);}else{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Galaxy local atomic storage verification</title><main>Local synthetic storage verification only.</main>');}});
let browser,context;const checks=[],errors=[];
try{
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({ headless:true });
 context=await browser.newContext();const tabs=await Promise.all([context.newPage(),context.newPage()]),dbName='galaxy-atomic-'+randomUUID();
 for(const page of tabs){page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.evaluate(async name=>{const {openDeviceKeyStore}=await import('/store.js');window.atomicStore=await openDeviceKeyStore({name});},dbName);}
 await tabs[0].evaluate(()=>atomicStore.put('count',0));
 await Promise.all(tabs.map(page=>page.evaluate(async()=>{await Promise.all(Array.from({length:30},()=>atomicStore.update('count',v=>v+1)));})));
 assert.equal(await tabs[0].evaluate(()=>atomicStore.get('count')),60);assert.equal(await tabs[1].evaluate(()=>atomicStore.get('count')),60);
 checks.push({id:'two-tab-concurrent-updates',passed:true,realTabs:2,independentIndexedDBConnections:2,transactions:60,finalCount:60});
 const claims=await Promise.all(tabs.map((page,index)=>page.evaluate(async owner=>{try{return{value:await atomicStore.update('pending',current=>{if(current)throw Error('already_pending');return{owner,operationId:'original-'+owner};})};}catch(e){return{error:e.message};}},index)));
 assert.equal(claims.filter(r=>r.value).length,1);assert.equal(claims.filter(r=>r.error==='already_pending').length,1);
 const original=await tabs[0].evaluate(()=>atomicStore.get('pending'));
 await tabs[1].evaluate(()=>atomicStore.update('pending',()=>({operationId:'replacement',payloadHash:'b'.repeat(64)})));
 const retained=await tabs[0].evaluate(async originalId=>atomicStore.update('pending',current=>current?.operationId===originalId?null:current),original.operationId);
 assert.equal(retained.operationId,'replacement');assert.equal((await tabs[1].evaluate(()=>atomicStore.get('pending'))).operationId,'replacement');
 checks.push({id:'atomic-claim-and-original-only-clear',passed:true,duplicateClaimRejected:true,replacementPreserved:true});
 for(const page of tabs){const aborted=await page.evaluate(async()=>{const before=await atomicStore.get('pending'),results=[];for(const update of [current=>{current.operationId='bad';throw Error('synthetic_abort');},async()=>({operationId:'bad-async'})]){try{await atomicStore.update('pending',update);results.push('unexpected_commit');}catch(e){results.push(e.message);}}return{before,after:await atomicStore.get('pending'),results};});assert.deepEqual(aborted.after,aborted.before);assert.deepEqual(aborted.results,['synthetic_abort','local_update_async_callback']);}
 checks.push({id:'throw-and-async-callback-rollback',passed:true,originalStoredBytesRetained:true});
 assert.deepEqual(errors,[]);
 for(const page of tabs)await page.evaluate(()=>atomicStore.close());
 await tabs[0].evaluate(name=>new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('synthetic_database_still_open'));}),dbName);
 const report={observedAt:new Date().toISOString(),passed:true,actualBrowser:true,actualIndexedDB:true,sourceSha256,checks,pageErrors:errors,productionDataUsed:false,remoteRequests:0};
 await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,checks:checks.length,actualTabs:2,actualIndexedDB:true}));
}finally{await context?.close();await browser?.close();if(server.listening)await new Promise(ok=>server.close(ok));}
