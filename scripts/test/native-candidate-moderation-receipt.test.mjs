import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {Client,InMemoryTransport} from '../../integrations/native-v2/compact-app/node_modules/@modelcontextprotocol/client/dist/index.mjs';

test('fixed native artifact calls the canonical original moderation receipt over authenticated HTTP without restoring content',async()=>{
 const source=process.env.GALAXY_NATIVE_TEST_SOURCE,candidate=process.env.GALAXY_NATIVE_TEST_CANDIDATE;
 assert.ok(source&&candidate,'Explicit fixed source and artifact required; no skip');
 const {serviceFixture}=await import(pathToFileURL(join(source,'packages/galaxy-official/test/service-fixture.mjs')).href);
 const {createApi}=await import(pathToFileURL(join(source,'packages/galaxy-official/src/http.mjs')).href);
 const {digest}=await import(pathToFileURL(join(source,'packages/galaxy-official/src/shared/digest.mjs')).href);
 const {createNativeToolServer}=await import(pathToFileURL(join(candidate,'server.js')).href);
 const scopes=['binding','consent','case-teaser','moderation'];
 const owner=await serviceFixture(scopes),reporter=await serviceFixture(scopes,owner.db),other=await serviceFixture(scopes,owner.db);
 owner.moderation.moderatorIds=[owner.actor.subjectId];
 const api=createApi({...owner,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 let server,client;const calls=[];let current=reporter;
 try{
  const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Synthetic moderation candidate',summary:'Private case material',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:owner.actor.subjectId,role:'requester'}]};
  const sourceGrant=await owner.authorize(root,'case.teaser.publish',{viewers:[reporter.actor.subjectId]});await owner.cases.submit(owner.actor,sourceGrant);
  const report={id:randomUUID(),caseId:root.id,caseVersion:1,targetEventId:root.id,category:'other',summary:'Private synthetic concern; not a real allegation'};
  const signed=await reporter.authorize(report,'moderation.publish',{viewers:[owner.actor.subjectId]});await owner.moderation.report(reporter.actor,signed);
  await owner.consents.revoke(reporter.actor,signed.consentId);await owner.consents.revoke(owner.actor,sourceGrant.consentId);
  await owner.db.query('UPDATE moderation_reports SET payload_text=$2 WHERE id=$1',[report.id,'original private bytes are unavailable']);
  const endpoint='http://127.0.0.1:'+api.address().port,values=new Map();
  const runtime={website:'https://synthetic.example',store:{get:async k=>values.get(k),put:async(k,v)=>values.set(k,v)},now:()=>owner.now,
   helpFlow:{start:async()=>{throw Error('Unexpected Help mutation');}},navigation:{open:async()=>({})},status:async()=>({identity:current.actor.subjectId}),
   api:{endpoint,snapshot:()=>({subjectId:current.actor.subjectId,bindingId:current.actor.bindingId,generation:current===reporter?1:2}),call:async(path,input)=>{
    calls.push({path,input});const response=await fetch(endpoint+path,{method:'POST',headers:{Authorization:'Bearer '+current.credential,'Content-Type':'application/json'},body:JSON.stringify(input)});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
   }}};
  server=createNativeToolServer(runtime);client=new Client({name:'isolated-native-moderation',version:'0.1.1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  const list=await client.listTools();assert.equal(list.tools.find(t=>t.name==='galaxy_moderation_receipt')?.annotations?.readOnlyHint,true);
  const query={reportId:report.id,eventId:report.id,payloadHash:digest(signed.payloadJson)};
  const invoke=async args=>{const result=await client.callTool({name:'galaxy_moderation_receipt',arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));assert.ok(result.structuredContent);return result.structuredContent;};
  const accepted=await invoke(query);assert.equal(accepted.state,'acknowledged');assert.deepEqual(accepted.receipt,{reportId:report.id,eventId:report.id,version:1});
  assert.equal(accepted.currentAccessGranted,false);assert.equal(accepted.contentReturned,false);assert.equal(JSON.stringify(accepted).includes(report.summary),false);
  assert.deepEqual(calls[0],{path:'/v1/moderation/reports/'+report.id+'/receipt',input:{eventId:report.id,payloadHash:query.payloadHash}});
  assert.equal((await invoke({...query,payloadHash:'0'.repeat(64)})).state,'conflict');current=other;assert.equal((await invoke(query)).state,'absent');
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.path.endsWith('/receipt')),'No original write, old-body read or permission renewal');
 }finally{await client?.close();await server?.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await owner.db.close();}
});
