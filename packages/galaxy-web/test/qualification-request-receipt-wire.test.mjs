import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createQualificationPermissionClient} from '../src/features/qualification-permissions/qualification-permission-client.mjs';

test('qualification request keeps the exact private intent and reconciles an unknown accepted receipt without granting permission',async()=>{
 const endpoint='https://official.example.invalid',subjectId='GUID'+'A'.repeat(28),sourceAuthorId='GUID'+'B'.repeat(28),records=new Map(),calls=[],accepted=new Map();let lose=true;
 const api={endpoint,snapshot:()=>({subjectId,bindingId:randomUUIDValue,generation:1}),prepareAuthorization:async(payloadJson,options)=>{calls.push('sign');return{payloadJson,signedIntent:'synthetic-signed-intent',intent:{id:randomUUID(),...options}};},submitAuthorization:async prepared=>({consentId:prepared.intent.id,payloadJson:prepared.payloadJson}),call:async(path,input)=>{
  calls.push(path);if(path.endsWith('/receipt')){const r=accepted.get(input.eventId);return r?{eventId:input.eventId,payloadHash:input.payloadHash,state:r.hash===input.payloadHash?'acknowledged':'conflict',permissionGranted:false}:{eventId:input.eventId,state:'absent'};}
  if(path.endsWith('/events')){const p=JSON.parse(input.payloadJson),hash=createHash('sha256').update(input.payloadJson).digest('hex');assert.equal(p.kind,'request');assert.equal(p.sourceAuthorId,sourceAuthorId);assert.equal(JSON.stringify(p).includes('private source body'),false);accepted.set(p.eventId,{hash});if(lose){lose=false;throw Error('synthetic lost request ACK');}return{acknowledged:true,permissionGranted:false};}throw Error(`unexpected ${path}`);
 }};
 const randomUUIDValue=randomUUID(),runtime={api,getLocal:async key=>structuredClone(records.get(key)),putLocal:async(key,value)=>records.set(key,structuredClone(value)),receiptStatus:{captureLease:()=>({assertCurrent(){}})}};
 const client=createQualificationPermissionClient({runtime,subjectId,now:()=>2000000000}),plan={taskId:randomUUID(),expiresAt:new Date(2000001800000).toISOString(),compute:{evidence:{participationIds:[randomUUID()],externalReviewRefs:[]}}},author={sourceAuthorId,sourceRefs:[{kind:'task-event',id:randomUUID(),eventVersion:1,payloadHash:'b'.repeat(64)}]};
 const preview=await client.prepareRequest(plan,author);assert.equal(calls.length,0);await assert.rejects(client.execute(preview,{confirmed:true}),/lost request ACK/);
 const journal=[...records.values()][0];assert.equal(journal.active.operationId,preview.operationId);assert.equal(journal.active.payloadHash,preview.payloadHash);const sent=calls.filter(path=>path.endsWith('/events')).length;
 const result=await client.reconcile(preview.operationId);assert.equal(result.state,'acknowledged');assert.equal(result.permissionGranted,false);assert.equal(calls.filter(path=>path.endsWith('/events')).length,sent);assert.equal(calls.filter(path=>path==='sign').length,1);
});
