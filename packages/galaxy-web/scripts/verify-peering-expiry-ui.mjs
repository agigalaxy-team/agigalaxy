import { chromium, browserToolOutput } from './browser-tool-runtime.mjs';
import {build} from '../../../node_modules/esbuild/lib/main.js';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {generateKeyPairSync,randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {decodeJwt} from 'jose';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {prepareHub,hubScopes} from '../../galaxy-official/test/hub-peering-workflow.mjs';
import {createPeeringProof} from '../../galaxy-official/test/hub-ci-proof-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {createSigningService} from '../../galaxy-official/src/signing-service.mjs';
import {digest} from '../../galaxy-official/src/shared/digest.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=browserToolOutput(import.meta.url, undefined);await mkdir(out,{recursive:true});
const now=Math.floor(Date.now()/1000),apis=[],fixtures=[],checks=[],pageErrors=[],calls=[];
let browser,context,page,frontend,lastSigned,remoteCalls=0,lastQuery;
const wall=()=>Math.floor(Date.now()/1000);
try{
 const a=await serviceFixture(hubScopes,null,{now,endpoint:'https://browser-peer-a.example'});fixtures.push(a);
 const b=await serviceFixture(hubScopes,null,{now,endpoint:'https://browser-peer-b.example'});fixtures.push(b);
 for(const f of fixtures){
  const key=generateKeyPairSync('ed25519');f.access.trustedKeys.set('browser-peering',{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:now-1,notAfter:now+200000,revoked:false});
  f.peering.sign=createSigningService({endpoint:f.access.endpoint,signingKey:key.privateKey,kid:'browser-peering',trustedKeys:f.access.trustedKeys,now:wall},['hub-peering']).sign;
  f.access.now=wall;f.peering.now=wall;
  const api=createApi({...f,rateLimit:10000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));apis.push(api);f.testAddress='http://127.0.0.1:'+api.address().port;
 }
 const call=async(f,path,input,who=f,status=200)=>{
  const response=await fetch(f.testAddress+path,{method:'POST',headers:{'Content-Type':'application/json',...(who?{Authorization:'Bearer '+who.credential}:{})},body:JSON.stringify(input)});
  const body=await response.json();assert.equal(response.status,status,JSON.stringify({error:body.error??null}));return body;
 };
 const ah=await prepareHub(a),bh=await prepareHub(b),party=(f,hubId)=>({endpoint:f.access.endpoint,hubId,operatorId:f.actor.subjectId,keys:[...f.access.trustedKeys].map(([kid,pin])=>({kid,publicKeyPem:pin.publicKeyPem,notBefore:pin.notBefore,notAfter:pin.notAfter}))});
 const agreement={profile:'galaxy-direct-proof/1',id:randomUUID(),version:1,parties:[party(a,ah),party(b,bh)],sourceKinds:['ci-proof-v2','contribution-summary'],purpose:'help-discovery',ratePerMinute:60,pageSize:5,expiresAt:now+1800,responseMaxAgeSeconds:120,cache:'no-response-body-retention',route:'direct',officialProtocolFee:0,localEvaluationAuthority:'no-automatic-capability-upgrade',rawTaskContext:'excluded',intake:'each-party-hub-private-intake'};
 for(const [f,hubId] of [[a,ah],[b,bh]])await call(f,'/v2/hubs/peering/events',await f.authorize({schemaVersion:2,id:randomUUID(),kind:'peer-approve',hubId,expectedVersion:0,agreement},'hub.publish'));
 a.peering.send=async(url,{bodyJson})=>{assert.equal(url,b.access.endpoint+'/v2/hubs/peering/exchange');remoteCalls++;const response=await call(b,'/v2/hubs/peering/exchange',JSON.parse(bodyJson),null);lastSigned=response.signed;return response;};
 const caseId=randomUUID(),caseEvent={schemaVersion:2,eventId:caseId,caseId,kind:'case-created',expectedVersion:0,actorId:b.actor.subjectId,localRef:randomUUID(),title:'Synthetic private peering expiry source',summary:'PRIVATE_BROWSER_PEERING_CONTEXT',source:{kind:'local',reference:randomUUID()},synthetic:true};
 await b.cases.submitV2(b.actor,await b.authorize(caseEvent,'case.teaser.publish',{objectId:caseId}));
 const intervention={schemaVersion:2,eventId:randomUUID(),caseId,kind:'intervention',expectedVersion:1,actorId:b.actor.subjectId,types:['diagnosis'],affectsAttemptIds:[],description:'PRIVATE_BROWSER_DIAGNOSIS',sourceRefs:[],observedEffect:'Isolated browser protocol exercise'};
 const factAuth=await b.authorize(intervention,'case.teaser.publish',{objectId:intervention.eventId});await b.cases.submitV2(b.actor,factAuth);
 const proof=await createPeeringProof(b,caseEvent,intervention),summarySource={kind:'contribution-summary',source:{kind:'case-event',id:intervention.eventId,eventVersion:1,payloadHash:digest(factAuth.payloadJson)},fields:['eventType','actorId']};
 const grant=async(source,seconds)=>{const event={schemaVersion:2,id:randomUUID(),hubId:bh,kind:'source-grant',agreementId:agreement.id,agreementVersion:1,source,requesterIds:[a.actor.subjectId],expiresAt:wall()+seconds,purpose:'selected-peering-read-only',disclosure:'exact-proof-or-selected-nonnarrative-contribution-fields',redactionConfirmed:true};await call(b,'/v2/hubs/peering/events',await b.authorize(event,'hub.publish'));return event;};
 const revoke=async item=>call(b,'/v2/hubs/peering/events',await b.authorize({schemaVersion:2,id:randomUUID(),hubId:bh,kind:'source-revoke',grantId:item.id},'hub.publish'));
 const bundle=await build({stdin:{contents:`
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {HubPeeringWorkspace} from './packages/galaxy-web/src/hub-peering-workspace.tsx';
  import {createHubsWebClient} from './packages/galaxy-web/src/hubs-client.mjs';
  const subjectId=${JSON.stringify(a.actor.subjectId)},endpoint=${JSON.stringify(a.access.endpoint)};
  const runtime={api:{endpoint,snapshot:()=>({subjectId,bindingId:'synthetic-browser-read-binding',generation:1}),call:async(path,input)=>{const response=await fetch('/read'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw Error(body.error??'读取失败');window.lastResult=body;return body;}}};
  const client=createHubsWebClient(runtime,{subjectId});
  createRoot(document.getElementById('root')).render(<><p>合成双端协议场景 · 同机独立数据库与签名 · 浏览器读取传输 fixture</p><HubPeeringWorkspace client={client} hubId=${JSON.stringify(ah)} owner={false} subjectId={subjectId} isCurrent={()=>true} onPending={()=>{throw Error('Read-only journey must not write');}}/></>);
 `,resolveDir:root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root}});
 const cssPath=resolve(root,'packages/galaxy-web/dist/assets'),css=(await Promise.all((await readdir(cssPath)).filter(x=>x.endsWith('.css')).map(x=>readFile(resolve(cssPath,x),'utf8')))).join('\n')+await readFile(resolve(root,'packages/galaxy-web/src/workspace.css'),'utf8');
 frontend=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body class="galaxy-site"><main class="workspace site-content" id="root"></main><script src="/bundle.js"></script></body></html>');}});await new Promise(ok=>frontend.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+frontend.address().port;
 browser=await chromium.launch({ headless:true });
 context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});context.setDefaultTimeout(15000);
 await context.route(origin+'/read/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname.slice(5);assert.ok(['/v2/hubs/peering/query','/v2/hubs/peering/connections'].includes(path),'browser journey only uses explicit reads');calls.push(path);const response=await context.request.post(a.testAddress+path,{headers:{Authorization:'Bearer '+a.credential,'Content-Type':'application/json'},data:request.postData()});if(path.endsWith('/query'))lastQuery=await response.json();await route.fulfill({response});});
 page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(origin);
 const button=name=>page.getByRole('button',{name,exact:true}),query=()=>button('查询当前获准材料').click();
 const current=()=>page.locator('article').filter({hasText:'当前可读'}),resultText=page.getByText('本次返回已核对的选定材料；不构成独立能力认证。',{exact:true});
 async function shot(name,mobile=false){await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1000});await page.evaluate(()=>{document.activeElement?.blur?.();window.scrollTo(0,0);});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});}
 async function readQuery(){await query();await resultText.waitFor();assert.equal(lastQuery.rawContextIncluded,false);assert.equal(lastQuery.capabilityVerified,false);assert.equal(lastQuery.responseBodyPersisted,false);return lastQuery;}
 await button('查看本次可选直连范围').click();await button('选择此范围').click();assert.equal(await page.getByLabel('双方约定的范围 ID',{exact:true}).inputValue(),agreement.id);
 const proofGrant=await grant(proof.source,10),summaryGrant=await grant(summarySource,100),first=await readQuery();
 assert.equal(first.expiresAt,proofGrant.expiresAt);assert.equal(first.items.find(x=>x.grantId===proofGrant.id).signed,proof.published.signed);assert.equal(first.items.find(x=>x.grantId===proofGrant.id).sourceObject.payloadHash,proof.source.payloadHash);assert.equal(await current().count(),2);
 for(const privateText of [caseEvent.summary,intervention.description])assert.equal((await page.locator('body').innerText()).includes(privateText),false);
 await current().first().getByText('精确来源和原签名',{exact:true}).click();await shot('current-short-grant-original-proof-desktop');
 const callsBeforeExpiry=calls.length;await resultText.waitFor({state:'hidden',timeout:15000});assert.ok(Date.now()>=proofGrant.expiresAt*1000);assert.equal(await page.locator('article').count(),0);assert.equal(calls.length,callsBeforeExpiry,'expiry hides locally without an implicit query');await shot('expired-page-cleared-mobile',true);
 checks.push({check:'Full production peering page and real query client read independently signed dual HTTP results; earliest selected Proof grant expires and the actual wall-clock React timer removes the full page without a new request; original Proof bytes/hash remain unchanged',passed:true});

 const remaining=await readQuery();assert.deepEqual(remaining.items.find(x=>x.grantId===proofGrant.id),{grantId:proofGrant.id,state:'unavailable'});assert.equal(remaining.items.find(x=>x.grantId===summaryGrant.id).state,'current');assert.equal(remaining.expiresAt,summaryGrant.expiresAt);assert.equal(await current().count(),1);await shot('expired-proof-current-summary-mobile',true);
 await revoke(summaryGrant);await button('重新核对当前页来源').click();await page.waitForFunction(()=>window.lastResult?.items?.length>0&&window.lastResult.items.every(x=>x.state==='unavailable'));
 assert.ok(lastQuery.items.every(x=>Object.keys(x).sort().join(',')==='grantId,state'));assert.equal(await current().count(),0);assert.ok(lastQuery.expiresAt>=wall()+115);await shot('withdrawn-sources-no-old-body-mobile',true);
 const receipt=await call(b,'/v2/hubs/peering/receipt',{operationId:proofGrant.id,payloadHash:digest(JSON.stringify(proofGrant))});assert.equal(receipt.state,'recorded');
 checks.push({check:'Explicit re-query shows expired Proof unavailable and remaining summary current; actual signed withdrawal plus page recheck produces only grantId/state, no old body or signature, while original grant receipt remains recorded',passed:true});

 const actualExchange=b.peering.exchange.bind(b.peering);let ttl=120;
 b.peering.exchange=async input=>{const original=await actualExchange(input),jwt=decodeJwt(original.signed);return{signed:await b.peering.sign('hub-peering',{...jwt.data,expiresAt:jwt.data.checkedAt+120},jwt.jti,ttl)};};
 const foreignGrant=await grant(proof.source,8),foreign=await readQuery();assert.equal(decodeJwt(lastSigned).data.expiresAt,foreign.checkedAt+120);assert.equal(foreign.expiresAt,foreignGrant.expiresAt);assert.equal(foreign.items.find(x=>x.grantId===foreignGrant.id).signed,proof.published.signed);await resultText.waitFor({state:'hidden',timeout:12000});assert.equal(await current().count(),0);
 checks.push({check:'An independently re-signed peer page with a 120-second outer display claim cannot extend the selected 8-second source grant in the browser',passed:true});

 const envelopeGrant=await grant(proof.source,60);ttl=5;const envelope=await readQuery();assert.equal(envelope.expiresAt,decodeJwt(lastSigned).exp);assert.ok(envelope.expiresAt<envelopeGrant.expiresAt);assert.equal(await current().count(),1);await resultText.waitFor({state:'hidden',timeout:10000});assert.equal(await current().count(),0);
 checks.push({check:'A separately signed five-second JWT envelope limits the same production page even when selected source permission lasts sixty seconds; its real timer clears all old current-source rows',passed:true});
 assert.deepEqual(pageErrors,[]);assert.equal(calls.filter(x=>x.endsWith('/query')).length,remoteCalls);assert.equal(await page.evaluate(()=>localStorage.length),0);
 const report={passed:checks.length,checks,pageErrors,queryCount:remoteCalls,browserMutationCount:0,originalProofSha256:createHash('sha256').update(proof.published.signed).digest('hex'),limitations:['Synthetic same-host dual HTTP services and independent PGlite databases are not autonomous operators or independent fault domains.','Production HubPeeringWorkspace and createHubsWebClient read path are mounted completely; full main router and browser identity enrollment are outside this focused test.','Transport injects the actual fixture credential in Playwright routing outside browser state; no credential or raw private-key material is included in output.','Mutable wall-clock production peering signer is used; original CI observation is an explicitly synthetic provider fixture.']};await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:checks.length,report:resolve(out,'report.json')}));
}finally{if(browser)await browser.close();if(frontend)await new Promise(ok=>frontend.close(ok));for(const api of apis)await new Promise(ok=>api.close(ok));for(const f of fixtures)await f.db.close();}
