import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {once} from 'node:events';
const require=createRequire(import.meta.url),ts=require('typescript');
const {flushSync}=require('react-dom'),esbuild=require('esbuild');
const {chromium}=require('C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourcePath=process.env.GALAXY_REGISTERED_INPUT_SOURCE||path.join(app,'src/components/RegisteredUsers.tsx');
const source=fs.readFileSync(sourcePath,'utf8'),tree=ts.createSourceFile(sourcePath,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const find=(root,predicate)=>{const out=[];const visit=node=>{if(predicate(node))out.push(node);ts.forEachChild(node,visit);};visit(root);return out;};
const js=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const dateSource=fs.readFileSync(path.join(app,'src/lib/registered-users-view-model.ts'),'utf8');
const dateTree=ts.createSourceFile('registered-users-view-model.ts',dateSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const dateFunction=find(dateTree,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='registeredDateFromInput')[0];
const registeredDateFromInput=new Function(js(dateFunction.getText(dateTree).replace(/^export\s+/,''))+';return registeredDateFromInput;')();
async function fastImplicitSubmit(helper,handler){
 const evidence=path.resolve(process.env.GALAXY_REGISTERED_INPUT_ARTIFACT_DIR||path.join(app,'test/.registered-input-evidence'));
 fs.mkdirSync(evidence,{recursive:true});const temporary=fs.mkdtempSync(path.join(evidence,'tmp-react-'));
 const input='fast-query',pendingSource=`import React,{useState,startTransition,Suspense} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
 const pending=new Promise(()=>{});function PendingRead({value}){if(value)throw pending;return React.createElement('span',null,'initial-read');}
 function Probe(){const[filters,setFilters]=useState({query:''}),[submitted,setSubmitted]=useState(null);${js(helper)}const handler=${js('const actualHandler='+handler+';').replace(/^const actualHandler\s*=\s*/,'').replace(/;\s*$/,'')};
 return React.createElement(React.Fragment,null,React.createElement('form',{onSubmit:event=>{event.preventDefault();setSubmitted(filters.query);}},React.createElement('input',{type:'search','aria-label':'Fast query',value:filters.query,onChange:event=>startTransition(()=>handler(event))}),React.createElement('button',{type:'submit'},'Query'),React.createElement('output',{'data-recorded':submitted!==null,'data-query':submitted??''},submitted??'not-submitted')),React.createElement(Suspense,{fallback:React.createElement('span',null,'pending-read')},React.createElement(PendingRead,{value:filters.query})));}
 createRoot(document.getElementById('root')).render(React.createElement(Probe));`;
 const bundle=await esbuild.build({stdin:{contents:pendingSource,resolveDir:app,sourcefile:'actual-registered-filter-commit.js'},bundle:true,write:false,platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'one-react-runtime',setup(build){build.onResolve({filter:/^(react|react\/jsx-runtime|react-dom|react-dom\/client)$/},args=>({path:require.resolve(args.path)}));}}]});
 const server=http.createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(req.url==='/client.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].text);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/client.js"></script>');}});
 let browser,context,page;const report={scope:'One actual React handler/helper probe with a pending concurrent read; synthetic query only; no product API/OIDC or business/provider contact.',personalBrowserUsed:false,productionRequests:0,pageErrors:[],externalRequests:[],passed:false};
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});context=await browser.newContext();page=await context.newPage();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(report.externalRequests.push('unexpected-external-origin'),route.abort()));page.on('pageerror',error=>report.pageErrors.push(error.name));
  await page.goto(origin);const query=page.getByRole('searchbox',{name:'Fast query',exact:true});await query.waitFor();
  await query.fill(input);await query.press('Enter');
  await page.locator('output[data-recorded=true]').waitFor({state:'attached'});
  report.submitted=await page.locator('output').getAttribute('data-query');report.focusPreserved=await query.evaluate(element=>document.activeElement===element);report.inputPreserved=await query.inputValue()===input;
  await page.screenshot({path:path.join(evidence,'fast-implicit-submit.png')});
  assert.equal(report.submitted,input,'Fast implicit submit must use this event\'s committed query despite a pending concurrent read');assert.equal(report.inputPreserved,true);assert.equal(report.focusPreserved,true);assert.equal(report.pageErrors.length,0);assert.equal(report.externalRequests.length,0);report.passed=true;
 }finally{
  if(browser)await browser.close();if(server.listening)await new Promise(resolve=>server.close(resolve));
  const absolute=path.resolve(temporary);assert.ok(absolute.startsWith(evidence+path.sep)&&path.basename(absolute).startsWith('tmp-react-'),'Cleanup only owns its newly created temporary fixture');fs.rmSync(absolute,{recursive:true,force:true});report.browserClosed=true;fs.writeFileSync(path.join(evidence,'fast-implicit-submit.json'),JSON.stringify(report,null,2)+'\n');
 }
}
test('registered filter handlers snapshot and commit fast input before implicit submit under a pending read',async()=>{
 const helper=find(tree,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='updateFilters')[0];
 const handlers=find(tree,node=>ts.isJsxAttribute(node)&&node.name.getText(tree)==='onChange'&&/\b(?:setFilters|updateFilters)\(/.test(node.initializer?.getText(tree)??''));
 assert.equal(handlers.length,9,'Every directory input/select/date handler participates in this regression');
 const samples={query:'queued-reader-query',source:'registered',business:'formed',subjectType:'person',login:'disabled',participation:'restricted',emailVerified:'no',registeredFrom:'2026-10-24T14:30',registeredTo:'2026-10-25T16:15'};
 for(const attribute of handlers){
  const element=attribute.parent.parent,valueAttribute=element.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(tree)==='value');
  const field=/filters\.(\w+)/.exec(valueAttribute.initializer.getText(tree))?.[1];
  assert.ok(Object.hasOwn(samples,field),'Known actual filter field');
  const queued=[],setFilters=updater=>queued.push(updater);
  const updateFilters=helper?new Function('setFilters','flushSync',js(helper.getText(tree))+';return updateFilters;')(setFilters,flushSync):()=>{throw Error('Unexpected filter helper');};
  const expression=attribute.initializer.expression.getText(tree);
  const handler=new Function('setFilters','updateFilters','registeredDateFromInput',js('const handler='+expression+';')+';return handler;')(setFilters,updateFilters,registeredDateFromInput);
  const target={value:samples[field]},initial={query:'',source:'all',business:'',subjectType:'',login:'',participation:'',emailVerified:'',registeredFrom:'',registeredTo:''};
  handler({target});
  assert.equal(queued.length,1);
  const eager=queued[0](initial);
  // React may restore the controlled DOM before rebasing this updater.
  // No event/target object may supply a different value on that second pass.
  target.value='';
  const replayed=queued[0](initial),expected=field.startsWith('registered')?registeredDateFromInput(samples[field]):samples[field];
  assert.equal(replayed[field],expected,field+' must survive a later DOM value change');
  assert.deepEqual(replayed,eager,field+' updater must be pure when replayed');
  assert.equal(initial.query,'','Previous state remains unmodified');
 }
 const queryHandler=handlers.find(attribute=>attribute.parent.parent.attributes.properties.some(node=>ts.isJsxAttribute(node)&&node.name.getText(tree)==='value'&&node.initializer.getText(tree)==='{filters.query}'));
 await fastImplicitSubmit(helper.getText(tree),queryHandler.initializer.expression.getText(tree));
});

