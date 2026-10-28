// One independent website/admin -> complete Go main -> real disposable PG cohort.
// The descriptor is prepared by TestFullEntryBrowserFlow; no business response
// is substituted here. TLS/DNS changes apply only to this process/profile.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer as httpsServer} from 'node:https';
import {request as httpRequest,createServer as httpServer} from 'node:http';
import {mkdtemp,open,readFile,writeFile,stat,mkdir,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright';

const temporary=path=>{const rel=relative(resolve(tmpdir()),resolve(path));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'OS temporary fixture required');return resolve(path);};
const d=JSON.parse(await readFile(temporary(process.env.GALAXY_GO_BROWSER_DESCRIPTOR),'utf8'));
const root=resolve(d.sourceRoot??process.cwd()),api=new URL(d.apiLoopback),website=new URL(d.websiteOrigin),admin=new URL(d.adminOrigin),endpoint=new URL(d.endpoint),cms=new URL(d.cmsDatabaseURL);
assert.equal(api.protocol,'http:');assert.equal(api.hostname,'127.0.0.1');
assert.equal(cms.protocol,'postgres:');assert.equal(cms.hostname,'127.0.0.1');assert.match(cms.pathname,/^\/galaxy_go_test_[a-z0-9_]+$/);
for(const [origin,hostname] of [[website,'web.galaxy.localhost'],[admin,'admin.galaxy.localhost'],[endpoint,'api.galaxy.localhost']]){assert.equal(origin.protocol,'https:');assert.equal(origin.hostname,hostname);assert.equal(Number(origin.port||443),d.proxyPort);}
assert.equal(new Set([website.host,admin.host,endpoint.host]).size,3);
assert(d.browserScope===undefined||d.browserScope==='admin');const adminOnly=d.browserScope==='admin';
assert(d.expiresAt>Math.floor(Date.now()/1000));assert(d.feedbackId);if(!adminOnly){assert.equal(d.forum.published,false);assert.equal(d.chat.messageDeliverySeeded,false);}
const directory=await mkdtemp(join(tmpdir(),'galaxy-full-api-browser-')),children=[],logs=[],ownedProcesses=[];
let proxy,browser;const pages=[],errors=[],consoleErrors=[],chatFailures=[],pageFailures=new Map();
const diagnosticText=value=>String(value).replace(/https?:\/\/[^\s"'<>]+/g,text=>{try{const url=new URL(text);return url.origin+url.pathname;}catch{return '[url]';}});
function observePage(page){
 const failures=[];pageFailures.set(page,failures);
 page.on('pageerror',error=>errors.push(diagnosticText(error.message)));
 // React boundaries may consume an exception without emitting pageerror. Save
 // only console's text, never evaluate its argument objects or React props.
 page.on('console',message=>{if(message.type()==='error')consoleErrors.push(diagnosticText(message.text()));});
 page.on('response',response=>{
  const url=new URL(response.url());
  if(response.status()>=400)failures.push({host:url.host,path:url.pathname,status:response.status()});
 });
 page.on('requestfailed',request=>{const target=new URL(request.url()),error=diagnosticText(request.failure()?.errorText??'request_failed');failures.push({host:target.host,path:target.pathname,error});console.error(JSON.stringify({stage:'browser-requestfailed',host:target.host,error}));});
}
async function freePort(){const server=httpServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});const port=server.address().port;await new Promise(yes=>server.close(yes));return port;}
async function launch(label,args,cwd,env,port){const log=await open(join(directory,label+'.log'),'w');logs.push(log);const child=spawn(process.execPath,args,{cwd,windowsHide:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,...env,NEXT_TELEMETRY_DISABLED:'1'}});children.push(child);ownedProcesses.push({label,pid:child.pid,port});await writeFile(join(directory,'owned-processes.json'),JSON.stringify({processes:ownedProcesses},null,2)+'\n',{mode:0o600});return child;}
async function ready(port,path,child){const deadline=Date.now()+120000;for(;;){if(child.exitCode!==null)throw Error('Next stopped; inspect '+directory);try{const response=await fetch('http://127.0.0.1:'+port+path,{redirect:'manual',signal:AbortSignal.timeout(5000)});if(response.status<500)return;}catch{}if(Date.now()>deadline)throw Error('Next startup timeout; inspect '+directory);await new Promise(yes=>setTimeout(yes,400));}}
async function jsonCall(page,path,body){return page.evaluate(async({url,account,csrf,body})=>{const response=await fetch(url,{method:body===null?'GET':'POST',credentials:'include',headers:{Accept:'application/json','Content-Type':'application/json','X-Galaxy-Account-ID':account,'X-Galaxy-Account-CSRF':csrf},...(body===null?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};},{url:endpoint.origin+path,account:d.people[0].accountId,csrf:d.people[0].csrf,body});}
try{
 const sitePort=await freePort(),adminPort=await freePort();
 // Use the existing public signing document/configuration from the actual API
 // fixture. A new arbitrary browser signing key would hide a broken main setup.
 const publicFile=d.publicConfigurationFile?temporary(d.publicConfigurationFile):join(directory,'public-configuration.json');
 if(!d.publicConfigurationFile){assert(d.publicConfiguration?.signingKeys?.length,'actual API public signing configuration required');await writeFile(publicFile,JSON.stringify(d.publicConfiguration),{mode:0o600});}
 const common={GALAXY_WEB_CONFIG_FILE:publicFile};
 const siteRuntime=d.siteRuntimeDirectory?resolve(d.siteRuntimeDirectory):null;
 if(siteRuntime)await stat(join(siteRuntime,'start.mjs'));
 else await stat(join(root,'apps/galaxy-site/.next/standalone/apps/galaxy-site/server.js'));
 const site=await launch('website',siteRuntime?[join(siteRuntime,'start.mjs')]:[join(root,'scripts/web-runtime.mjs'),'start'],siteRuntime??root,{...common,PORT:String(sitePort),GALAXY_PREVIEW_PORT:String(sitePort),GALAXY_SITE_HOST:'127.0.0.1',...(d.siteBaselineRoot?{GALAXY_SITE_BASELINE_ROOT:resolve(d.siteBaselineRoot)}:{})},sitePort);
 const adminApp=join(root,'apps/galaxy-admin');
 const adminStandalone=join(adminApp,'.next/standalone/apps/galaxy-admin');await stat(join(adminStandalone,'server.js'));
 const adminEnv={NODE_ENV:'production',GALAXY_ADMIN_PUBLIC_ORIGIN:admin.origin,GALAXY_ADMIN_BFF_ORIGIN:api.origin,GALAXY_CMS_DATABASE_URL:cms.href,GALAXY_CMS_SECRET:randomBytes(32).toString('hex'),GALAXY_CMS_DEV_PUSH:'false'};
 // Only the already asserted disposable literal-loopback CMS database is
 // migrated, through the original migration command and existing migrations.
 const migration=await launch('cms-migrate',[join(adminApp,'node_modules/payload/bin.js'),'migrate'],adminApp,adminEnv,null);
 const migrationCode=await new Promise((yes,no)=>{if(migration.exitCode!==null){yes(migration.exitCode);return;}migration.once('error',no);migration.once('exit',code=>yes(code));});
 assert.equal(migrationCode,0,'isolated CMS migration failed; inspect '+join(directory,'cms-migrate.log'));
 await mkdir(join(adminStandalone,'.next'),{recursive:true});await cp(join(adminApp,'.next/static'),join(adminStandalone,'.next/static'),{recursive:true});
 try{await stat(join(adminApp,'public'));await cp(join(adminApp,'public'),join(adminStandalone,'public'),{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}
 const manager=await launch('admin',[join(adminStandalone,'server.js')],adminStandalone,{...adminEnv,HOSTNAME:'127.0.0.1',PORT:String(adminPort)},adminPort);
 await Promise.all([ready(sitePort,'/',site),ready(adminPort,'/admin/login',manager)]);
 const upstream=new Map([[website.host,new URL('http://127.0.0.1:'+sitePort)],[admin.host,new URL('http://127.0.0.1:'+adminPort)],[endpoint.host,api]]);
 const proxyCertificate=await readFile(temporary(d.tlsCert));
 proxy=httpsServer({cert:proxyCertificate,key:await readFile(temporary(d.tlsKey))},(request,response)=>{
  const target=upstream.get(request.headers.host);if(!target){response.writeHead(421);response.end();return;}
  // Match the existing trusted edge contract: the loopback proxy supplies the
  // actual client address; the HTTPS admin origin is not a fixture-cookie mode.
  const headers={...request.headers,'x-forwarded-host':request.headers.host,'x-forwarded-proto':'https','x-forwarded-for':request.socket.remoteAddress};
  const forwarded=httpRequest({hostname:'127.0.0.1',port:target.port,path:request.url,method:request.method,headers},incoming=>{response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response);});
  // Pipe immediately, without buffering or SSE timeouts. Client disconnect
  // closes its upstream request instead of keeping an orphan event listener.
  forwarded.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});response.on('close',()=>forwarded.destroy());request.pipe(forwarded);
 });
 // Preserve handshake failures before any HTTP/Next request exists; never
 // log certificate/key bodies or session headers.
 const tlsErrors=new Set();proxy.on('tlsClientError',error=>{const code=error.code??'tls_handshake_error';if(!tlsErrors.has(code)){tlsErrors.add(code);console.error('Isolated HTTPS handshake failed: '+code);}});
 await new Promise((yes,no)=>{proxy.once('error',no);proxy.listen(d.proxyPort,'127.0.0.1',yes);});
 const browserEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>! /^(?:http|https|all|no)_proxy$/i.test(name)));
 // Chromium resolves *.localhost as loopback itself. Do not override that
 // native behavior with the former *.invalid host-resolver argument.
 browser=await chromium.launch({headless:true,env:browserEnv,args:['--no-proxy-server']});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1366,height:900}});
 await context.route('**/*',route=>{const url=new URL(route.request().url());return ['data:','blob:'].includes(url.protocol)||upstream.has(url.host)?route.continue():route.abort('blockedbyclient');});
 await context.addCookies([{...d.people[0].cookie,url:endpoint.origin,httpOnly:true,secure:true,sameSite:'Lax'},{...d.operator.cookie,url:admin.origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
 if(!adminOnly){
 const page=await context.newPage();pages.push(page);observePage(page);
 page.on('response',response=>{if(new URL(response.url()).host===endpoint.host&&response.url().includes('/chat/')&&response.status()>=400)chatFailures.push({status:response.status(),path:new URL(response.url()).pathname});});
 await page.goto(website.origin+'/',{waitUntil:'domcontentloaded',timeout:60000});await page.locator('main').waitFor();assert((await page.locator('body').innerText()).trim().length>100,'actual public content');
 // Publish through the original account HTTP contract in the actual browser.
 // The seed contains only input/IDs; the business row must be created by Go.
 const publication=await jsonCall(page,'/v2/community/posts',{payloadJson:JSON.stringify(d.forum.payload)});assert(publication.status>=200&&publication.status<300,'forum publish rejected: '+JSON.stringify(publication));
 const post=await jsonCall(page,'/v2/community/posts/'+d.forum.postId,null);assert.equal(post.status,200);assert(JSON.stringify(post.body).includes(d.forum.payload.body));
 await page.goto(website.origin+'/app/community/posts/'+d.forum.postId,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:d.forum.payload.title,exact:true}).waitFor({timeout:30000});await page.getByText(d.forum.payload.body,{exact:true}).first().waitFor();
 await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:d.forum.payload.title,exact:true}).waitFor();
 await page.goto(website.origin+'/app/rooms/'+d.chat.roomId,{waitUntil:'domcontentloaded'});
 const composer=page.getByRole('textbox',{name:'消息',exact:true});await composer.waitFor({timeout:45000});
 const draft='独立浏览器未发送文字：目录或消息传输暂缺时仍应保留。';await composer.fill(draft);
 const send=page.getByRole('button',{name:'发送',exact:true});
 if(await send.isEnabled()){const rejected=page.waitForResponse(response=>new URL(response.url()).host===endpoint.host&&response.url().includes('/chat/')&&response.status()>=400,{timeout:20000});await send.click();await rejected;}
 else await page.waitForFunction(()=>document.querySelector('[role="alert"],.read-failure,.conversation-error')!==null,{},{timeout:20000});
 assert(chatFailures.length>0,'expected actual Go chat directory/transport error');assert.equal(await composer.inputValue(),draft);
 // A real reload exercises the same IndexedDB/local draft restoration path.
 await page.reload({waitUntil:'domcontentloaded'});await composer.waitFor();await page.waitForFunction(value=>document.querySelector('textarea[aria-label="消息"]')?.value===value,draft,{timeout:20000});
 }
 const operations=await context.newPage();pages.push(operations);observePage(operations);
 await operations.bringToFront();
 const feedbackURL=admin.origin+'/admin/operations/feedback?days=all&id='+d.feedbackId;
 await operations.goto(feedbackURL,{waitUntil:'domcontentloaded',timeout:90000});
 await operations.getByRole('heading',{name:'使用反馈',exact:true}).waitFor({timeout:60000});
 await operations.getByRole('heading',{name:'使用反馈',exact:true}).click();
 const editor=operations.locator('section.galaxy-feedback-editor'),status=editor.getByRole('combobox',{name:/^处理状态/});
 await status.selectOption('processing');await editor.getByRole('textbox').fill('完整 Go API 网页联检：保留原提交与处理记录。');await editor.getByRole('button',{name:'保存处理',exact:true}).click();await operations.getByText('处理已保存。',{exact:true}).waitFor({timeout:20000});
 await operations.goto(admin.origin+'/admin/operations/feedback?days=all',{waitUntil:'domcontentloaded'});await operations.goto(feedbackURL,{waitUntil:'domcontentloaded'});await status.waitFor();await operations.waitForFunction(()=>document.querySelector('.galaxy-feedback-editor-fields > label:nth-child(3) select')?.value==='processing',{},{timeout:20000});assert.equal(await status.inputValue(),'processing');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({browserScope:adminOnly?'admin':'full',independentHeadless:true,fullGoAPI:true,actualNextPayload:true,publicRead:!adminOnly,forumPublishedAndRead:!adminOnly,chatTransportUnavailable:!adminOnly,chatDraftRestored:!adminOnly,feedbackSavedAndReturned:true}));
}catch(error){
 // Do not print the descriptor, cookies or CSRF material. Keep real runtime
 // diagnostics in the disposable fixture directory for the parent failure.
 await Promise.allSettled(pages.map(async(page,index)=>{
  if(page.isClosed())return;
  const prefix=join(directory,'failure-page-'+(index+1));
  await Promise.allSettled([
   page.screenshot({path:prefix+'.png',fullPage:true,timeout:5000}),
   page.locator('body').innerText({timeout:5000}).then(text=>writeFile(prefix+'.txt',text,{mode:0o600})),
  ]);
 }));
 const pageStates=await Promise.all(pages.map(async(page,index)=>{
  const result={page:index+1,failedResources:pageFailures.get(page)??[]};
  if(page.isClosed())return {...result,closed:true};
  try{return {...result,...await page.evaluate(()=>({pathname:location.pathname,readyState:document.readyState,bodyChildCount:document.body?.childElementCount??0,scripts:Array.from(document.scripts).filter(script=>script.src).map(script=>new URL(script.src).pathname)}))};}
  catch{return {...result,stateUnavailable:true};}
 }));
 await writeFile(join(directory,'failure.json'),JSON.stringify({errors,consoleErrors,pages:pageStates},null,2)+'\n',{mode:0o600}).catch(()=>{});
 console.error('Full API browser cohort failed; Next logs: '+directory);throw error;
}finally{
 await browser?.close();
 if(proxy){proxy.closeAllConnections();await new Promise(yes=>proxy.close(yes));}
 for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){
  if(process.platform==='win32'){
   // Keep the original parent alive until taskkill can discover its complete
   // child tree. Killing a wrapper first can orphan Next's server process.
   await new Promise(yes=>{const stop=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.once('exit',yes);stop.once('error',yes);});
  }else{child.kill('SIGTERM');await Promise.race([new Promise(yes=>child.once('exit',yes)),new Promise(yes=>setTimeout(yes,4000))]);}
 }
 for(const log of logs)await log.close();
}
