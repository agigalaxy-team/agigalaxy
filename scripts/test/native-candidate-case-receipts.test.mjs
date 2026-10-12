import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {Client,InMemoryTransport} from '../../integrations/native-v2/compact-app/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import {serviceFixture} from '../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../packages/galaxy-official/src/http.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';

test('captured native bundle calls both exact Case receipts over MCP and authenticated HTTP after withdrawal',async()=>{
 const candidate=process.env.GALAXY_NATIVE_TEST_CANDIDATE;
 assert.ok(candidate,'Explicit captured native candidate required; no silent skip');
 const {createNativeToolServer}=await import(pathToFileURL(join(candidate,'server.js')).href);
 const f=await serviceFixture(['binding','consent','case-teaser','assistance','context']),api=createApi(f);
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 let server,client;const calls=[];
 try{
  const id=randomUUID(),event={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,
   actorId:f.actor.subjectId,localRef:randomUUID(),title:'Synthetic captured native receipt',summary:'Private withdrawn original text',
   source:{kind:'local',reference:randomUUID()},synthetic:true};
  const signed=await f.authorize(event,'case.teaser.publish',{objectId:id});
  await f.cases.submitV2(f.actor,signed);await f.consents.revoke(f.actor,signed.consentId);
  const endpoint='http://127.0.0.1:'+api.address().port,values=new Map(),store={get:async k=>values.get(k),put:async(k,v)=>values.set(k,v)};
  const runtime={website:'https://synthetic.example',store,now:()=>f.now,helpFlow:{start:async()=>{throw Error('Unexpected Help mutation');}},navigation:{open:async()=>({})},
   status:async()=>({identity:f.actor.subjectId}),api:{endpoint,snapshot:()=>({subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,generation:1}),
    call:async(path,input)=>{calls.push({path,input});const response=await fetch(endpoint+path,{method:'POST',
      headers:{Authorization:'Bearer '+f.credential,'Content-Type':'application/json'},body:JSON.stringify(input)});
      const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}}};
  server=createNativeToolServer(runtime);client=new Client({name:'isolated-candidate-receipt',version:'0.1.0'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  const list=await client.listTools();
  for(const name of ['galaxy_case_v2_receipt','galaxy_task_case_link_receipt'])
   assert.equal(list.tools.find(t=>t.name===name)?.annotations?.readOnlyHint,true);
  const eventQuery={caseId:id,eventId:id,payloadHash:digest(signed.payloadJson)};
  const invoke=async(name,args)=>{const reply=await client.callTool({name,arguments:args});assert.notEqual(reply.isError,true,JSON.stringify(reply));assert.ok(reply.structuredContent);return reply.structuredContent;};
  const result=await invoke('galaxy_case_v2_receipt',eventQuery);
  assert.equal(result.state,'acknowledged');assert.equal(result.currentAccessGranted,false);
  assert.equal(JSON.stringify(result).includes(event.summary),false);
  assert.deepEqual(calls[0],{path:'/v2/cases/events/receipt',input:eventQuery});
  const link={taskId:randomUUID(),operationId:randomUUID(),payloadHash:'0'.repeat(64)};
  assert.equal((await invoke('galaxy_task_case_link_receipt',link)).state,'absent');
  assert.deepEqual(calls[1],{path:'/v2/tasks/'+link.taskId+'/case-link/receipt',input:{operationId:link.operationId,payloadHash:link.payloadHash}});
  assert.equal(calls.length,2,'Read-only receipt calls neither resend nor read old content');
 }finally{await client?.close();await server?.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
