import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { createSearchClient } from "../src/clients/history.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";
const endpoint='https://official.example.org';
function setup(send,scopes=['history','proof','capsules']){
  const sessions=createSessionMemory({now:()=>1000,isCurrent:async()=>true});
  sessions.adopt({endpoint,subjectId:'GUID'+'0'.repeat(28),bindingId:randomUUID(),scopes:['binding',...scopes],expiresAt:1500,bindingExpiresAt:2000,takeCredential:()=>randomBytes(32).toString('base64url')});
  const client=createSearchClient({endpoint,sessions,send});
  return {sessions,client,controller:createHostConnectionController({endpoint,sessions,searchClient:client})};
}
const empty=type=>({version:1,type,endpoint,capabilityVerified:false,items:[],nextCursor:null});
test('typed client routes exact source filters, rejects malformed responses and enforces per-source scope',async()=>{
  let calls=0;
  const current=setup(async(url,input)=>{calls++;assert.equal(url,endpoint+'/v1/search/query');const request=JSON.parse(input.bodyJson);assert.equal(request.query.conclusion,'failure');return empty(request.type);});
  try{
    assert.equal((await current.client.query({type:'proof',query:{conclusion:'failure'}})).source,'endpoint-reported');
    await assert.rejects(current.client.query({type:'proof',query:{capabilityId:'compiler'}}));assert.equal(calls,1);
  }finally{current.sessions.close();}
  const missing=setup(async()=>{calls++;},['history']);
  try{await assert.rejects(missing.client.query({type:'proof',query:{}}),/authorization required/);assert.equal(calls,1);}finally{missing.sessions.close();}
  const malformed=setup(async()=>empty('history'));
  try{await assert.rejects(malformed.client.query({type:'case',query:{}}),/Invalid typed search response/);}finally{malformed.sessions.close();}
});
test('controller cancellation and session changes discard late typed responses; remote rejection clears authorization',async()=>{
  let started,release;
  const dispatched=new Promise(resolve=>{started=resolve;});
  const current=setup(async(_url,input)=>{started();await new Promise(resolve=>{release=resolve;});return empty(JSON.parse(input.bodyJson).type);});
  try{
    const pending=current.controller.querySearch({type:'proof',query:{}});await dispatched;
    await assert.rejects(current.controller.querySearch({type:'history',query:{}}),/unavailable/);
    current.controller.cancel();release();await assert.rejects(pending,/abort|cancel/i);
  }finally{current.sessions.close();}
  const changed=setup(async()=>{changed.sessions.forget(endpoint);return empty('proof');});
  try{await assert.rejects(changed.client.query({type:'proof',query:{}}),/authorization changed/);}finally{changed.sessions.close();}
  const rejected=setup(async()=>{const error=new Error('denied');error.code='GALAXY_REMOTE_REJECTED';throw error;});
  try{await assert.rejects(rejected.client.query({type:'proof',query:{}}),/denied/);assert.equal((await rejected.sessions.status(endpoint)).state,'remote-rejected');}finally{rejected.sessions.close();}
});
