import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';
import {resolve,join,sep,extname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import { chromium, browserToolOutput, requiredToolInput, loadToolMcpClient } from './browser-tool-runtime.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const dist=resolve(process.env.GALAXY_ACCOUNT_DIST??join(repo,'packages/galaxy-web/dist'));
const out=browserToolOutput(import.meta.url, process.env.GALAXY_ACCOUNT_REPORT);
const website='https://account-flow.example',endpoint='https://official.example.org',issuerAlias='https://isolated-oidc.example';
const nativeCandidate=requiredToolInput('GALAXY_NATIVE_CANDIDATE_DIR');
const nativeScopes=['binding','consent','case-teaser','history','assistance','context'];
const load=path=>import(pathToFileURL(join(repo,path)));
const [{serviceFixture},{createApi},{browserScopes},{oidcProviderFixture},{createOidcLoginProvider},{IdentityLinkService}]=await Promise.all([
  load('packages/galaxy-official/test/service-fixture.mjs'),load('packages/galaxy-official/src/http.mjs'),load('packages/galaxy-official/src/browser-client.mjs'),
  load('packages/galaxy-official/test/oidc-provider-fixture.mjs'),load('packages/galaxy-official/src/oidc-login.mjs'),load('packages/galaxy-official/src/identity-links.mjs')]);
const html=await readFile(join(dist,'index.html'),'utf8');
const files=[...['main.tsx','account-settings.tsx','runtime.mjs','account-verification-client.mjs'].map(n=>join(repo,'packages/galaxy-web/src',n)),fileURLToPath(import.meta.url),join(dist,'index.html'),...[...html.matchAll(/(?:src|href)="\/app\/(assets\/[^"?]+)"/g)].map(m=>join(dist,m[1]))];
for(const name of (await readdir(nativeCandidate)).filter(name=>/\.(?:[cm]?js|json)$/.test(name)))files.push(join(nativeCandidate,name));
const sha=data=>createHash('sha256').update(data).digest('hex');
const hashFiles=async()=>Object.fromEntries(await Promise.all(files.map(async path=>[path,sha(await readFile(path))])));
const report={startedAt:new Date().toISOString(),website,endpoint,dist,sourceBefore:await hashFiles(),checks:[],apiCalls:[],pageErrors:[],boundary:{
  actualFrozenProductionMain:true,actualBrowserWebCryptoIndexedDB:true,actualHttpPGlite:true,syntheticCommunityQuota:false,
  actualIndependentOidcCodePkceIdToken:true,externalSubjectSynthetic:true,productionProviderOrRealEmailOrPersonTested:false,
  testTransport:'Only browser authorization URL origin is aliased to isolated HTTPS; original OIDC authorization URL, PKCE, code exchange, issuer, claims and signature verification are processed by actual provider libraries.',
  controlledInterleavings:'The test-only React DevTools hook exposes the existing production runtime in memory to rebind/recover while AccountSettings stays mounted; source and assets are not replaced.',modelCalls:0,
  draftScope:'Actual persisted chat create operation and Native Task publication draft plus signed pending operation; not unsaved Task-comment editor text.',compiledNativeCandidate:nativeCandidate,
  fixtureClock:'Browser, Galaxy services and Native use the same fresh fixed second; real OIDC provider performs its own code and token validation.'}};
let fixture,api,browser,issuer,unverifiedIssuer,failure,hold=null,native,nativeServer,nativeClient,nativeDirectory,lastPage;
const loopbackOrigins=new Set(),opened=[];let dropConfirmActor=null,failProviderActor=null;
const contexts=[];
await mkdir(out,{recursive:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
try{
  const now=Math.floor(Date.now()/1000);
  issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
  const provider=await createOidcLoginProvider({id:'fixture',name:'Isolated OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
  unverifiedIssuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/no-email'],{emailVerified:false});
  const unverifiedProvider=await createOidcLoginProvider({id:'no-email',name:'Unverified email OIDC',issuer:unverifiedIssuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/no-email',allowLoopbackHttp:true,now:()=>now});
  const providers=[provider,unverifiedProvider],issuerFlows=new Map([[issuerAlias,issuer],['https://isolated-unverified.example',unverifiedIssuer]]);
  fixture=await serviceFixture(browserScopes,null,{now,identityProviders:providers,syntheticCommunityQuota:false});
  api=createApi({...fixture,browserOrigins:[website],rateLimit:10000});await new Promise(r=>api.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+api.address().port;
  browser=await chromium.launch({ headless:true });
  async function makePage(name,viewport={width:1440,height:1000}){
    const context=await browser.newContext({viewport,reducedMotion:'reduce'});contexts.push(context);context.setDefaultTimeout(15000);context.on('page',page=>page.on('pageerror',e=>report.pageErrors.push({actor:name,message:e.message})));
    await context.addInitScript(now=>{Date.now=()=>now*1000;},now);
    await context.addInitScript(()=>{
      const probe={runtime:null,rendered:null,commits:[],watchText:'synthetic-oidc-subject'};window.__accountProbe=probe;
      const observe=root=>{
        const visit=fiber=>{if(!fiber)return;let hook=fiber.memoizedState,count=0;while(hook&&count++<100){const value=hook.memoizedState;
          if(value&&typeof value.status==='function'&&typeof value.createIdentity==='function'&&value.api)probe.runtime=value;
          if(value&&Object.hasOwn(value,'identity')&&Object.hasOwn(value,'connection')&&typeof value.endpoint==='string')probe.rendered={subjectId:value.identity?.subjectId??null,deviceId:value.identity?.deviceId??null,bindingId:value.connection?.bindingId??null,generation:value.connection?.generation??null};
          hook=hook.next;}
          visit(fiber.child);visit(fiber.sibling);};visit(root.current);
        if(probe.rendered){const body=document.body?.textContent??'';probe.commits.push({...probe.rendered,oldAccountVisible:body.includes(probe.watchText),confirmVisible:body.includes('确认关联这个账号'),hasAccount:!!document.querySelector('.account-settings'),alert:document.querySelector('.account-settings [role="alert"]')?.textContent??''});}
      };
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,onCommitFiberRoot:(_id,root)=>observe(root),onCommitFiberUnmount:()=>{},onPostCommitFiberRoot:()=>{},checkDCE:()=>{}};
    });
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin===website){
        if(url.pathname==='/galaxy-web-config.json')return route.fulfill({json:{version:1,endpoint,operator:'Isolated account flow',signingKeys:[...fixture.bindings.trustedKeys].map(([kid,pin])=>({kid,...pin}))}});
        const path=url.pathname.startsWith('/app/assets/')?resolve(dist,'assets',url.pathname.slice('/app/assets/'.length)):resolve(dist,'index.html');
        assert.ok(path===resolve(dist,'index.html')||path.startsWith(resolve(dist,'assets')+sep));
        return route.fulfill({body:await readFile(path),contentType:extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html; charset=utf-8'});
      }
      if(issuerFlows.has(url.origin)){
        const selected=issuerFlows.get(url.origin),callback=await selected.authorize(selected.issuer+url.pathname+url.search);
        const response=await fetch(base+callback.pathname+callback.search);
        const value=await response.json();report.apiCalls.push({actor:name,method:'GET',path:callback.pathname,status:response.status,state:value.state});
        assert.equal(response.status,200);assert.equal(value.state,'awaiting-local-signature');
        return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><p>Isolated OIDC callback completed; return to the Galaxy page for local confirmation.</p>'});
      }
      if(url.origin===endpoint){
        if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':website,'access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,OPTIONS'}});
        const row={actor:name,method:request.method(),path:url.pathname,authenticated:!!request.headers().authorization};report.apiCalls.push(row);
        if(failProviderActor===name&&url.pathname==='/v1/identity/providers'){row.status=503;row.error='synthetic_provider_unavailable';return route.fulfill({status:503,json:{error:row.error},headers:{'access-control-allow-origin':website}});}
        const response=await fetch(base+url.pathname+url.search,{method:request.method(),headers:{...request.headers(),origin:website},body:['GET','HEAD'].includes(request.method())?undefined:request.postData()});
        row.status=response.status;let body=await response.text();
        if(response.status>=400){try{row.error=JSON.parse(body).error;}catch{}}
        if(url.pathname==='/v1/identity/begin'&&response.status===200){const value=JSON.parse(body),original=new URL(value.authorizationUrl);value.authorizationUrl=(original.origin===unverifiedIssuer.issuer?'https://isolated-unverified.example':issuerAlias)+original.pathname+original.search;body=JSON.stringify(value);}
        if(dropConfirmActor===name&&url.pathname==='/v1/identity/confirm'&&response.status===200){dropConfirmActor=null;row.responseDropped=true;return route.abort('connectionreset');}
        if(hold&&hold.actor===name&&hold.path===url.pathname&&!hold.used){const gate=hold;gate.used=true;row.delayed=true;gate.seen.resolve();await gate.release.promise;row.released=true;}
        return route.fulfill({status:response.status,body,contentType:response.headers.get('content-type')??'application/json',headers:{'access-control-allow-origin':website}});
      }
      if(loopbackOrigins.has(url.origin))return route.continue();
      return route.abort();
    });
    const page=await context.newPage();lastPage=page;
    return{page,context,name};
  }
  const button=(page,name)=>page.getByRole('button',{name,exact:true});
  const publicStatus=page=>page.evaluate(async()=>{const v=await window.__accountProbe.runtime.status();return{...v,connection:v.connection?{subjectId:v.connection.subjectId,bindingId:v.connection.bindingId,generation:v.connection.generation,scopes:v.connection.scopes}:null};});
  const screenshot=async(page,name)=>{await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:join(out,name+'.png'),fullPage:true});};
  async function createOrdinary(actor,target){const {page}=actor;
    await page.goto(website+target);await page.waitForFunction(()=>!!window.__accountProbe?.runtime);
    if((await page.getByRole('button',{name:'打开菜单',exact:true}).isVisible()))await button(page,'打开菜单').click();else await page.getByLabel('登录与账号',{exact:true}).click();
    await page.getByRole('link',{name:'登录 / 开始使用',exact:true}).click();await button(page,'创建我的银河身份').click();
    await page.getByRole('heading',{name:'当前银河身份',exact:true}).waitFor();await button(page,'连接并返回').click();await page.waitForURL(website+target);
    const state=await publicStatus(page);assert.ok(state.identity&&state.connection);return state;
  }
  async function accountEntry(page,{fromOriginal=false}={}){
    if(fromOriginal){await page.getByLabel('聊天名称',{exact:true}).fill('Synthetic account continuation');await button(page,'创建聊天').click();await button(page,'前往账号验证').click();await button(page,'使用 Isolated OIDC 验证').waitFor();return;}
    if(await button(page,'打开菜单').isVisible())await button(page,'打开菜单').click();else await page.getByLabel('我的账号',{exact:true}).click();
    await page.getByRole('link',{name:'账号与设置',exact:true}).click();await page.getByRole('navigation',{name:'账号设置分组'}).getByRole('link',{name:'账号验证',exact:true}).click();await button(page,'使用 Isolated OIDC 验证').waitFor();
  }
  async function preview(page,providerName='Isolated OIDC'){await button(page,'使用 '+providerName+' 验证').click();const popupReady=page.waitForEvent('popup');await page.getByRole('link',{name:'打开账号验证页 ↗',exact:true}).click();const popup=await popupReady;await popup.getByText('Isolated OIDC callback completed; return to the Galaxy page for local confirmation.',{exact:true}).waitFor();await popup.close();
    assert.equal((await page.evaluate(()=>window.__accountProbe.runtime.api.call('/v2/account/quotas',{}))).accountVerified,false);
    await button(page,'我已完成登录，查询结果').click();await button(page,'确认关联这个账号').waitFor();await page.locator('.account-settings details').filter({hasText:'准确身份与账号标识'}).locator('summary').click();
    return page.evaluate(async()=>({loginId:(await window.__accountProbe.runtime.accounts.pending()).id,...window.__accountProbe.rendered}));
  }
  const A=await makePage('ordinary-A'),target='/app/rooms?from=account-main#original-target';
  report.stage='ordinary-browser-identity';const initial=await createOrdinary(A,target);await accountEntry(A.page,{fromOriginal:true});const originalChat=await A.page.evaluate(()=>window.__accountProbe.runtime.chat.pending(null));const original=await preview(A.page);await screenshot(A.page,'01-original-preview');
  assert.equal(original.subjectId,initial.identity.subjectId);const beforeCount=(await fixture.db.query('SELECT count(*)::int n FROM external_identity_links')).rows[0].n;assert.equal(beforeCount,0);
  report.checks.push({id:'ordinary-browser-registration-connection-external-login-separate-local-confirmation',passed:true,subjectId:original.subjectId,agentContinuityRequired:false,externalLoginAloneAssociated:false});
  report.stage='same-subject-rebind-displayed-preview';
  await A.page.evaluate(()=>{window.__accountProbe.commits=[];});
  const rebound=await A.page.evaluate(async()=>{await window.__accountProbe.runtime.connect({confirmed:true});const s=await window.__accountProbe.runtime.status();document.dispatchEvent(new Event('visibilitychange'));return{bindingId:s.connection.bindingId,generation:s.connection.generation,subjectId:s.identity.subjectId};});
  await A.page.waitForFunction(binding=>window.__accountProbe.rendered?.bindingId===binding,rebound.bindingId);
  const first=await A.page.evaluate(binding=>window.__accountProbe.commits.find(x=>x.bindingId===binding),rebound.bindingId);
  assert.equal(rebound.subjectId,original.subjectId);assert.notEqual(rebound.bindingId,original.bindingId);
  assert.equal(first.oldAccountVisible,false);assert.equal(first.confirmVisible,false);
  await button(A.page,'查询原验证结果').waitFor();assert.equal(await button(A.page,'确认关联这个账号').count(),0);assert.equal(await A.page.getByRole('link',{name:'打开账号验证页 ↗',exact:true}).count(),0);
  await screenshot(A.page,'02-same-subject-new-binding-old-preview-withheld');
  report.checks.push({id:'same-subject-rebind-first-commit-withholds-old-account-preview',passed:true,oldBindingId:original.bindingId,newBindingId:rebound.bindingId,firstCommit:first});
  await button(A.page,'查询原验证结果').click();await A.page.getByText('原登录流程当前不可用，尚未查到关联记录。可以继续查询，或停止本机流程后重新选择验证服务。',{exact:true}).waitFor();assert.equal((await fixture.db.query('SELECT count(*)::int n FROM external_identity_links')).rows[0].n,0);
  report.checks.push({id:'old-binding-query-unavailable-retains-record-with-no-new-association',passed:true,associations:0});
  await button(A.page,'停止本机重试').click();await button(A.page,'使用 Isolated OIDC 验证').waitFor();
  report.stage='ordinary-complete-current-flow';await preview(A.page);await button(A.page,'确认关联这个账号').click();await A.page.getByText('账号关联已记录 · 关联状态与公开操作资格分别核对。',{exact:true}).waitFor();
  const quota=await A.page.evaluate(()=>window.__accountProbe.runtime.api.call('/v2/account/quotas',{}));assert.equal(quota.accountVerified,true);await screenshot(A.page,'03-ordinary-account-linked');await button(A.page,'回到原目标').click();await A.page.waitForURL(website+target);assert.equal((await publicStatus(A.page)).identity.subjectId,initial.identity.subjectId);
  assert.deepEqual(await A.page.evaluate(()=>window.__accountProbe.runtime.chat.pending(null)),originalChat);
  report.checks.push({id:'ordinary-browser-current-binding-confirm-and-exact-return',passed:true,target,subjectUnchanged:true,accountVerified:true,agentRequired:false,originalChatOperationHash:sha(JSON.stringify(originalChat)),originalChatOperationPreserved:true});
  report.stage='delayed-http-generation-control';await accountEntry(A.page);
  hold={actor:'ordinary-A',path:'/v1/identity/query',seen:deferred(),release:deferred()};
  await A.page.evaluate(()=>{window.__lateRead=window.__accountProbe.runtime.api.call('/v1/identity/query',{}).then(()=>({accepted:true}),error=>({accepted:false,code:error.code??null,message:error.message}));});await hold.seen.promise;
  await A.page.evaluate(async()=>{await window.__accountProbe.runtime.connect({confirmed:true});document.dispatchEvent(new Event('visibilitychange'));});hold.release.resolve();const late=await A.page.evaluate(()=>window.__lateRead);hold=null;
  assert.equal(late.accepted,false);report.checks.push({id:'delayed-old-http-response-is-rejected-by-existing-generation-guard',passed:true,...late});
  report.stage='unmounted-old-account-read';hold={actor:'ordinary-A',path:'/v1/identity/providers',seen:deferred(),release:deferred()};await A.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await hold.seen.promise;await A.page.getByRole('navigation',{name:'主要功能',exact:true}).getByRole('link',{name:'项目',exact:true}).click();await A.page.waitForURL(website+'/app/projects');hold.release.resolve();hold=null;await A.page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await A.page.locator('.account-settings').count(),0);assert.equal(await A.page.getByText('确认关联这个账号',{exact:true}).count(),0);report.checks.push({id:'unmounted-account-delayed-read-does-not-revive-account-content-on-new-route',passed:true});
  report.stage='mobile-ordinary-account-route';const M=await makePage('ordinary-mobile',{width:390,height:844});const mobileInitial=await createOrdinary(M,target);await accountEntry(M.page,{fromOriginal:true});await preview(M.page);await screenshot(M.page,'04-mobile-preview');await button(M.page,'确认关联这个账号').click();await M.page.getByText('账号关联已记录 · 关联状态与公开操作资格分别核对。',{exact:true}).waitFor();await screenshot(M.page,'05-mobile-linked');await button(M.page,'回到原目标').click();await M.page.waitForURL(website+target);assert.equal((await publicStatus(M.page)).identity.subjectId,mobileInitial.identity.subjectId);report.checks.push({id:'390px-browser-account-confirm-and-original-target',passed:true,noHorizontalOverflow:true});
  report.stage='unknown-confirm-ack-and-temporary-service-restart';
  const U=await makePage('unknown-ack',{width:390,height:844});await createOrdinary(U,target);await accountEntry(U.page,{fromOriginal:true});const unknown=await preview(U.page);
  const confirmCount=()=>report.apiCalls.filter(row=>row.actor==='unknown-ack'&&row.path==='/v1/identity/confirm').length;
  dropConfirmActor='unknown-ack';await button(U.page,'确认关联这个账号').click();await U.page.locator('.account-settings [role="alert"]').waitFor();
  await U.page.waitForFunction(async()=>!!(await window.__accountProbe.runtime.accounts.pending())?.confirmationSubmitted);assert.equal(confirmCount(),1);assert.equal(await button(U.page,'使用 Isolated OIDC 验证').isDisabled(),true);await screenshot(U.page,'06-unknown-confirmation-preserves-original');
  const port=api.address().port;api.closeAllConnections();await new Promise(r=>api.close(r));fixture.identity=new IdentityLinkService(fixture.access,providers,{accountRegistry:fixture.communityAccounts});api=createApi({...fixture,browserOrigins:[website],rateLimit:10000});await new Promise(r=>api.listen(port,'127.0.0.1',r));
  const temporaryBefore=report.apiCalls.filter(row=>row.actor==='unknown-ack'&&row.path==='/v1/identity/status').length;
  await button(U.page,'我已完成登录，查询结果').click();await U.page.getByText('账号关联已记录 · 关联状态与公开操作资格分别核对。',{exact:true}).waitFor();await U.page.waitForFunction(async()=>await window.__accountProbe.runtime.accounts.pending()===null);
  assert.equal(confirmCount(),1);assert.equal(report.apiCalls.filter(row=>row.actor==='unknown-ack'&&row.path==='/v1/identity/status').length,temporaryBefore);assert.equal((await fixture.db.query('SELECT count(*)::int n FROM external_identity_links WHERE id=$1',[unknown.loginId])).rows[0].n,1);
  await screenshot(U.page,'07-durable-original-after-restart');report.checks.push({id:'lost-confirm-ack-then-identity-login-service-restart-recovers-durable-original-without-new-confirm',passed:true,loginId:unknown.loginId,confirmHttpCount:1,temporaryStatusNeededAfterRestart:false,serviceRestartScope:'IdentityLinkService short-lived login map and HTTP server; persisted database and active access service retained'});
  report.stage='explicit-unlink-and-provider-read-failure';const unlinkBefore=report.apiCalls.filter(row=>row.path==='/v1/identity/revoke').length;
  await button(U.page,'解除此关联').click();await button(U.page,'取消').click();assert.equal(report.apiCalls.filter(row=>row.path==='/v1/identity/revoke').length,unlinkBefore);
  await button(U.page,'解除此关联').click();await button(U.page,'确认解除').click();await U.page.getByText('此关联已解除 · 关联状态与公开操作资格分别核对。',{exact:true}).waitFor();await U.page.getByText('当前账号尚未满足本服务的账号验证要求。已有账号关联不等于获得公开操作资格。',{exact:true}).waitFor();
  assert.equal((await U.page.evaluate(()=>window.__accountProbe.runtime.accounts.quotas())).accountVerified,false);report.checks.push({id:'explicit-unlink-clears-current-account-qualification-with-cancel-no-write',passed:true});
  failProviderActor='unknown-ack';await U.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await U.page.locator('.account-settings [role="alert"]').filter({hasText:'验证入口'}).waitFor();assert.equal(await U.page.getByText('当前服务没有可用的账号验证入口。身份仍可使用；依赖账号验证的公开操作暂不能完成。',{exact:true}).count(),0);await screenshot(U.page,'08-provider-failure-not-empty-catalog');failProviderActor=null;await button(U.page,'重新读取账号状态').click();await button(U.page,'使用 Isolated OIDC 验证').waitFor();report.checks.push({id:'provider-503-does-not-claim-empty-catalog-or-success',passed:true,syntheticTransportFault:true});
  report.stage='linked-but-unverified-account';const V=await makePage('email-unverified');await createOrdinary(V,target);await accountEntry(V.page,{fromOriginal:true});await preview(V.page,'Unverified email OIDC');await button(V.page,'确认关联这个账号').click();await V.page.getByText('账号关联已记录 · 关联状态与公开操作资格分别核对。',{exact:true}).waitFor();await V.page.getByText('当前账号尚未满足本服务的账号验证要求。已有账号关联不等于获得公开操作资格。',{exact:true}).waitFor();assert.equal((await V.page.evaluate(()=>window.__accountProbe.runtime.accounts.quotas())).accountVerified,false);await screenshot(V.page,'09-linked-does-not-mean-qualified');report.checks.push({id:'actual-oidc-email-verified-false-link-is-not-public-write-qualification',passed:true});
  report.stage='native-default-six-scopes-account-and-original-publication';
  const [{createNativeRuntime},{createNativeToolServer},{Client,InMemoryTransport}]=await Promise.all([import(pathToFileURL(join(nativeCandidate,'runtime.js'))),import(pathToFileURL(join(nativeCandidate,'server.js'))),loadToolMcpClient()]);
  nativeDirectory=await mkdtemp(join(tmpdir(),'galaxy-account-native-'));native=await createNativeRuntime({dataDirectory:nativeDirectory,endpoint,website,trustedKeys:fixture.access.trustedKeys,now:()=>now,fetch:async(url,options)=>{const target=new URL(url);assert.equal(target.origin,endpoint);return fetch(base+target.pathname+target.search,options);},openBrowser:async url=>{opened.push(url);return{state:'captured-isolated-navigation',launched:false};}});
  await native.initialize({profile:'minimal'},{confirmed:true});await native.connect({confirmed:true});const nativeSubject=(await native.status()).identity;
  nativeServer=createNativeToolServer(native);nativeClient=new Client({name:'account-native-fixed-main',version:'1'},{capabilities:{}});const [left,right]=InMemoryTransport.createLinkedPair();await nativeServer.connect(left);await nativeClient.connect(right);
  const result=await nativeClient.callTool({name:'galaxy_identity_web_connect',arguments:{requestId:randomUUID(),object:{kind:'publish'},origin:{host:'isolated-account-native',workRef:'SYNTHETIC_PRIVATE_LOCAL_REFERENCE'}}});assert.equal(result.isError??false,false);const bridge=JSON.parse(result.content[0].text),bridgeUrl=new URL(bridge.url);assert.equal(bridgeUrl.protocol,'http:');assert.equal(bridgeUrl.hostname,'127.0.0.1');loopbackOrigins.add(bridgeUrl.origin);
  const N=await makePage('native-default',{width:390,height:844});await N.page.goto(bridge.url);const popupReady=N.page.waitForEvent('popup');await N.page.locator('#open').click();const nativeWeb=await popupReady;lastPage=nativeWeb;await N.page.locator('#offer').waitFor({state:'visible'});await N.page.locator('#approve').click();await nativeWeb.getByLabel('目标（用一句话说明）',{exact:true}).waitFor();
  const nativeConnected=await publicStatus(nativeWeb);assert.equal(nativeConnected.identity.subjectId,nativeSubject);assert.deepEqual(nativeConnected.connection.scopes,nativeScopes);
  await nativeWeb.getByLabel('目标（用一句话说明）',{exact:true}).fill('Synthetic Native account continuation');await nativeWeb.getByLabel('说说需要什么帮助',{exact:true}).fill('This isolated publication checks exact pending-operation continuation after account verification.');await button(nativeWeb,'继续并查找协助').click();await button(nativeWeb,'预览这份请求').click();await button(nativeWeb,'确认并发布这份任务').click();await button(nativeWeb,'前往账号验证').waitFor();
  const savedPublication=await nativeWeb.evaluate(()=>window.__accountProbe.runtime.getLocal('task-publication')),savedDraft=await nativeWeb.evaluate(()=>window.__accountProbe.runtime.getLocal('task-draft'));assert.ok(savedPublication);const initialPublishCount=report.apiCalls.filter(row=>row.actor==='native-default'&&row.path==='/v2/tasks'&&row.method==='POST').length;
  await button(nativeWeb,'前往账号验证').click();await button(nativeWeb,'使用 Isolated OIDC 验证').waitFor();await preview(nativeWeb);await button(nativeWeb,'确认关联这个账号').click();await nativeWeb.getByText('账号关联已记录 · 关联状态与公开操作资格分别核对。',{exact:true}).waitFor();assert.deepEqual((await publicStatus(nativeWeb)).connection.scopes,nativeScopes);await screenshot(nativeWeb,'10-native-six-scopes-account-linked');await button(nativeWeb,'回到原目标').click();await nativeWeb.waitForURL(website+'/app/publish');
  assert.deepEqual(await nativeWeb.evaluate(()=>window.__accountProbe.runtime.getLocal('task-publication')),savedPublication);assert.deepEqual(await nativeWeb.evaluate(()=>window.__accountProbe.runtime.getLocal('task-draft')),savedDraft);assert.equal(report.apiCalls.filter(row=>row.actor==='native-default'&&row.path==='/v2/tasks'&&row.method==='POST').length,initialPublishCount);
  await button(nativeWeb,'查询原发布').click();await nativeWeb.getByText('尚未确认原发布结果，可重试同一项操作。',{exact:true}).waitFor();await button(nativeWeb,'重试原发布').click();await nativeWeb.getByRole('heading',{name:'Synthetic Native account continuation',exact:true}).waitFor();await nativeWeb.waitForURL(url=>/^\/app\/tasks\/[^/]+$/.test(url.pathname));assert.equal((await publicStatus(nativeWeb)).identity.subjectId,nativeSubject);assert.equal((await fixture.db.query('SELECT count(*)::int n FROM task_requests WHERE requester_id=$1',[nativeSubject])).rows[0].n,1);await screenshot(nativeWeb,'11-native-original-publication-resumed');
  report.checks.push({id:'compiled-native-default-six-scopes-current-main-account-then-exact-original-publication',passed:true,subjectId:nativeSubject,scopes:nativeScopes,publicationDraftHash:sha(JSON.stringify(savedDraft)),pendingOperationHash:sha(JSON.stringify(savedPublication)),automaticRepublishOnReturn:false,actualTaskCount:1});
  report.stage='a-to-b-during-confirm-response';
  const B=await makePage('recovery-B');await createOrdinary(B,'/app/');const prepared=await B.page.evaluate(async()=>{const runtime=window.__accountProbe.runtime,value=await runtime.prepareRecovery();await runtime.saveRecovery({operationId:value.operationId,confirmed:true});return{code:value.code,subjectId:value.subjectId};});
  const X=await makePage('switch-A');await createOrdinary(X,target);await accountEntry(X.page,{fromOriginal:true});const pendingA=await preview(X.page);hold={actor:'switch-A',path:'/v1/identity/confirm',seen:deferred(),release:deferred()};await button(X.page,'确认关联这个账号').click();await hold.seen.promise;
  await X.page.evaluate(()=>{window.__accountProbe.commits=[];});await X.page.evaluate(async code=>{const runtime=window.__accountProbe.runtime;await runtime.recover(code,{confirmed:true});await runtime.connect({confirmed:true});document.dispatchEvent(new Event('visibilitychange'));},prepared.code);prepared.code=null;
  await X.page.waitForFunction(subject=>window.__accountProbe.rendered?.subjectId===subject,prepared.subjectId);const firstB=await X.page.evaluate(subject=>window.__accountProbe.commits.find(row=>row.subjectId===subject),prepared.subjectId);assert.equal(firstB.oldAccountVisible,false);assert.equal(firstB.confirmVisible,false);hold.release.resolve();hold=null;
  await X.page.waitForFunction(async()=>{const values=await window.__accountProbe.runtime.accounts.query({});return values.items.length===0;});await X.page.getByText('尚无可见的关联记录。外部登录结束后，仍需由当前银河身份确认才会形成关联。',{exact:true}).waitFor();assert.equal(await X.page.locator('.account-settings [role="alert"]').count(),0);assert.equal(await X.page.getByText('账号关联已记录。是否满足当前参与要求，仍以实际资格检查为准。',{exact:true}).count(),0);assert.equal((await fixture.db.query('SELECT count(*)::int n FROM external_identity_links WHERE id=$1 AND subject_id=$2',[pendingA.loginId,pendingA.subjectId])).rows[0].n,1);
  const oldJournal=await X.page.evaluate(subject=>window.__accountProbe.runtime.getLocal('account-verification-operations',subject),pendingA.subjectId);assert.equal(oldJournal.operations[pendingA.loginId].state,'awaiting-result');assert.ok(oldJournal.operations[pendingA.loginId].signed);await screenshot(X.page,'12-first-b-and-late-a-confirm-clean');report.checks.push({id:'a-to-b-first-commit-and-delayed-confirm-ack-cannot-publish-old-preview-or-error-or-write-new-owner-journal',passed:true,firstB,oldRequestMayCompleteUnderA:true,oldJournalPreserved:true,newSubjectHasNoAssociation:true});
  report.stage='complete';assert.deepEqual(report.pageErrors,[]);assert.deepEqual(issuer.failures,[]);assert.deepEqual(unverifiedIssuer.failures,[]);
}catch(error){failure=error;report.failure={message:error.message,stack:error.stack};if(lastPage&&!lastPage.isClosed())await lastPage.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
  hold?.release.resolve();for(const context of contexts)await context.unrouteAll({behavior:'ignoreErrors'});await browser?.close();
  await nativeClient?.close();await nativeServer?.close();native?.close();if(api){api.closeAllConnections?.();await new Promise(r=>api.close(r));}await fixture?.db.close();await issuer?.close();await unverifiedIssuer?.close();
  for(const url of opened){let listening=true;try{await fetch(url);}catch{listening=false;}assert.equal(listening,false);}
  if(nativeDirectory){const target=resolve(nativeDirectory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-account-native-'));await rm(target,{recursive:true,force:true});}
  report.sourceAfter=await hashFiles();report.sourceChanged=files.filter(path=>report.sourceBefore[path]!==report.sourceAfter[path]);report.endedAt=new Date().toISOString();report.allTemporaryListenersClosed=true;report.observationCompleted=!failure&&report.sourceChanged.length===0;
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
}
process.stdout.write(JSON.stringify({observationCompleted:report.observationCompleted,stage:report.stage,checks:report.checks.length,redCases:report.checks.filter(x=>x.observedFailure).length,pageErrors:report.pageErrors.length,sourceChanged:report.sourceChanged,allTemporaryListenersClosed:report.allTemporaryListenersClosed,failure:report.failure?.message})+'\n');
if(failure)throw failure;assert.equal(report.observationCompleted,true);
