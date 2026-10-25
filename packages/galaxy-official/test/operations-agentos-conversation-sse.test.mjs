import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {streamConversationResponse} from '../src/adapters/http/operations-agentos-conversation-sse.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('actual HTTP observer checks before headers, projects late denial and closes only its reader',{timeout:15000},async t=>{
 const operationId=randomUUID();let mode='early-denied',closed=0,observed=0;
 const server=createServer(async(request,response)=>{
  try{
   await streamConversationResponse({request,response,operationId,events:async function*(signal){
    try{
     if(mode==='early-denied')throw new ServiceError('operations_permission_denied',403);
     yield{kind:'lease',operationId,readExpiresAt:Math.floor(Date.now()/1000)+30,stopAvailable:true};
     if(mode==='source')throw new ServiceError('operations_agentos_source_changed',409);
     if(mode==='late-denied')throw new ServiceError('operations_permission_denied',403);
     if(mode==='internal')throw new Error('PRIVATE_PROVIDER_OR_TOOL_BODY');
     while(!signal.aborted){yield{kind:'phase',operationId,eventIndex:observed++,phase:'waiting',arguments:'PRIVATE_TOOL_BODY'};await delay(10);}
    }finally{closed++;}
   }});
  }catch(error){response.writeHead(error.status??500,{'content-type':'application/json'});response.end(JSON.stringify({error:'closed_authorization_failure'}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port;
 const early=await fetch(origin);assert.equal(early.status,403);assert.match(early.headers.get('content-type'),/application\/json/);
 for(const[state,kind]of[['source','context-changed'],['late-denied','blocked'],['internal','resync']]){
  mode=state;const response=await fetch(origin),text=await response.text();assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);assert.equal(response.headers.get('cache-control'),'no-store, no-transform');
  const events=text.split('\n\n').filter(Boolean).map(frame=>JSON.parse(frame.split('\n').find(line=>line.startsWith('data: ')).slice(6)));
  assert.deepEqual(events.map(event=>event.kind),['lease',kind]);assert(events.every(event=>event.operationId===operationId));assert(!text.includes('PRIVATE_'));
 }
 mode='disconnect';const controller=new AbortController(),response=await fetch(origin,{signal:controller.signal}),reader=response.body.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});reader.releaseLock();
 await delay(80);assert.equal(closed,5,'disconnect closes the native observer generator, including its tail');assert(observed>0);assert.equal(server.listening,true,'disconnect is not a service shutdown or cancellation command');
});
