import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {compactVerify,importSPKI} from 'jose';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {chromium} from 'playwright';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes,createBrowserClient} from '../../galaxy-official/src/browser-client.mjs';
import {createIdentityDeviceHandoff} from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import {identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {createNativeRuntime} from '../src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../src/native-v2/server.mjs';
import {webIdentityProofType,webIdentityProtocol} from '../src/native-v2/identity/web-handoff.mjs';
import {webIdentityDefaultScopes} from '../../../integrations/native-v2/identity-web-connect-tools.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=resolve(root,process.env.GALAXY_IDENTITY_BRIDGE_UI_REPORT_DIR??'outputs/identity-handoff-bridge/tmp');
const sourcePaths=['packages/galaxy-edge-mcp/src/native-v2/identity/web-handoff.mjs','packages/galaxy-edge-mcp/src/native-v2/runtime.mjs',
 'packages/galaxy-edge-mcp/src/native-v2/interaction/navigation.mjs','packages/galaxy-edge-mcp/src/native-v2/server.mjs',
 'integrations/native-v2/identity-web-connect-tools.mjs','packages/galaxy-edge-mcp/test/verify-web-identity-handoff-bridge-ui.mjs'];
const hashes=()=>Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])).then(Object.fromEntries);
await mkdir(out,{recursive:true});const beforeHashes=await hashes(),directory=await mkdtemp(join(tmpdir(),'galaxy-native-web-popup-'));
const report={startedAt:new Date().toISOString(),pid:process.pid,sourceHashes:beforeHashes,assertions:[],pageErrors:[],urls:[],
 boundary:{nativeRuntime:true,actualNativeGenesis:true,actualSignedHttp:true,actualPGlite:true,actualChromiumPopup:true,
  officialMainConsumer:false,websiteCounterpart:'explicit synthetic public packet peer with matching CSP and no COOP; second case deliberately sets COOP same-origin',
  publicProductionOriginLoaded:false,physicalHostAcceptance:false,modelCalls:0}};
let fixture,api,runtime,server,client,browser,context,webClient,failure,observedNativePage,observedPopup,observedInfo;
const closedUrls=[];
try{
 fixture=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
 api=createApi({...fixture,rateLimit:1000});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const apiOrigin='http://127.0.0.1:'+api.address().port;
 const fetcher=async(url,options)=>{assert.equal(new URL(url).origin,fixture.access.endpoint);return fetch(apiOrigin+new URL(url).pathname,options);};
 runtime=await createNativeRuntime({dataDirectory:directory,endpoint:fixture.access.endpoint,website:'https://selected.example',
  trustedKeys:fixture.access.trustedKeys,fetch:fetcher,now:()=>fixture.now,openBrowser:async url=>{closedUrls.push(url);return{state:'captured-test-browser-navigation',launched:false};}});
 await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
 const subjectId=(await runtime.status()).identity,task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',
  title:'Synthetic browser bridge original Task',summary:'SYNTHETIC_PRIVATE_TASK_BODY',workContext:{goal:'Keep same original work',currentSituation:'Isolated UI transport',attemptRefs:[]},
  visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:fixture.now+3600};
 const authorization=await runtime.authorize({requestId:randomUUID(),payloadJson:JSON.stringify(task),action:'assistance.publish',
  objectId:task.operationId,visibility:'Private',viewers:[],expiresAt:fixture.now+3600},{confirmed:true});
 await runtime.api.call('/v2/tasks',{consentId:authorization.consentId,payloadJson:authorization.payloadJson});
 server=createNativeToolServer(runtime);client=new Client({name:'synthetic-native-popup-probe',version:'1'},{capabilities:{}});
 const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 async function call(name,input){const result=await client.callTool({name,arguments:input}),value=JSON.parse(result.content[0].text);assert.equal(result.isError??false,false,JSON.stringify(value));return value;}
 async function prepare(){const request={requestId:randomUUID(),object:{kind:'task',id:task.taskId},origin:{host:'synthetic-original-native',workRef:'PRIVATE_LOCAL_WORK_REF'},scopes:[...webIdentityDefaultScopes]};
  const info=await call('galaxy_identity_web_connect',request);report.urls.push(info.url);return info;}
 const peer=String.raw`const params=new URLSearchParams(location.search);window.received=[];
window.packet=(kind,payload)=>({protocol:'galaxy-web-identity-handoff',version:1,handoffId:params.get('agentConnect'),navigationId:params.get('agentNavigation'),kind,payload});
window.send=(kind,payload,change={})=>{const message={...window.packet(kind,payload),...change};window.opener?.postMessage(message,params.get('agentBridgeOrigin'));};
window.addEventListener('message',event=>{if(event.origin===params.get('agentBridgeOrigin')&&event.source===window.opener){window.received.push(event.data);document.querySelector('pre').textContent=JSON.stringify(event.data);}});
document.querySelector('p').textContent='Synthetic public peer; production main and host model not exercised.';`;
 browser=await chromium.launch({headless:true});
 context=await browser.newContext({viewport:{width:1200,height:900},reducedMotion:'reduce'});
 let coop=false;
 await context.route(/^https:\/\/(?:selected|foreign)\.example\//,async route=>{
  const url=new URL(route.request().url()),headers={'content-type':url.pathname.endsWith('.js')?'text/javascript':'text/html; charset=utf-8',
   'content-security-policy':"default-src 'self'; script-src 'self'; connect-src 'self' https://official.example.org; frame-ancestors 'none'",
   'x-frame-options':'DENY','referrer-policy':'strict-origin-when-cross-origin'};
  if(coop)headers['cross-origin-opener-policy']='same-origin';
  await route.fulfill({status:200,headers,body:url.pathname==='/app/peer.js'?peer:'<!doctype html><meta charset="utf-8"><title>Synthetic website peer</title><p></p><pre></pre><script src="/app/peer.js"></script>'});
 });
 context.on('page',page=>page.on('pageerror',error=>report.pageErrors.push({url:page.url(),message:error.message})));
 const nativePage=await context.newPage(),first=await prepare();
 observedNativePage=nativePage;observedInfo=first;
 await nativePage.goto(first.url);await nativePage.locator('#open').waitFor();
 const popupPromise=nativePage.waitForEvent('popup');await nativePage.locator('#open').click();const popup=await popupPromise;
 observedPopup=popup;
 await popup.waitForLoadState('domcontentloaded');await popup.waitForFunction(()=>typeof window.send==='function');
 report.openerStages=[{stage:'initial',present:await popup.evaluate(()=>window.opener!==null)}];
 assert.equal(report.openerStages[0].present,true);
 const query=new URL(popup.url()).search,bridgeOrigin=new URL(first.url).origin;
 assert.equal(new URL(popup.url()).origin,'https://selected.example');assert.ok(!popup.url().includes('PRIVATE_LOCAL_WORK_REF'));
 const saved=()=>runtime.store.get('web-identity-handoff:'+first.handoffId);
 // A window from the exact website origin but with another WindowProxy must
 // not establish the challenge even when both public correlation IDs match.
 const foreignPromise=context.waitForEvent('page');
 await popup.evaluate(url=>{window.open(url,'synthetic-same-origin-other-window');},'https://selected.example/app/foreign'+query);
 const sameOriginForeign=await foreignPromise;await sameOriginForeign.waitForLoadState('domcontentloaded');
 await sameOriginForeign.waitForFunction(()=>typeof window.packet==='function');
 await sameOriginForeign.evaluate(({origin,nonce})=>{window.opener.opener.postMessage(window.packet('ready',{nonce,existingDevice:null}),origin);},{origin:bridgeOrigin,nonce:randomUUID()});
 await nativePage.waitForTimeout(250);assert.equal((await saved()).nonce,null);await sameOriginForeign.close();
 report.openerStages.push({stage:'after-other-window',present:await popup.evaluate(()=>window.opener!==null)});
 report.assertions.push({id:'exact-website-origin-other-window-refused',passed:true});
 const nonce=await popup.evaluate(()=>crypto.randomUUID());await popup.evaluate(nonce=>window.send('ready',{nonce,existingDevice:null}),nonce);
 await popup.waitForFunction(()=>window.received.some(item=>item.kind==='context'));
 const message=await popup.evaluate(()=>window.received.find(item=>item.kind==='context'));
 assert.equal(message.protocol,webIdentityProtocol);assert.equal(message.handoffId,first.handoffId);assert.equal(message.navigationId,first.navigationId);
 const control=await runtime.api.call('/v2/identity/'+subjectId+'/control',undefined,{method:'GET',authenticated:false});
 const signer=control.devices.find(item=>item.device_id===message.payload.controller.deviceId);
 const verified=await compactVerify(message.payload.proof.signature,await importSPKI(signer.public_key,'Ed25519'));
 assert.equal(verified.protectedHeader.typ,webIdentityProofType);assert.equal(new TextDecoder().decode(verified.payload),message.payload.proof.payloadJson);
 const proof=JSON.parse(message.payload.proof.payloadJson);assert.equal(proof.nonce,nonce);assert.equal(proof.bridgeOrigin,bridgeOrigin);
 assert.equal(proof.context.targetPath,'/app/tasks/'+task.taskId);assert.equal(proof.context.existingDevice,null);
 assert.equal((await fixture.db.query('SELECT count(*)::int n FROM device_authorizations WHERE subject_id=$1',[subjectId])).rows[0].n,1);
 report.assertions.push({id:'actual-popup-public-native-proof-no-automatic-grant',passed:true});
 const revision=(await saved()).revision;
 await popup.evaluate(({nonce,id})=>window.send('ready',{nonce,existingDevice:null},{handoffId:id}),{nonce:randomUUID(),id:randomUUID()});
 await nativePage.waitForTimeout(250);assert.equal((await saved()).revision,revision);
 report.assertions.push({id:'expected-window-wrong-correlation-refused',passed:true});
 // Cross-origin navigation can remove the popup's opener. Keep this transport
 // failure visible; a foreign window never becomes an authorized peer merely
 // by later navigating back to the selected origin.
 await popup.goto('https://foreign.example/app/foreign'+query);await popup.waitForFunction(()=>typeof window.send==='function');
 report.openerStages.push({stage:'foreign-navigation',present:await popup.evaluate(()=>window.opener!==null)});
 await popup.evaluate(nonce=>window.send('ready',{nonce,existingDevice:null}),randomUUID());
 await nativePage.waitForTimeout(250);assert.equal((await saved()).revision,revision);
 report.assertions.push({id:'expected-window-wrong-origin-refused',passed:true});
 await popup.goto('https://selected.example/app/settings/identity'+query);await popup.waitForFunction(()=>typeof window.send==='function');
 report.openerStages.push({stage:'returned-after-foreign-navigation',present:await popup.evaluate(()=>window.opener!==null)});
 await popup.close();await nativePage.waitForFunction(()=>document.querySelector('#progress').textContent.includes('本次传输已停止'));
 assert.equal((await saved()).state,'canceled');assert.equal((await saved()).operationId,null);
 // A new explicit local bridge resumes the same identity and original Task.
 // This first operation has no offer/commit to replace; no new GUID is made.
 const approvalInfo=await prepare();await nativePage.goto(approvalInfo.url);
 observedInfo=approvalInfo;
 const approvalPopupPromise=nativePage.waitForEvent('popup');await nativePage.locator('#open').click();const approvalPopup=await approvalPopupPromise;
 observedPopup=approvalPopup;
 await approvalPopup.waitForLoadState('domcontentloaded');await approvalPopup.waitForFunction(()=>typeof window.send==='function');
 assert.equal(await approvalPopup.evaluate(()=>window.opener!==null),true);
 await approvalPopup.evaluate(nonce=>window.send('ready',{nonce,existingDevice:null}),randomUUID());
 await approvalPopup.waitForFunction(()=>window.received.some(item=>item.kind==='context'));
 const records=new Map(),store={get:async key=>structuredClone(records.get(key)),put:async(key,value)=>{records.set(key,structuredClone(value));}};
 let active=null;
 webClient=createBrowserClient({endpoint:fixture.access.endpoint,trustedKeys:fixture.access.trustedKeys,fetch:fetcher,now:()=>fixture.now,
  sign:async(text,type)=>signIdentityPayload(text,(await store.get('device:'+active.subjectId+':'+active.deviceId)).privateKey,{type})});
 // The requesting key below is actual WebCrypto in this Node fixture, held
 // outside the peer page. It isolates transport/user approval from main UI.
 const handoff=createIdentityDeviceHandoff({endpoint:fixture.access.endpoint,send:webClient.send,store,getActive:()=>active,
  activate:async value=>active=value,allowedScopes:browserScopes,now:()=>fixture.now});
 const offer=await handoff.createOffer(subjectId,{scopes:[...webIdentityDefaultScopes],confirmed:true});
 await approvalPopup.evaluate(offer=>window.send('offer',offer),offer);
 await nativePage.locator('#offer').waitFor({state:'visible'});
 assert.equal(await nativePage.locator('#fingerprint').textContent(),await identityKeyId(offer.publicKeyPem));
 await nativePage.screenshot({path:join(out,'native-explicit-approval.png'),fullPage:true});
 await nativePage.locator('#approve').click();
 await approvalPopup.waitForFunction(()=>window.received.some(item=>item.kind==='approval'));
 const approval=await approvalPopup.evaluate(()=>window.received.find(item=>item.kind==='approval').payload);await handoff.previewApproval(approval);
 assert.equal((await fixture.db.query('SELECT count(*)::int n FROM device_authorizations WHERE subject_id=$1',[subjectId])).rows[0].n,1);
 report.assertions.push({id:'actual-native-user-click-public-original-approval',passed:true});
 await approvalPopup.close();
 await nativePage.waitForFunction(()=>document.querySelector('#progress').textContent.includes('本次传输已停止'));
 const approvalJournal=await runtime.store.get('web-identity-handoff:'+approvalInfo.handoffId);
 assert.equal(approvalJournal.state,'canceled');assert.equal(approvalJournal.operationId,offer.operationId);
 const joined=await handoff.acceptApproval(approval,{confirmed:true});assert.equal(joined.activated,true);
 assert.equal(active.subjectId,subjectId);assert.equal(joined.receipt.operationId,offer.operationId);
 const returned=await call('galaxy_return',{navigationId:approvalInfo.navigationId});assert.equal(returned.origin.workRef,'PRIVATE_LOCAL_WORK_REF');
 assert.equal(returned.data.taskId,task.taskId);assert.equal(returned.data.request.summary,task.summary);
 report.assertions.push({id:'popup-close-stops-transfer-preserves-original-authorized-operation-and-task',passed:true});
 await nativePage.screenshot({path:join(out,'native-closed-public-operation.png'),fullPage:true});
 // COOP can sever an otherwise correctly opened foreign-origin window. That
 // transport limitation must stop without making a different GUID or grant.
 coop=true;const second=await prepare();await nativePage.goto(second.url);
 const coopPopupPromise=nativePage.waitForEvent('popup');await nativePage.locator('#open').click();const coopPopup=await coopPopupPromise;
 await coopPopup.waitForLoadState('domcontentloaded');await coopPopup.waitForFunction(()=>typeof window.send==='function');
 assert.equal(await coopPopup.evaluate(()=>window.opener===null),true);
 await nativePage.waitForFunction(()=>document.querySelector('#progress').textContent.includes('本次传输已停止'));
 const coopJournal=await runtime.store.get('web-identity-handoff:'+second.handoffId);
 assert.equal(coopJournal.state,'canceled');assert.equal(coopJournal.nonce,null);assert.equal(coopJournal.offer,undefined);
 assert.equal(coopJournal.deviceAuthorizationVerified,false);assert.equal((await runtime.status()).identity,subjectId);
 await nativePage.screenshot({path:join(out,'coop-transport-unavailable.png'),fullPage:true});
 report.assertions.push({id:'actual-coop-severed-popup-stops-without-new-identity-or-device-offer',passed:true});
 await coopPopup.close();
 assert.equal(report.pageErrors.length,0);
}catch(reason){failure=reason;report.failure={name:reason.name,message:reason.message,stack:reason.stack};
 report.latestTransport=runtime&&observedInfo?await runtime.store.get('web-identity-handoff:'+observedInfo.handoffId):null;
 if(observedNativePage&&!observedNativePage.isClosed()){report.nativeBody=await observedNativePage.locator('body').innerText();await observedNativePage.screenshot({path:join(out,'failure-native.png'),fullPage:true});}
 if(observedPopup&&!observedPopup.isClosed()){report.popupState=await observedPopup.evaluate(()=>({url:location.href,openerPresent:window.opener!==null,receivedKinds:window.received?.map(item=>item.kind)}));await observedPopup.screenshot({path:join(out,'failure-peer.png'),fullPage:true});}
}
finally{
 await browser?.close();webClient?.close();await client?.close();await server?.close();await runtime?.close();
 api?.closeAllConnections();if(api?.listening)await new Promise(r=>api.close(r));await fixture?.db.close();
 for(const url of closedUrls){let available=true;try{await fetch(url);}catch{available=false;}assert.equal(available,false); }
 const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-web-popup-'));
 await rm(target,{recursive:true,force:true});
 const after=await hashes();report.sourceChanged=sourcePaths.filter(path=>beforeHashes[path]!==after[path]);
 report.endedAt=new Date().toISOString();report.allTemporaryListenersClosed=true;report.passed=!failure&&report.sourceChanged.length===0;
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({report:join(out,'report.json'),assertions:report.assertions.length,pageErrors:report.pageErrors.length,
  sourceChanged:report.sourceChanged,passed:report.passed,pid:process.pid,allTemporaryListenersClosed:true,officialMainConsumer:false}));
}
if(failure)throw failure;
assert.equal(report.sourceChanged.length,0);
