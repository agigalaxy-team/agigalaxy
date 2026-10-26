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
import {createSigningService} from "../../galaxy-official/src/security/signing-service.mjs";


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
  f.access.now=wall;f.peering.now=wall;f.ciV2.now=wall;f.ciV2.sign=createSigningService({endpoint:f.access.endpoint,signingKey:key.privateKey,kid:'browser-peering',trustedKeys:f.access.trustedKeys,now:wall},['proof']).sign;
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
 const proof=await createPeeringProof(b,caseEvent,intervention);
 const grant=async(source,seconds)=>{const event={schemaVersion:2,id:randomUUID(),hubId:bh,kind:'source-grant',agreementId:agreement.id,agreementVersion:1,source,requesterIds:[a.actor.subjectId],expiresAt:wall()+seconds,purpose:'selected-peering-read-only',disclosure:'exact-proof-or-selected-nonnarrative-contribution-fields',redactionConfirmed:true};await call(b,'/v2/hubs/peering/events',await b.authorize(event,'hub.publish'));return event;};
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
 const actualExchange=b.peering.exchange.bind(b.peering);
 b.peering.exchange=async input=>{
  const original=await actualExchange(input),outer=decodeJwt(original.signed),items=[];
  for(const item of outer.data.items){if(item.sourceObject?.kind!=='ci-proof-v2'){items.push(item);continue;}
   const inner=decodeJwt(item.signed);items.push({...item,signed:await b.ciV2.sign('proof',inner.data,inner.jti,2)});
  }
  return{signed:await b.peering.sign('hub-peering',{...outer.data,items},outer.jti,Math.max(1,outer.exp-wall()))};
 };
 const proofGrant=await grant(proof.source,60),result=await readQuery(),item=result.items.find(value=>value.grantId===proofGrant.id),inner=decodeJwt(item.signed),outer=decodeJwt(lastSigned),sentItem=outer.data.items.find(value=>value.grantId===proofGrant.id);
 assert.equal(inner.exp-inner.iat,2);assert.ok(inner.data.expiresAt>proofGrant.expiresAt);assert.equal(sentItem.expiresAt,proofGrant.expiresAt);assert.equal(outer.data.expiresAt,proofGrant.expiresAt);assert.equal(item.expiresAt,inner.exp);assert.equal(result.expiresAt,inner.exp);assert.equal(item.signed,sentItem.signed);assert.equal(item.sourceObject.payloadHash,proof.source.payloadHash);assert.deepEqual(inner.data,decodeJwt(proof.published.signed).data);assert.equal(inner.jti,decodeJwt(proof.published.signed).jti);assert.equal(await current().count(),1);
 for(const privateText of [caseEvent.summary,intervention.description])assert.equal((await page.locator('body').innerText()).includes(privateText),false);
 await shot('inner-proof-current-short-signature-desktop');
 const beforeExpiryCalls=calls.length;await resultText.waitFor({state:'hidden',timeout:6000});assert.ok(Date.now()>=inner.exp*1000);assert.ok(wall()<proofGrant.expiresAt);assert.equal(await page.locator('article').count(),0);assert.equal(calls.length,beforeExpiryCalls);assert.equal(remoteCalls,1);assert.equal(await page.evaluate(()=>localStorage.length),0);await shot('inner-proof-expired-before-source-grant-mobile',true);
 const originalStored=(await b.db.query('SELECT signed,payload_hash FROM ci_proofs_v2 WHERE id=$1',[proof.source.id])).rows[0];assert.equal(originalStored.signed,proof.published.signed);assert.equal(originalStored.payload_hash,proof.source.payloadHash);assert.deepEqual(pageErrors,[]);
 checks.push({check:'Full production HubPeeringWorkspace reads an actual independently signed dual HTTP response: inner Proof JWT lasts two seconds while source grant lasts sixty seconds and original data lasts about one hour; local item/page clamp to inner exp, wall-clock timer removes the entire old page while grant is still valid with zero automatic requery or mutation, preserving original signature/data/id/hash and stored Proof bytes',passed:true});
 const report={passed:checks.length,checks,pageErrors,queryCount:remoteCalls,browserMutationCount:0,innerSignatureSeconds:inner.exp-inner.iat,sourceGrantSeconds:60,originalDataExpiresAt:inner.data.expiresAt,actualInnerExpiresAt:inner.exp,localPageExpiresAt:result.expiresAt,peerSignedProjectionExpiresAt:sentItem.expiresAt,originalProofSha256:createHash('sha256').update(proof.published.signed).digest('hex'),limitations:['Synthetic same-host dual HTTP services and independent PGlite databases are not autonomous operators or independent fault domains.','Production HubPeeringWorkspace and createHubsWebClient read path are mounted completely; full main router and browser identity enrollment are outside this focused test.','Actual fixture credential is injected only in Playwright transport outside browser state; no credentials or raw private keys are returned.','Synthetic CI observation fixture; no external provider account or real CI assertion.','Only this inner-signature boundary is tested; original four browser groups are not rerun.']};await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:checks.length,report:resolve(out,'report.json')}));
}catch(error){if(page){await writeFile(resolve(out,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:resolve(out,'failure.png'),fullPage:true});}throw error;}finally{if(browser)await browser.close();if(frontend)await new Promise(ok=>frontend.close(ok));for(const api of apis){api.closeAllConnections();await new Promise(ok=>api.close(ok));}for(const f of fixtures)await f.db.close();}