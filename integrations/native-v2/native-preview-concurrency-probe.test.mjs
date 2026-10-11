import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {McpServer} from '@modelcontextprotocol/server';
import {registerNativeDeviceManagementTools} from './device-management-tools.mjs';
import {registerNativeWorkerTools} from './worker-tools.mjs';

const require=createRequire(new URL('../../packages/galaxy-official/package.json',import.meta.url));
const {Client,StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {NodeStreamableHTTPServerTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/node')).href);

// Actual MCP SDK transport, deferred prepare/lease contract doubles only. This
// probe isolates admission accounting, not real control/Worker business writes.
async function fixture(kind){
 const subjectId='GUID'+'1'.repeat(28),bindingId=randomUUID(),deviceId=randomUUID(),endpoint='https://capacity.example';
 const snapshot={subjectId,bindingId,generation:1},configuration={id:randomUUID(),version:1},caseId=randomUUID(),attemptId=randomUUID();
 let entered=0,release;const gate=new Promise(r=>release=r),journal=new Map();
 const runtime={api:{endpoint,snapshot:()=>snapshot,call:async()=>({attempts:[{id:attemptId,version:1,configurationRef:configuration}]})},
  receiptStatus:{captureLease:()=>({subjectId,deviceId,endpoint,bindingId,generation:1,assertCurrent:()=>{}})}};
 const server=new McpServer({name:'synthetic-preview-concurrency',version:'1'});
 let tools,name,input,limit;
 if(kind==='device'){
  runtime.deviceManagement={prepareRevoke:async()=>{entered++;await gate;return {subjectId,initiatorDeviceId:deviceId,endpoint,
   kind:'revoke-device',expiresAt:3600,operationId:randomUUID()};}};
  tools=registerNativeDeviceManagementTools(server,{runtime,review:async()=>{throw Error('not invoked');},now:()=>0});
  name='galaxy_identity_device_native_prepare_revoke';input={deviceId:randomUUID()};limit=32;
 }else{
  const flow={workers:()=>[{id:'capacity',version:'1',sourceHash:'1'.repeat(64)}],close:()=>{},abort:()=>{},
   prepareStart:async value=>{entered++;await gate;const operationId=randomUUID();journal.set(operationId,{state:'prepared'});
    return {kind:'send',workerId:'capacity',caseId,attempt:{id:attemptId,version:1},pack:{id:randomUUID(),version:1},
     purpose:value.purpose,associationId:randomUUID(),preview:{operationId,payloadJson:JSON.stringify({operationId,text:value.text}),
      peerPrincipal:'capacity-peer',endpoint:'https://capacity-peer.example'}};}};
  tools=registerNativeWorkerTools(server,{runtime,flow,review:async()=>{throw Error('not invoked');},now:()=>0});
  name='galaxy_worker_host_prepare';input={action:'start',workerId:'capacity',caseId,attemptId,attemptVersion:1,
   purpose:'Capacity protocol probe only',text:'No model or business execution'};limit=128;
 }
 const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true});
 const http=createServer((req,res)=>{void transport.handleRequest(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
 await server.connect(transport);await new Promise(r=>http.listen(0,'127.0.0.1',r));
 const sdk=new Client({name:'synthetic-capacity-owner',version:'1'});
 await sdk.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+http.address().port+'/mcp')));
 return {sdk,tools,name,input,limit,journal,release,entered:()=>entered,
  async close(){release();await tools.close();await sdk.close();await server.close();http.closeAllConnections();if(http.listening)await new Promise(r=>http.close(r));}};
}

for(const kind of ['device','worker'])test('diagnostic: '+kind+' reserves capacity before concurrent actual MCP prepare awaits',{timeout:30000},async t=>{
 const x=await fixture(kind);let calls=[];
 try{
  let settled=0;calls=Array.from({length:x.limit+1},()=>x.sdk.callTool({name:x.name,arguments:x.input}).then(v=>{settled++;return v;}));
  const deadline=Date.now()+10000;
  while(x.entered()+settled<x.limit+1&&Date.now()<deadline)await delay(10);
  x.release();const results=await Promise.all(calls),successful=results.filter(v=>!v.isError),errors=results.filter(v=>v.isError);
  t.diagnostic('preview_capacity_observed '+JSON.stringify({kind,limit:x.limit,parallelRequests:x.limit+1,
   admittedPrepareCalls:x.entered(),successfulHandles:successful.length,errors:errors.length,journalSize:x.journal.size,
   actualMcpSdk:true,business:'explicit-contract-double; zero execute/review'}));
  assert.ok(x.entered()<=x.limit,'all await-pending prepares must count against the advertised preview limit');
  assert.equal(successful.length,x.limit);assert.equal(errors.length,1);
  assert.match(JSON.stringify(errors[0]),/preview_capacity/);
 }finally{x.release();await Promise.allSettled(calls);await x.close();}
});
