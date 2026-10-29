import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const browserExecutable=process.env.GALAXY_TEST_CHROMIUM_EXECUTABLE_PATH;
if(browserExecutable){assert.ok(path.isAbsolute(browserExecutable));assert.match(path.basename(browserExecutable),/^(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/i);}
const require=createRequire(import.meta.url),app=fileURLToPath(new URL('..',import.meta.url));
const conversationId='11111111-1111-4111-8111-111111111111',oldTurn='22222222-2222-4222-8222-222222222222',newTurn='33333333-3333-4333-8333-333333333333',replacementConversation='44444444-4444-4444-8444-444444444444';

test('workbench conversation resources read independently and clear together on denied authority',async(t)=>{
 const source=`import React,{useState} from 'react';
 import {createRoot} from 'react-dom/client';
 import {AdminQueryProvider} from './src/components/AdminQueryProvider';
 import {useActiveConversationReconciliation,useWorkbenchConversationData} from './src/lib/workbench/use-workbench-conversation-data';
 import {useConversationStream} from './src/lib/workbench/use-conversation-stream';
 function Probe(){
  const [domain,setDomain]=useState('overview'),[active,setActive]=useState(false),data=useWorkbenchConversationData(domain,true),[historyDone,setHistoryDone]=useState(0),[operationDone,setOperationDone]=useState(0);
  const current=data.conversation?.runs.find(run=>run.operationId==='${newTurn}'),activeOperation=active&&!['COMPLETED','ERROR','CANCELLED','PAUSED','REGENERATED'].includes(current?.status??'')?'${newTurn}':null;
  useActiveConversationReconciliation({enabled:!!activeOperation&&data.contextUsable,operationId:activeOperation,readOperation:data.readOperation,clear:data.clear});
  const stream=useConversationStream({operatorId:'fixture-operator',csrfToken:'fixture',domain,operationId:activeOperation,enabled:!!activeOperation&&data.contextUsable,readExpiresAt:data.context.value?.readExpiresAt??0,onResync:()=>activeOperation?data.readOperation(activeOperation):Promise.resolve(),onRenew:data.context.renew,onDenied:()=>data.clear(403),onContextChanged:()=>{}});
  return <main>
   <div id="conversation">{data.conversation?.runs.map(run=><p id={run.operationId==='${oldTurn}'?'old-run':undefined} key={run.operationId}>{run.content}</p>)}</div>
   <output id="history-raw">{data.history.value?.runs.map(run=>run.content).join('|')??'empty'}</output>
   <output id="cards">{data.cards.value?.items.map(item=>item.title).join('|')??'empty'}</output>
   <output id="blocked-reason">{data.conversation?.blockedReason??'none'}</output>
   <output id="context">{data.context.value?.conversationId??'empty'}</output>
   <output id="management">{data.management.value?.managementCapabilities?'present':'empty'}</output>
   <output id="denied">{String(data.denied)}</output><output id="history-done">{historyDone}</output><output id="operation-done">{operationDone}</output><output id="stream-finished">{String(stream.finished)}</output><output id="active-operation">{activeOperation??'none'}</output>
   <output id="history-error">{data.history.error}</output><output id="cards-error">{data.cards.error}</output><output id="context-error">{data.context.error}</output><output id="context-invalidated">{String(data.contextInvalidated)}</output>
   <button onClick={()=>{void data.history.read().finally(()=>setHistoryDone(value=>value+1));}}>Read history</button>
   <button onClick={()=>void data.cards.read()}>Read cards</button>
   <button onClick={()=>void data.context.read()}>Read context</button>
   <button onClick={()=>setActive(true)}>Start stream</button>
   <button onClick={()=>setDomain('governance')}>Switch domain</button>
   <button onClick={()=>void (async()=>{try{const value=await data.readOperation('${newTurn}');if(value)await data.context.renew();}finally{setOperationDone(value=>value+1);}})()}>Read and renew</button>
  </main>;
 }
 createRoot(document.getElementById('root')).render(<AdminQueryProvider><Probe/></AdminQueryProvider>);`;
 const bundle=await build({stdin:{contents:source,resolveDir:app,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'fixture-auth',setup(b){
  b.onResolve({filter:/^@payloadcms\/ui$/},()=>({path:'auth',namespace:'fixture'}));
  b.onResolve({filter:/settings-draft-memory$/},()=>({path:'identity',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='auth'?"export const useAuth=()=>({user:{externalId:'fixture-operator'}});":"export const settingsOperatorId=user=>user.externalId;",loader:'js'}));
  b.onResolve({filter:/^(react|react\/jsx-runtime|react-dom\/client)$/},args=>({path:require.resolve(args.path)}));
 }}]});
 const counts={history:0,cards:0,context:0,management:0,operation:0,stream:0},streams=new Set(),heldResponses=new Set(),operationMethods=[];
 let hold=null,releaseHeld=null,notifyHeld=null,fail=null,operationMode='normal',operationStart=0,contextLatest=null,historyConversationId=conversationId,contextConversationId=conversationId;
 const run=(id,text)=>({runId:'run-'+id,operationId:id,status:'COMPLETED',content:text,userInput:'question',createdAt:1,events:[],awaitingHuman:false});
 const server=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
  if(req.url.startsWith('/v1/operations/web-events')){res.setHeader('Content-Type','text/event-stream');res.write('data: {"type":"snapshot","cursor":"0"}\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
  if(req.url==='/v1/operations/session'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:'signed-in',operator:{id:'fixture-operator'},csrfToken:'fixture',expiresAt:Math.floor(Date.now()/1000)+300}));return;}
  const base='/v1/operations/agentos/conversations/overview/';
  if(req.url.startsWith(base)){
   const suffix=req.url.slice(base.length),kind=suffix==='management-capabilities'?'management':suffix.startsWith('operations/')&&/\/events(?:\?|$)/.test(suffix)?'stream':suffix.startsWith('operations/')?'operation':suffix;
   if(!Object.hasOwn(counts,kind)){res.writeHead(404);res.end();return;}
   counts[kind]++;if(kind==='operation'||kind==='stream')operationMethods.push(req.method);
   if(kind==='stream'){const checkedAt=Math.floor(Date.now()/1000);res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({kind:'lease',operationId:newTurn,readExpiresAt:checkedAt+300,stopAvailable:false})+'\n\ndata: '+JSON.stringify({kind:'terminal',operationId:newTurn,eventIndex:null,status:'COMPLETED'})+'\n\n');return;}
   res.setHeader('Content-Type','application/json');
   if(kind==='operation'&&['single-flight','terminal-retry'].includes(operationMode)&&counts.operation-operationStart===(operationMode==='single-flight'?2:1)){res.statusCode=503;res.end(JSON.stringify({error:'operations_unavailable'}));return;}
   if(fail?.kind===kind){res.statusCode=fail.status;res.end(JSON.stringify({error:fail.status===401?'operations_access_denied':'operations_unavailable'}));return;}
   if(kind==='operation'&&operationMode==='http409'){res.statusCode=409;res.end(JSON.stringify({error:'operations_agentos_source_changed'}));return;}
   const checkedAt=Math.floor(Date.now()/1000),common={domain:'overview',checkedAt,readExpiresAt:checkedAt+300};
   const body=kind==='history'?{...common,conversationId:historyConversationId,runs:[run(oldTurn,historyConversationId===conversationId?'completed original':'replacement conversation')],contextChanged:false}
    :kind==='cards'?{...common,items:[{title:'existing card'}]}
    :kind==='context'?{...common,conversationId:contextConversationId,contextChanged:false,runtimeState:'connected',modelState:'configured',capabilities:{canSend:true,canStream:true},blockedReason:null,latestOperation:contextLatest}
    :kind==='management'?{...common,managementCapabilities:{canRead:true}}
    :operationMode==='context-changed'?{operationId:newTurn,state:'context-changed'}:{operationId:newTurn,runId:'run-'+newTurn,state:'accepted',native:operationMode==='unknown-then-completed'&&counts.operation-operationStart===1?{...run(newTurn,'new event turn'),status:'unknown',content:null}:run(newTurn,'new event turn')};
   const finish=()=>{heldResponses.delete(res);if(!res.destroyed&&!res.writableEnded)res.end(JSON.stringify(body));};
   if(hold===kind){hold=null;heldResponses.add(res);releaseHeld=finish;notifyHeld?.();return;}finish();return;
  }
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/client.js"></script>');
 });
 let browser;const contexts=[],errors=[];
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(browserExecutable?{executablePath:browserExecutable}:{})});
  async function freshPage(){const context=await browser.newContext();contexts.push(context);await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);return {page,context};}
  async function waitOutput(page,id,text){await page.waitForFunction(([selector,value])=>document.querySelector(selector)?.textContent===value,['#'+id,text]);}

  hold='cards';const cardsHeld=new Promise(resolve=>{notifyHeld=resolve;});let current=await freshPage();await cardsHeld;
  await waitOutput(current.page,'history-raw','completed original');await current.page.locator('#old-run').waitFor();
  assert.equal(await current.page.locator('#cards').textContent(),'empty','held cards must not block history');releaseHeld();await waitOutput(current.page,'cards','existing card');await current.context.close();

  hold='history';const historyHeld=new Promise(resolve=>{notifyHeld=resolve;});current=await freshPage();await historyHeld;
  await waitOutput(current.page,'cards','existing card');assert.equal(await current.page.locator('#history-raw').textContent(),'empty','held history must not block cards');
  releaseHeld();await waitOutput(current.page,'history-raw','completed original');await current.context.close();

  hold=null;fail=null;current=await freshPage();const page=current.page;
  await waitOutput(page,'history-raw','completed original');await waitOutput(page,'cards','existing card');await waitOutput(page,'blocked-reason','none');await waitOutput(page,'context',conversationId);await waitOutput(page,'management','present');
  fail={kind:'history',status:503};await page.getByRole('button',{name:'Read history'}).click();await page.waitForFunction(()=>!!document.querySelector('#history-error')?.textContent);
  assert.equal(await page.locator('#history-raw').textContent(),'completed original');assert.equal(await page.locator('#cards').textContent(),'existing card','history 503 must not erase cards');
  fail=null;await page.getByRole('button',{name:'Read history'}).click();await waitOutput(page,'history-error','');
  fail={kind:'cards',status:503};await page.getByRole('button',{name:'Read cards'}).click();await page.waitForFunction(()=>!!document.querySelector('#cards-error')?.textContent);
  assert.equal(await page.locator('#cards').textContent(),'existing card');assert.equal(await page.locator('#history-raw').textContent(),'completed original','cards 503 must not erase history');
  fail=null;await page.getByRole('button',{name:'Read cards'}).click();await waitOutput(page,'cards-error','');const historyBefore=counts.history;await page.evaluate(()=>{window.__oldRun=document.querySelector('#old-run');});
  await page.evaluate(({parentId,turnId})=>window.dispatchEvent(new CustomEvent('galaxy:admin-agentos-change',{detail:{kind:'conversation-operation',objectId:turnId,parentId,turnId}})),{parentId:conversationId,turnId:newTurn});
  await page.getByText('new event turn',{exact:true}).waitFor();assert.equal(counts.history,historyBefore,'operation event must read its original operation, not the whole history');assert.ok(counts.operation>0);
  assert.equal(await page.locator('#old-run').textContent(),'completed original');assert.equal(await page.evaluate(()=>window.__oldRun===document.querySelector('#old-run')),true,'completed sibling remains mounted');

  fail={kind:'context',status:401};await page.getByRole('button',{name:'Read context'}).click();await waitOutput(page,'denied','true');
  await waitOutput(page,'history-raw','empty');await waitOutput(page,'cards','empty');await waitOutput(page,'context','empty');await waitOutput(page,'management','empty');
  assert.equal(await page.locator('#conversation').textContent(),'','shared 401 must remove all old conversation content');await current.context.close();

  for(const mode of ['context-changed','http409']){
   fail=null;hold=null;operationMode='normal';historyConversationId=conversationId;contextConversationId=conversationId;
   current=await freshPage();const retiredPage=current.page;
   await waitOutput(retiredPage,'history-raw','completed original');await waitOutput(retiredPage,'cards','existing card');await waitOutput(retiredPage,'context',conversationId);await waitOutput(retiredPage,'management','present');await retiredPage.locator('#old-run').waitFor();
   hold='history';const staleHistoryHeld=new Promise(resolve=>{notifyHeld=resolve;});await retiredPage.getByRole('button',{name:'Read history'}).click();await staleHistoryHeld;
   // The exact-operation reply changes context while the previous history GET
   // remains in flight and the independent context renewal fails temporarily.
   fail={kind:'context',status:503};operationMode=mode;
   await retiredPage.evaluate(({parentId,turnId})=>window.dispatchEvent(new CustomEvent('galaxy:admin-agentos-change',{detail:{kind:'conversation-operation',objectId:turnId,parentId,turnId}})),{parentId:conversationId,turnId:newTurn});
   await retiredPage.waitForFunction(()=>!!document.querySelector('#context-error')?.textContent);
   assert.equal(await retiredPage.locator('#conversation').textContent(),'',mode+': old prose must disappear when context refresh fails');
   assert.equal(await retiredPage.locator('#cards').textContent(),'existing card',mode+': unrelated cards remain visible');assert.equal(await retiredPage.locator('#management').textContent(),'present');
   await retiredPage.evaluate(()=>{window.__retiredSeen=[];new MutationObserver(()=>window.__retiredSeen.push(document.querySelector('#conversation')?.textContent)).observe(document.querySelector('#conversation'),{childList:true,subtree:true,characterData:true});});
   releaseHeld();
   // The hook may immediately clear the raw result during the 409 fence. Wait
   // for this explicit response and its read promise, rather than requiring the
   // raw history projection itself to remain visible.
   const historyBefore=counts.history,doneBefore=Number(await retiredPage.locator('#history-done').textContent());
   const oldHistoryResponse=retiredPage.waitForResponse(response=>new URL(response.url()).pathname==='/v1/operations/agentos/conversations/overview/history'&&response.status()===200);
   await retiredPage.getByRole('button',{name:'Read history'}).click();await oldHistoryResponse;
   await retiredPage.waitForFunction(previous=>Number(document.querySelector('#history-done')?.textContent)>previous,doneBefore);
   assert.ok(counts.history>historyBefore,mode+': the explicit old history GET reached the fixture');
   assert.equal(await retiredPage.locator('#conversation').textContent(),'',mode+': late old history must remain hidden');
   assert.equal(await retiredPage.evaluate(()=>window.__retiredSeen.some(value=>value?.includes('completed original'))),false,mode+': old prose must not flash during recovery');
   fail=null;await retiredPage.getByRole('button',{name:'Read context'}).click();await waitOutput(retiredPage,'context',conversationId);
   assert.equal(await retiredPage.locator('#conversation').textContent(),'',mode+': re-reading the retired ID must not revive it');
   historyConversationId=replacementConversation;contextConversationId=replacementConversation;operationMode='normal';
   await retiredPage.getByRole('button',{name:'Read context'}).click();await waitOutput(retiredPage,'context',replacementConversation);
   await retiredPage.getByRole('button',{name:'Read history'}).click();await retiredPage.locator('#conversation').getByText('replacement conversation',{exact:true}).waitFor();
   assert.equal(await retiredPage.locator('#cards').textContent(),'existing card',mode+': cards survive context replacement');
   await current.context.close();
  }
  await t.test('same-operation single flight retains completed response when trailing GET fails',async()=>{
   fail=null;contextLatest=null;historyConversationId=conversationId;contextConversationId=conversationId;operationMode='single-flight';operationStart=counts.operation;hold=null;
   current=await freshPage();const probe=current.page;
   await waitOutput(probe,'context',conversationId);await waitOutput(probe,'history-raw','completed original');
   hold='operation';const held=new Promise(resolve=>{notifyHeld=resolve;});
   const changed=()=>probe.evaluate(({parentId,turnId})=>window.dispatchEvent(new CustomEvent('galaxy:admin-agentos-change',{detail:{kind:'conversation-operation',objectId:turnId,parentId,turnId}})),{parentId:conversationId,turnId:newTurn});
   await changed();await held;await changed();assert.equal(counts.operation-operationStart,1,'a second event joins the original in-flight GET');
   const trailingFailure=probe.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/operations/'+newTurn)&&response.status()===503);
   releaseHeld();await probe.getByText('new event turn',{exact:true}).waitFor();await trailingFailure;
   assert.equal(await probe.getByText('new event turn',{exact:true}).count(),1,'later failure must not discard the earlier completed snapshot');
   assert.equal(counts.operation-operationStart,2,'an event received during a GET causes one follow-up GET');await current.context.close();
  });

  await t.test('stream terminal with failed original GET keeps reconciling by GET until completed',async()=>{
   fail=null;hold=null;contextLatest=null;historyConversationId=conversationId;contextConversationId=conversationId;operationMode='terminal-retry';operationStart=counts.operation;
   current=await freshPage();const probe=current.page;
   await waitOutput(probe,'context',conversationId);await waitOutput(probe,'history-raw','completed original');
   const failedOriginal=probe.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/operations/'+newTurn)&&response.status()===503);
   await probe.getByRole('button',{name:'Start stream'}).click();await failedOriginal;await waitOutput(probe,'stream-finished','true');
   await probe.getByText('new event turn',{exact:true}).waitFor();await waitOutput(probe,'active-operation','none');
   assert.ok(counts.operation-operationStart>=2,'failed terminal reconciliation must retry the same original GET');await current.context.close();
  });

  await t.test('unknown original native placeholder continues to completed',async()=>{
   fail=null;hold=null;historyConversationId=conversationId;contextConversationId=conversationId;operationMode='unknown-then-completed';operationStart=counts.operation;
   contextLatest={operationId:newTurn,runId:'run-'+newTurn,state:'accepted',knownNativeStatus:null,requiresOriginalLookup:true};
   current=await freshPage();const probe=current.page;
   await probe.getByText('new event turn',{exact:true}).waitFor();
   assert.ok(counts.operation-operationStart>=2,'unknown is not a terminal or live native status');await current.context.close();contextLatest=null;
  });

  await t.test('a late original GET cannot renew or apply after switching domain',async()=>{
   fail=null;contextLatest=null;historyConversationId=conversationId;contextConversationId=conversationId;operationMode='normal';hold=null;
   current=await freshPage();const probe=current.page;
   await waitOutput(probe,'context',conversationId);await waitOutput(probe,'history-raw','completed original');
   hold='operation';const held=new Promise(resolve=>{notifyHeld=resolve;});await probe.getByRole('button',{name:'Read and renew'}).click();await held;
   await probe.getByRole('button',{name:'Switch domain'}).click();await waitOutput(probe,'context','empty');const oldContextRequests=counts.context;
   releaseHeld();await waitOutput(probe,'operation-done','1');
   assert.equal(counts.context,oldContextRequests,'late original GET must not renew the old domain');assert.equal(await probe.locator('#conversation').textContent(),'','late original result must not populate the new domain');await current.context.close();
  });
  assert.ok(operationMethods.length>0);assert.ok(operationMethods.every(method=>method==='GET'),'stream and original reconciliation never POST');
  assert.deepEqual(errors,[]);
 }finally{
  for(const res of heldResponses)res.destroy();for(const res of streams)res.end();
  for(const context of contexts)await context.close().catch(()=>{});await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
});
