import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
const root=process.cwd(),from=path=>import(pathToFileURL(resolve(root,path)));
const {build}=await from('node_modules/esbuild/lib/main.js'),{serviceFixture}=await from('packages/galaxy-official/test/service-fixture.mjs'),{oidcProviderFixture}=await from('packages/galaxy-official/test/oidc-provider-fixture.mjs'),{createOidcLoginProvider}=await from('packages/galaxy-official/src/oidc-login.mjs'),{createApi}=await from('packages/galaxy-official/src/http.mjs'),{browserScopes}=await from('packages/galaxy-official/src/browser-client.mjs');
const out=resolve(root,process.env.GALAXY_UI_REPORT_DIR??'../../../07-logs/development/goal-20261002-ui/contact-room-reception/current');await mkdir(out,{recursive:true});
const now=Math.floor(Date.now()/1000),endpoint='https://official.example.org',issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic project-contact investigation',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
const f=await serviceFixture(browserScopes,null,{now,identityProviders:[provider],syntheticCommunityQuota:false}),calls=[],observations=[],pageErrors=[],contexts=[],secretValues=[];
const bodies=new Map();f.chat.transport={available:true,project:async()=>{},send:async x=>{bodies.set(x.messageId,x.text);return{archiveId:x.messageId};},read:async({ids})=>ids.filter(id=>bodies.has(id)).map(id=>({archiveId:id,text:bodies.get(id)})),delete:async id=>{bodies.delete(id);}};
let api,frontend,browser,page,failure,dropContactAck=false,dropResponseKind=null,heldContactQuery=null,failContactQuery=false,revokeBeforeContactPost,denyContactReadId;
const report={actualFullMain:true,actualBrowser:true,actualWebCryptoIndexedDB:true,actualSignedHttpPGlite:true,syntheticOidc:true,syntheticChatBodyTransport:true,physicalHostHumanAcceptance:false,observations,pageErrors};
report.sourceHashesBefore={};for(const file of ["main.tsx","features/discovery/workspace.tsx","features/projects/detail.tsx","features/projects/contacts/opportunity.tsx","features/projects/management/workspace.tsx","features/projects/management/people-selection.tsx","features/projects/clients/views.mjs","features/projects/clients/operations.mjs","features/projects/contacts/origin.tsx","chat-workspace.tsx","chat-client.mjs","runtime.mjs"])report.sourceHashesBefore[file]=createHash('sha256').update(await readFile(resolve(root,'packages/galaxy-web/src',file))).digest('hex');
const button=(p,name)=>p.getByRole('button',{name,exact:true}),idle=p=>p.waitForFunction(()=>!document.querySelector('.operation-progress'));
try{
 api=createApi({...f,browserOrigins:['https://galaxy-ui.example.org'],rateLimit:10000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const apiOrigin='http://127.0.0.1:'+api.address().port;
 const bundle=await build({stdin:{contents:`import './packages/galaxy-web/src/main.tsx';import {getProjectContactClient} from './packages/galaxy-web/src/features/projects/clients/operations.mjs';window.fixtureProjectClient=getProjectContactClient;import {createWebRuntime,loadWebConfiguration} from './packages/galaxy-web/src/runtime.mjs';window.fixtureRuntime=async(connected=false)=>{const rt=await createWebRuntime(await loadWebConfiguration());if(connected)await rt.connect({confirmed:true});return rt;};`,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root},loader:{'.css':'empty'},plugins:[{name:'observe-main-runtime',setup(builder){builder.onLoad({filter:/galaxy-web[\\/]src[\\/]main\.tsx$/},async args=>{const source=await readFile(args.path,'utf8'),needle='setRuntime(value);setStatus(next);';assert.equal(source.split(needle).length,2);return{contents:source.replace(needle,'(globalThis as any).fixtureMainRuntime=value;'+needle),loader:'tsx',resolveDir:resolve(args.path,'..')};});}}]});
 const cssNames=[...(await readFile(resolve(root,'packages/galaxy-web/dist/index.html'),'utf8')).matchAll(/href="\/app\/assets\/([A-Za-z0-9_.-]+\.css)"/g)].map(x=>x[1]);assert.ok(cssNames.length);report.builtStyleFiles=cssNames;
 const css=(await Promise.all(cssNames.map(x=>readFile(resolve(root,'packages/galaxy-web/dist/assets',x),'utf8')))).join('\n')+await readFile(resolve(root,'packages/galaxy-web/src/workspace.css'),'utf8');
 frontend=createServer(async(req,res)=>{try{if(req.url==='/galaxy-web-config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,endpoint,signingKeys:[...f.bindings.trustedKeys].map(([kid,pin])=>({kid,...pin}))}));}else if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}else if(req.url==='/fixture-login'&&req.method==='POST'){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw);assert.ok(['A','B','C'].includes(input.actor));assert.equal(new URL(input.authorizationUrl).origin,issuer.issuer);issuer.setAccount('synthetic-project-contact-'+input.actor);const callback=await issuer.authorize(input.authorizationUrl),response=await fetch(apiOrigin+callback.pathname+callback.search);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:(await response.json()).state}));}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');}}catch{res.writeHead(500);res.end('fixture_error');}});
 await new Promise(ok=>frontend.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+frontend.address().port;
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 async function actor(name){const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce',timezoneId:'UTC'});contexts.push(context);context.setDefaultTimeout(18000);await context.addInitScript(now=>{Date.now=()=>now*1000;},now);
  await context.route(endpoint+'/**',async route=>{const req=route.request(),url=new URL(req.url()),input=req.postData()?JSON.parse(req.postData()):null,entry={actor:name,path:url.pathname,method:req.method()};
   if(input?.payloadJson&&['/v2/projects','/v2/contacts'].includes(url.pathname)){const event=JSON.parse(input.payloadJson);Object.assign(entry,{operationId:event.operationId,objectId:event.projectId??event.contactId,kind:event.kind,consentId:input.consentId});}
   calls.push(entry);if(failContactQuery&&url.pathname==='/v2/contacts/query'){failContactQuery=false;entry.status=503;entry.syntheticReadFailure=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic_contact_read_unavailable'})});return;}
   if(denyContactReadId&&url.pathname==='/v2/contacts/'+denyContactReadId&&req.method()==='GET'){denyContactReadId=null;entry.status=403;entry.syntheticCurrentReadDenied=true;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'synthetic_current_contact_denied'})});return;}
   if(revokeBeforeContactPost&&name==='A'&&url.pathname==='/v2/contacts'&&entry.kind==='send'){const revoke=revokeBeforeContactPost;revokeBeforeContactPost=null;await revoke();entry.sourceWithdrewBeforeContactPost=true;}
   const response=await context.request.fetch(apiOrigin+url.pathname+url.search,{method:req.method(),headers:{...req.headers(),origin:'https://galaxy-ui.example.org'},data:req.postDataBuffer()??undefined});entry.status=response.status();
   if(((dropContactAck&&name==='A'&&entry.kind==='send')||(dropResponseKind&&name==='B'&&entry.kind===dropResponseKind))&&url.pathname==='/v2/contacts'&&response.ok()){dropContactAck=false;dropResponseKind=null;entry.actualCommitAckDropped=true;await route.abort('failed');return;}
   if(heldContactQuery&&name==='B'&&url.pathname==='/v2/contacts/query'){const hold=heldContactQuery;heldContactQuery=null;hold.started(entry);await hold.promise;}
   await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':origin}});
  });
  const p=await context.newPage();page=p;p.on('pageerror',e=>pageErrors.push({actor:name,message:e.message}));await p.goto(origin+'/app/settings/identity');await button(p,'创建我的银河身份').click();await p.getByRole('heading',{name:'当前银河身份',exact:true}).waitFor();const id=await p.locator('.identity-id').textContent();await button(p,'准备或更换恢复码').click();const codeField=p.getByRole('textbox',{name:'新的恢复码',exact:true});await codeField.waitFor();const recoveryCode=await codeField.inputValue();secretValues.push(recoveryCode);await button(p,'我已保存').click();await codeField.waitFor({state:'detached'});await idle(p);await button(p,'连接并返回').click();await idle(p);
  await p.evaluate(async actor=>{const rt=await window.fixtureRuntime(true);try{const login=await rt.api.call('/v1/identity/begin',{providerId:'fixture'}),response=await(await fetch('/fixture-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actor,authorizationUrl:login.authorizationUrl})})).json();if(response.state!=='awaiting-local-signature')throw Error('OIDC fixture failed');await rt.confirmAccountLink(login.loginId,{confirmed:true});}finally{rt.close();}},name);return{name,id,page:p,context,recoveryCode};
 }
 const navigate=(p,path)=>p.evaluate(path=>{history.pushState({},'',path);dispatchEvent(new PopStateEvent('popstate'));},path);
 async function openIdentity(p){if(await button(p,'打开菜单').isVisible()){await button(p,'打开菜单').click();await p.locator('.mobile-personal a[href="/app/settings/identity"]').click();}else{await p.locator('.personal-menu>summary').click();await p.locator('.personal-menu a[href="/app/settings/identity"]').click();}await p.getByRole('heading',{name:'身份与设置',exact:true}).waitFor();}
 async function screenshot(p,name,width=390){await p.setViewportSize({width,height:width===390?844:1100});await p.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo(0,0);});const horizontalOverflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(horizontalOverflow,false);await p.screenshot({path:resolve(out,name+'.png'),fullPage:true,mask:[p.locator('textarea.recovery-code,#recover-existing textarea')]});return{horizontalOverflow};}
 async function seedProject(p,title,summary,functions){return p.evaluate(async({title,summary,functions})=>{const rt=await window.fixtureRuntime(true);try{const owner=(await rt.status()).identity.subjectId,result=await window.fixtureProjectClient(rt,owner).submit('project',{kind:'create',projectId:crypto.randomUUID(),expectedRevision:0,document:{kind:'module',title,summary,functions,technologies:['Rust'],discoverable:true,participantKind:'human'}},{confirmed:true,visibility:'Public'});const prefs=await rt.api.call('/v1/discovery/preferences/read',{});await rt.api.call('/v1/discovery/preferences/save',{expectedRevision:prefs.revision,preferences:{enabled:true}});return result;}finally{rt.close();}},{title,summary,functions});}
 const counts=async()=>{const row=(await f.db.query('SELECT (SELECT count(*)::int FROM projects_v2) projects,(SELECT count(*)::int FROM contacts_v2) contacts,(SELECT count(*)::int FROM contact_events_v2) contact_events,(SELECT count(*)::int FROM chat_rooms) rooms,(SELECT count(*)::int FROM task_requests) tasks,(SELECT count(*)::int FROM cases) cases,(SELECT count(*)::int FROM task_participations) participations')).rows[0];return row;};
 const A=await actor('A'),B=await actor('B');page=A.page;
 const projectTitle='合成：普通交流来源项目',projectMarker='SYNTHETIC_SOURCE_PROJECT_CURRENT';
 const project=await seedProject(B.page,projectTitle,projectMarker,['contact-room-probe']);
 const projectGrant=calls.find(x=>x.kind==='create'&&x.objectId===project.projectId&&x.path==='/v2/projects');
 const originRegion=p=>p.getByRole('region',{name:'原联系与项目',exact:true});
 const noBusinessWrite=rows=>!rows.some(x=>x.path==='/v1/consents'||x.path==='/v2/contacts'||x.path==='/v2/projects'||x.path==='/v2/chat/rooms/create'||x.path.endsWith('/send'));
 async function sendContact(note,title){
  await navigate(A.page,'/app/match?source=contact-room#original-project');
  await A.page.getByLabel('当前目标',{exact:true}).fill('合成：找人交流');
  await A.page.getByLabel('希望相关的功能或方向',{exact:true}).fill('contact-room-probe');
  await A.page.getByLabel('共同协作',{exact:true}).uncheck();await button(A.page,'查找当前可见的机会').click();
  await button(A.page,'查看真实依据与参与条件').click();await button(A.page,'准备向此对象联系').click();
  await A.page.getByLabel('准备发送的说明',{exact:true}).fill(note);await A.page.getByLabel('双方接受后的房间名称',{exact:true}).fill(title);
  await button(A.page,'发送这项联系').click();await A.page.getByText('已发送，等待回应',{exact:true}).waitFor();
  await button(A.page,'打开原项目').waitFor();
  return calls.filter(x=>x.actor==='A'&&x.path==='/v2/contacts'&&x.kind==='send').at(-1);
 }
 async function reconnect(p){await openIdentity(p);await button(p,'断开本次连接').click();await idle(p);await button(p,'连接并返回').click();await idle(p);}
 report.stage='accept-denied';
 const firstMarker='SYNTHETIC_CONTACT_NOTE_REVOKED',first=await sendContact(firstMarker,'合成：不会建立的房间');
 page=B.page;await navigate(B.page,'/app/projects?section=contacts');await button(B.page,'我接受普通交流').waitFor();
 await B.page.getByText('发起联系：'+firstMarker,{exact:true}).waitFor();await button(B.page,'打开原项目').waitFor();
 await B.page.getByRole('textbox',{name:'本次回应（可选）',exact:true}).fill('SYNTHETIC_B_UNSENT_RESPONSE');
 const firstCounts=await counts();await A.page.evaluate(id=>window.fixtureMainRuntime.api.call('/v1/consents/'+id+'/revoke',{}),first.consentId);
 let releaseQuery,queryStarted;const queryReady=new Promise(ok=>{queryStarted=ok;});
 heldContactQuery={started:queryStarted,promise:new Promise(ok=>{releaseQuery=ok;})};
 const beforeDenied=calls.length;await button(B.page,'我接受普通交流').click();await queryReady;
 assert.ok(!(await B.page.locator('body').innerText()).includes(firstMarker));
 assert.ok(await button(B.page,'我接受普通交流').isDisabled());
 assert.equal(await B.page.getByRole('textbox',{name:'本次回应（可选）',exact:true}).inputValue(),'SYNTHETIC_B_UNSENT_RESPONSE');
 await screenshot(B.page,'denied-accept-immediately-cleared-while-refresh-held');releaseQuery();
 await B.page.getByRole('alert').waitFor();await B.page.getByText('发起联系：原文当前不可读取',{exact:true}).waitFor();
 const deniedCalls=calls.slice(beforeDenied);assert.equal(deniedCalls.find(x=>x.path==='/v2/contacts'&&x.kind==='accept')?.status,403);
 assert.deepEqual(await counts(),firstCounts);assert.ok(await button(B.page,'我接受普通交流').isDisabled());
 observations.push({id:'accept-after-source-note-revoked',observed:{actualSendConsentRevoked:true,actualAcceptPost403:true,noContactStateOrRoomChange:true,oldNoteClearedBeforeRefreshReturned:true,acceptDisabled:true,ownResponseDraftRetained:true},discrepancy:false});

 report.stage='decline-lost-ack';
 dropResponseKind='decline';await button(B.page,'拒绝这次联系').click();await B.page.getByRole('heading',{name:'原操作结果待确认',exact:true}).waitFor();
 const declined=calls.find(x=>x.actualCommitAckDropped&&x.kind==='decline');assert.equal(declined?.status,200);
 await reconnect(B.page);await B.page.getByRole('heading',{name:'原操作结果待确认',exact:true}).waitFor();
 const beforeDeclineReplay={counts:await counts(),consents:calls.filter(x=>x.path==='/v1/consents').length};
 await button(B.page,'重试原操作').click();await B.page.getByRole('status').filter({hasText:'原操作已取得匹配回执'}).waitFor();
 assert.deepEqual(await counts(),beforeDeclineReplay.counts);assert.equal(calls.filter(x=>x.path==='/v1/consents').length,beforeDeclineReplay.consents);assert.equal((await counts()).rooms,0);
 observations.push({id:'decline-with-revoked-note-lost-ack-rebind',observed:{originalOperationId:declined.operationId,acceptedOriginalDecline:true,oneDeclineEvent:true,noRoom:true,noDuplicateOrNewConsent:true},discrepancy:false});

 report.stage='accept-lost-ack';
 page=A.page;const second=await sendContact('SYNTHETIC_CONTACT_NOTE_ACCEPTED','合成：原项目的普通房间');
 page=B.page;await button(B.page,'刷新联系与回应').click();await button(B.page,'我接受普通交流').waitFor();dropResponseKind='accept';
 await button(B.page,'我接受普通交流').click();await B.page.getByRole('heading',{name:'原操作结果待确认',exact:true}).waitFor();
 const accepted=calls.find(x=>x.actualCommitAckDropped&&x.kind==='accept');assert.equal(accepted?.status,200);assert.equal((await counts()).rooms,1);
 await A.page.evaluate(id=>window.fixtureMainRuntime.api.call('/v1/consents/'+id+'/revoke',{}),second.consentId);await reconnect(B.page);
 await B.page.getByRole('heading',{name:'原操作结果待确认',exact:true}).waitFor();
 const beforeAcceptReplay={counts:await counts(),consents:calls.filter(x=>x.path==='/v1/consents').length};
 const beforeCurrentQuery=calls.length;await button(B.page,'查询当前对象').click();await B.page.getByRole('status').filter({hasText:'当前对象可读取；原操作是否接收仍需精确回执'}).waitFor();
 assert.equal(await B.page.getByRole('heading',{name:'原操作结果待确认',exact:true}).count(),1);assert.ok(noBusinessWrite(calls.slice(beforeCurrentQuery)));assert.deepEqual(await counts(),beforeAcceptReplay.counts);
 observations.push({id:'lost-accept-ack-current-read-not-exact-receipt',observed:{actualCurrentContactGet200:true,originalOperationStillPending:true,noAutomaticRetryOrConsent:true},discrepancy:false});
 await button(B.page,'重试原操作').click();await B.page.getByRole('status').filter({hasText:'原操作已取得匹配回执'}).waitFor();
 assert.deepEqual(await counts(),beforeAcceptReplay.counts);assert.equal(calls.filter(x=>x.path==='/v1/consents').length,beforeAcceptReplay.consents);
 await button(B.page,'刷新联系与回应').click();await button(B.page,'打开双方确认后的普通房间').click();
 await B.page.getByRole('heading',{name:'合成：原项目的普通房间',exact:true}).waitFor();
 const roomId=second.objectId,room=await B.page.evaluate(id=>window.fixtureMainRuntime.api.call('/v2/chat/rooms/'+id+'/read',{}),roomId);
 assert.equal(room.mode,'ownerless');assert.equal(room.independentMemberCount,2);assert.deepEqual(room.taskRefs,[]);
 observations.push({id:'accept-lost-ack-rebind-revoked-note-original-room',observed:{originalContactId:roomId,originalAcceptOperationId:accepted.operationId,oneRoom:true,twoIndependentMembers:true,noTaskRefs:true,noDuplicateOrNewConsent:true},discrepancy:false});

 report.stage='readonly-source-return';
 await originRegion(B.page).waitFor();const beforeReturn={counts:await counts(),calls:calls.length};
 await originRegion(B.page).getByRole('button',{name:'返回原联系',exact:true}).click();
 await B.page.waitForURL(origin+'/app/projects?section=contacts&contactId='+roomId+'&fromRoom='+roomId);
 await B.page.locator('[data-contact-id="'+roomId+'"]').waitFor();assert.equal(await B.page.locator('[data-contact-id]').count(),1);
 await button(B.page,'打开双方确认后的普通房间').click();await originRegion(B.page).getByRole('button',{name:'打开原项目',exact:true}).click();
 await B.page.getByRole('heading',{name:projectTitle,exact:true}).waitFor();await originRegion(B.page).getByRole('button',{name:'返回原聊天',exact:true}).click();
 await B.page.waitForURL(origin+'/app/rooms/'+roomId);await B.page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
 assert.deepEqual(await counts(),beforeReturn.counts);assert.ok(noBusinessWrite(calls.slice(beforeReturn.calls)));
 observations.push({id:'room-contact-project-room-readonly-return',observed:{exactContactFocus:true,actualCurrentContactRelationVerified:true,sameProjectAndRoomId:true,noBusinessWriteOrNewConsent:true},discrepancy:false});
 await screenshot(B.page,'room-proven-original-contact-project');

 report.stage='ordinary-chat';
 const message='合成普通聊天：只交流现有方法。';await B.page.getByRole('textbox',{name:'消息',exact:true}).fill(message);await button(B.page,'发送').click();
 await B.page.locator('.chat-message').filter({hasText:message}).waitFor();page=A.page;await navigate(A.page,'/app/projects?section=contacts');
 await button(A.page,'打开双方确认后的普通房间').click();await A.page.locator('.chat-message').filter({hasText:message}).waitFor();
 await originRegion(A.page).getByRole('button',{name:'打开原项目',exact:true}).waitFor();
 const draft='SYNTHETIC_A_PRIVATE_UNSENT_DRAFT';await A.page.getByRole('textbox',{name:'消息',exact:true}).fill(draft);
 await A.page.waitForFunction(async({roomId,draft})=>(await window.fixtureMainRuntime.getLocal('chat-draft:'+roomId))===draft,{roomId,draft});
 observations.push({id:'ordinary-chat-shared-history-no-task',observed:{recipientActualMessageVisibleToOtherCurrentMember:true,noTaskReferences:true},discrepancy:false});

 report.stage='source-project-withdrawn-return';
 await B.page.evaluate(id=>window.fixtureMainRuntime.api.call('/v1/consents/'+id+'/revoke',{}),projectGrant.consentId);
 const beforeWithdrawnReturn={counts:await counts(),calls:calls.length};await originRegion(A.page).getByRole('button',{name:'打开原项目',exact:true}).click();
 await A.page.getByRole('alert').filter({hasText:'当前链接下没有可读取的项目资料'}).waitFor();
 assert.ok(!(await A.page.locator('body').innerText()).includes(projectMarker));
 await originRegion(A.page).getByRole('button',{name:'返回原聊天',exact:true}).click();await A.page.waitForURL(origin+'/app/rooms/'+roomId);
 await A.page.getByRole('textbox',{name:'消息',exact:true}).waitFor();assert.equal(await A.page.getByRole('textbox',{name:'消息',exact:true}).inputValue(),draft);
 assert.deepEqual(await counts(),beforeWithdrawnReturn.counts);assert.ok(noBusinessWrite(calls.slice(beforeWithdrawnReturn.calls)));
 observations.push({id:'withdrawn-project-locator-does-not-authorize-body',observed:{historicalProjectLocatorRetained:true,actualCurrentProjectRead403or404:true,noOldProjectBody:true,returnOriginalChatAndOwnDraft:true,noBusinessWrite:true},discrepancy:false});
 await screenshot(A.page,'withdrawn-source-original-room-draft');
 await navigate(A.page,'/app/projects/'+project.projectId+'?fromContact='+first.objectId+'&fromRoom='+roomId);await A.page.getByText('当前身份未能核对原联系与房间来源。页面链接本身不授予资料或房间权限。',{exact:true}).waitFor();assert.equal(await originRegion(A.page).count(),0);
 await navigate(A.page,'/app/rooms/'+roomId);await A.page.getByRole('textbox',{name:'消息',exact:true}).waitFor();observations.push({id:'mismatched-current-contact-room-rejected',observed:{bothContactsBelongToActor:true,actualDeclinedContactDoesNotMatchAcceptedRoom:true,noForgedReturnRelationship:true},discrepancy:false});

 report.stage='identity-recovery';
 // Closing B's old browser avoids unrelated background polling after its
 // device is explicitly revoked by actual recovery on A's browser.
 await B.page.close();const roomTarget='/app/rooms/'+roomId;
 async function recoverAndReturn(code,expectedId){
  await openIdentity(A.page);await A.page.locator('#recover-existing').evaluate(el=>el.open=true);await A.page.locator('#recover-existing textarea').fill(code);
  await button(A.page,'确认恢复同一身份').click();await idle(A.page);assert.equal(await A.page.locator('.identity-id').textContent(),expectedId);
  const replacement=A.page.getByRole('textbox',{name:'新的恢复码',exact:true});await replacement.waitFor();secretValues.push(await replacement.inputValue());
  await button(A.page,'我已保存').click();await replacement.waitFor({state:'detached'});await idle(A.page);await button(A.page,'连接并返回').click();
  await A.page.waitForURL(origin+roomTarget);await A.page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
 }
 const beforeRecovery=await counts();await recoverAndReturn(B.recoveryCode,B.id);
 assert.equal(await A.page.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'');
 await originRegion(A.page).getByText('原项目来源当前不可核对；本机没有这个身份先前保存的项目定位。',{exact:true}).waitFor();
 assert.equal(await originRegion(A.page).getByRole('button',{name:'打开原项目',exact:true}).count(),0);
 assert.ok(!(await A.page.locator('body').innerText()).includes(draft));
 await recoverAndReturn(A.recoveryCode,A.id);assert.equal(await A.page.getByRole('textbox',{name:'消息',exact:true}).inputValue(),draft);
 await originRegion(A.page).getByRole('button',{name:'打开原项目',exact:true}).waitFor();assert.deepEqual(await counts(),beforeRecovery);
 observations.push({id:'same-room-real-A-B-A-isolation',observed:{realRecoveryAndSameRoomUrl:true,otherIdentityNoUnsentDraftOrSourceLocator:true,originalIdentityDraftAndLocatorRestored:true,roomReadableAfterIdentityChangeWithoutReload:true,noBusinessWriteOrMembershipChange:true},discrepancy:false});
 await screenshot(A.page,'recovered-original-room-draft-and-source',1440);

 report.stage='forged-origin-and-outsider';
 const C=await actor('C');page=C.page;const forged='/app/projects/'+project.projectId+'?fromContact='+roomId+'&fromRoom='+roomId;
 await navigate(C.page,forged);await C.page.getByText('当前身份未能核对原联系与房间来源。页面链接本身不授予资料或房间权限。',{exact:true}).waitFor();
 assert.equal(await originRegion(C.page).count(),0);assert.ok(!(await C.page.locator('body').innerText()).includes(projectMarker));
 await navigate(C.page,'/app/rooms/'+roomId);await C.page.getByRole('alert').waitFor();assert.equal(await C.page.getByRole('textbox',{name:'消息',exact:true}).count(),0);assert.equal(await originRegion(C.page).count(),0);
 observations.push({id:'outsider-url-does-not-prove-source-or-membership',observed:{actualContactAndRoomAccessDenied:true,noSourceReturnOrRoomComposer:true,noSourceBody:true},discrepancy:false});await screenshot(C.page,'outsider-no-origin-or-room-access');
 await navigate(C.page,'/app/projects?section=contacts&contactId=invalid');await C.page.getByRole('alert').filter({hasText:'原联系链接中的编号无效'}).waitFor();assert.equal(await C.page.locator('[data-contact-id]').count(),0);observations.push({id:'invalid-contact-link-does-not-fall-back-to-list',observed:{explicitInvalidLocator:true,noUnrelatedContactShown:true},discrepancy:false});
 const finalCounts=await counts();assert.equal(finalCounts.tasks,0);assert.equal(finalCounts.cases,0);assert.equal(finalCounts.participations,0);assert.equal(finalCounts.rooms,1);assert.equal(finalCounts.contacts,2);assert.equal(finalCounts.contact_events,4);report.finalCounts=finalCounts;assert.deepEqual(pageErrors,[]);report.stage='complete';

}catch(error){failure=error;let message=error.message;for(const secret of secretValues)message=message.replaceAll(secret,'[recovery-code-redacted]');report.failure={message,code:error.code??null};if(page){let visible=await page.locator('body').innerText();for(const secret of secretValues)visible=visible.replaceAll(secret,'[recovery-code-redacted]');await writeFile(resolve(out,'failure.txt'),visible);await page.screenshot({path:resolve(out,'failure.png'),fullPage:true,mask:[page.locator('textarea.recovery-code,#recover-existing textarea')]});}}
finally{report.calls=calls;report.recordedAt=new Date().toISOString();report.completed=!failure;report.discrepancies=observations.filter(x=>x.discrepancy).map(x=>x.id);report.sourceHashes={};for(const file of ['main.tsx','features/discovery/workspace.tsx','features/projects/detail.tsx','features/projects/contacts/opportunity.tsx','features/projects/management/workspace.tsx',"features/projects/management/people-selection.tsx",'features/projects/clients/views.mjs','features/projects/clients/operations.mjs','features/projects/contacts/origin.tsx','chat-workspace.tsx','chat-client.mjs','runtime.mjs'])report.sourceHashes[file]=createHash('sha256').update(await readFile(resolve(root,'packages/galaxy-web/src',file))).digest('hex');report.sourceChangedDuringRun=Object.keys(report.sourceHashes).filter(file=>report.sourceHashes[file]!==report.sourceHashesBefore[file]);if(report.sourceChangedDuringRun.length){report.completed=false;report.failure={message:'Source changed during browser run: '+report.sourceChangedDuringRun.join(', ')};failure=new Error(report.failure.message);}
await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,calls:undefined}));for(const context of contexts)await context.unrouteAll({behavior:'ignoreErrors'});await browser?.close();if(frontend){frontend.closeAllConnections();await new Promise(ok=>frontend.close(ok));}if(api){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f.db.close();await issuer.close();}
if(failure)throw new Error(report.failure.message);
