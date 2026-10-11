import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createNativeRuntime} from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../../galaxy-edge-mcp/src/native-v2/server.mjs';

const require=createRequire(new URL('../package.json',import.meta.url));
const {Client,StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {NodeStreamableHTTPServerTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/node')).href);
const names={read:'galaxy_identity_device_native_read',prepare:'galaxy_identity_device_native_prepare_revoke',confirm:'galaxy_identity_device_native_confirm',stop:'galaxy_identity_device_native_stop_retry'};

test('registered native server exposes exact device management and invalidates late preparation before shutdown drain',{timeout:90000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-registered-device-tools-'));
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
 f.identityControl.now=()=>f.now;
 const api=createApi({...f,rateLimit:1000});await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+api.address().port,commits=[],runtimes=[];
 let server,http,sdk,release,closed=false;
 try{
  const wire=async(url,options={})=>{const u=new URL(url);assert.equal(u.origin,f.access.endpoint);
   const result=await fetch(origin+u.pathname+u.search,options);if(u.pathname.endsWith('/identity/control/commit'))commits.push({id:JSON.parse(options.body).operationId,status:result.status});return result;};
  const config={endpoint:f.access.endpoint,website:'https://synthetic-device-tools.example',trustedKeys:f.access.trustedKeys,now:()=>f.now,fetch:wire};
  const native=async name=>{const value=await createNativeRuntime({...config,dataDirectory:join(directory,name)});runtimes.push(value);return value;};
  const old=await native('old');await old.initialize({profile:'minimal'},{confirmed:true});await old.connect({confirmed:true});
  const subjectId=(await old.status()).identity,oldId=old.api.snapshot().control.deviceId;
  const attach=async name=>{const value=await native(name),offer=await value.device.offer(subjectId,{confirmed:true});
   await value.device.accept(await old.device.approve(offer,{confirmed:true}),{confirmed:true});await value.connect({confirmed:true});return{value,deviceId:offer.deviceId};};
  const newer=await attach('newer'),third=await attach('third');
  let hold=false,arrived;
  const gated=Object.freeze({...newer.value,deviceManagement:Object.freeze({...newer.value.deviceManagement,
   prepareRevoke:async input=>{const p=await newer.value.deviceManagement.prepareRevoke(input);if(hold){arrived();await new Promise(r=>release=r);}return p;}})});
  server=createNativeToolServer(gated);
  const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true});
  http=createServer((req,res)=>{void transport.handleRequest(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
  await server.connect(transport);await new Promise(r=>http.listen(0,'127.0.0.1',r));
  sdk=new Client({name:'registered-device-review',version:'1'});await sdk.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+http.address().port+'/mcp')));
  const raw=(name,args)=>sdk.callTool({name,arguments:args}),value=async(name,args)=>{const r=await raw(name,args);assert.equal(r.isError??false,false,JSON.stringify(r));return JSON.parse(r.content[0].text);};
  const listed=await sdk.listTools();for(const name of Object.values(names))assert.ok(listed.tools.some(x=>x.name===name));
  assert.equal(listed.tools.find(x=>x.name===names.read).annotations.readOnlyHint,true);
  const state=await value(names.read,{action:'current'});assert.equal(state.devices.length,3);assert.equal(state.canManage,true);
  const before=commits.length,p=await value(names.prepare,{deviceId:oldId});assert.equal(p.signed,false);assert.equal(commits.length,before);
  assert.equal((await raw(names.confirm,{previewId:p.previewId,confirmed:true})).isError,true);
  const needs=await value(names.confirm,{previewId:p.previewId});assert.equal(needs.state,'user-choice-needs-browser');
  const html=await(await fetch(needs.url)).text();for(const exact of [oldId,p.preview.requestHash,p.preview.challengeHash])assert.ok(html.includes(exact));
  const approval=await fetch(needs.url,{method:'POST',headers:{Origin:new URL(needs.url).origin,'Content-Type':'application/x-www-form-urlencoded'},body:'action=allow'});assert.equal(approval.status,200);
  const receipt=await value(names.confirm,{previewId:p.previewId});assert.equal(receipt.receipt.state,'committed');assert.equal(receipt.currentAccessGranted,false);assert.equal(commits.length,before+1);
  await assert.rejects(old.connect({confirmed:true}),/current_device_control_required/);
  assert.equal((await value(names.read,{action:'reconcile',operationId:p.operationId})).recordedLocalReceipt,true);
  hold=true;const reached=new Promise(r=>arrived=r),pending=raw(names.prepare,{deviceId:third.deviceId});await reached;
  const original=(await newer.value.deviceManagement.pending()).active;assert.ok(original.operationId);const closing=server.close();release();
  const late=await pending;assert.equal(late.isError,true);assert.equal(JSON.stringify(late).includes('"previewId"'),false);
  await closing;closed=true;assert.equal(commits.length,before+1);assert.equal((await newer.value.deviceManagement.pending()).active.operationId,original.operationId);
  assert.equal((await newer.value.deviceManagement.current()).devices.find(x=>x.deviceId===third.deviceId).state,'active');
  t.diagnostic(JSON.stringify({actualRegisteredServer:true,actualSdk:true,actualNativeFS:true,actualSignedHttp:true,database:'PGlite',
   registeredDeviceTools:4,reviewedRevokeCommits:1,latePreviewWithheld:true,originalPendingRetained:true,syntheticDevices:true,physicalHostAcceptance:false}));
 }finally{
  release?.();if(!closed)await server?.close();await sdk?.close();if(http?.listening){http.closeAllConnections();await new Promise(r=>http.close(r));}
  for(const runtime of runtimes)runtime.close();api.closeAllConnections();await new Promise(r=>api.close(r));await f.db.close();
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-registered-device-tools-'));await rm(target,{recursive:true,force:true});
 }
});

