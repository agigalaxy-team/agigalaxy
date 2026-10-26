import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {createChatAgentClient} from "../../galaxy-web/src/features/chat/agents/chat-agent-client.mjs";

const store=()=>{const values=new Map();return {get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value)),
 update:async(key,updater)=>{const next=updater(structuredClone(values.get(key)));if(next&&typeof next.then==='function')throw Error('synchronous_update_required');values.set(key,structuredClone(next));return structuredClone(next);}};};
test('HTTP room Agent grants recover lost receipts, isolate members and keep child room access separate',async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)});
 // Account availability is not under test: no synthetic account is written.
 f.chat.requireAccountWithin=async()=>{};f.chat.consumeInviteWithin=async()=>{};f.chat.markInviteRespondedWithin=async()=>{};
 const api=createApi({...f,browserOrigins:['https://galaxy.example.org'],rateLimit:1000});let a,b,drop='',writes=0;
 try{
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const local=`http://127.0.0.1:${api.address().port}`;
  const fetcher=async(url,options)=>{
   const path=new URL(url).pathname;
   const response=await fetch(local+path,{...options,headers:{...options.headers,Origin:'https://galaxy.example.org'}});
   if(path.endsWith('/agent-grant'))writes++;
   if(drop&&path.endsWith(drop)){drop='';assert.equal(response.status,200);throw Error('lost Agent receipt');}
   return response;
  };
  const config={endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys};
  a=await createExistingWebRuntime(config,{store:store(),fetch:fetcher,now:()=>f.now});b=await createExistingWebRuntime(config,{store:store(),fetch:fetcher,now:()=>f.now});
  for(const runtime of [a,b]){await runtime.connect({confirmed:true});}
  const room=await a.chat.create({title:'普通交流，无任务'},{confirmed:true});assert.equal(room.taskRefs.length,0);
  const invited=await a.chat.propose(room.roomId,{expectedRevision:room.revision,action:'invite',targetSubjectId:(await b.status()).identity.subjectId},{confirmed:true});
  await b.api.call(`/v2/chat/rooms/${room.roomId}/accept`,{decisionId:invited.decisionId,accept:true});
  const client=createChatAgentClient(a),foreign=createChatAgentClient(b);
  await assert.rejects(client.grant(room.roomId,{bindingId:a.api.snapshot().bindingId,mode:'draft',expiresAt:f.now+3600}),/确认/);
  drop='/agent-grant';await assert.rejects(client.grant(room.roomId,{bindingId:a.api.snapshot().bindingId,mode:'respond',primaryResponder:true,expiresAt:f.now+3600},{confirmed:true}),/lost Agent/);
  const pending=await client.pending(room.roomId),grantId=pending.input.grantId;assert.equal(writes,1);
  const replay=await createChatAgentClient(a).retry(room.roomId,{confirmed:true});assert.equal(replay.grantId,grantId);assert.equal(replay.state,'active');assert.equal(replay.hostRuntimeState,'unverified');assert.equal(writes,1);
  assert.equal((await foreign.list(room.roomId,{grantId})).state,'absent');
  await assert.rejects(a.api.call(`/v2/chat/rooms/${room.roomId}/agent-grant`,{grantId:crypto.randomUUID(),bindingId:b.api.snapshot().bindingId,mode:'read',expiresAt:f.now+3600}),/chat_agent_not_authorized/);
  const second=await client.grant(room.roomId,{bindingId:a.api.snapshot().bindingId,mode:'respond',primaryResponder:true,expiresAt:f.now+3600},{confirmed:true});
  const page=await client.list(room.roomId);assert.equal(page.items.filter(row=>row.primaryResponder).length,1);assert.equal(page.items.find(row=>row.primaryResponder).grantId,second.grantId);
  drop='/agent-revoke';await assert.rejects(client.revoke(room.roomId,grantId,{confirmed:true}),/lost Agent/);
  assert.equal((await createChatAgentClient(a).retry(room.roomId,{confirmed:true})).state,'revoked');
  const child=await a.chat.create({title:'获准工件子区',kind:'ai-subzone',parentRoomId:room.roomId},{confirmed:true});
  await assert.rejects(b.api.call(`/v2/chat/rooms/${child.roomId}/read`,{}),/chat_access_denied/);
  assert.equal((await client.list(child.roomId)).items.length,0);
  assert.equal((await a.api.call(`/v2/chat/rooms/${room.roomId}/read`,{})).independentMemberCount,2,'Agent permissions do not add members');
 }finally{a?.close();b?.close();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
