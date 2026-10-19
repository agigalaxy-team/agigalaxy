import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {createChatAgentClient} from '../../galaxy-web/src/chat-agent-client.mjs';
import {createNativeWatch} from '../../galaxy-edge-mcp/src/native-v2/watch.mjs';
import {nativeHttpDefinitions} from '../../galaxy-edge-mcp/src/native-v2/http-tools.mjs';

const store=()=>{const values=new Map();return{
 get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value)),
 update:async(key,change)=>{const next=change(structuredClone(values.get(key)));values.set(key,structuredClone(next));return structuredClone(next);},
};};
test('actual HTTP room scopes omit private device data and stopped watch retries only its original grant revocation',async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)});
 // This slice tests real current device/room authorization, not Account/OIDC.
 f.chat.requireAccountWithin=async()=>{};f.chat.consumeInviteWithin=async()=>{};f.chat.markInviteRespondedWithin=async()=>{};
 const api=createApi({...f,browserOrigins:['https://galaxy.example.org'],rateLimit:10000});const runtimes=[];
 let offlineRevoke=false,loseRevoke=false,revokeCalls=0,calls=0;
 try{
  await new Promise(r=>api.listen(0,'127.0.0.1',r));const local=`http://127.0.0.1:${api.address().port}`;
  const fetcher=async(url,options)=>{calls++;const path=new URL(url).pathname;
   if(path.endsWith('/agent-revoke')){revokeCalls++;if(offlineRevoke)throw Error('isolated offline revocation');}
   const response=await fetch(local+path,{...options,headers:{...options.headers,Origin:'https://galaxy.example.org'}});
   if(loseRevoke&&path.endsWith('/agent-revoke')){loseRevoke=false;assert.equal(response.status,200);throw Error('lost exact revoke receipt');}return response;
  };
  for(let i=0;i<3;i++){const runtime=await createExistingWebRuntime({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys},{store:store(),fetch:fetcher,now:()=>f.now});
   runtimes.push(runtime);await runtime.connect({confirmed:true});}
  const [a,b,c]=runtimes,owner=(await a.status()).identity.subjectId;
  const room=await a.chat.create({title:'Synthetic ordinary room; no task'},{confirmed:true});
  const invite=await a.chat.propose(room.roomId,{expectedRevision:room.revision,action:'invite',targetSubjectId:(await b.status()).identity.subjectId},{confirmed:true});
  await b.api.call(`/v2/chat/rooms/${room.roomId}/accept`,{decisionId:invite.decisionId,accept:true});
  const mine=createChatAgentClient(a),other=createChatAgentClient(b),outside=createChatAgentClient(c);
  const first=await mine.grant(room.roomId,{bindingId:a.api.snapshot().bindingId,mode:'respond',primaryResponder:true,expiresAt:f.now+3600},{confirmed:true});
  const second=await mine.grant(room.roomId,{bindingId:a.api.snapshot().bindingId,mode:'read',primaryResponder:false,expiresAt:f.now+3600},{confirmed:true});
  const page=await other.participants(room.roomId,{limit:1});assert.equal(page.items.length,1);assert.ok(page.next);
  const tail=await other.participants(room.roomId,{after:page.next,limit:1});assert.equal(tail.items.length,1);assert.equal(tail.next,null);
  const publicRows=[...page.items,...tail.items];assert.equal(publicRows.find(x=>x.grantId===first.grantId).subjectId,owner);
  assert.deepEqual(publicRows.find(x=>x.grantId===first.grantId).allowedActions,['read','draft','respond']);
  for(const row of publicRows){assert.equal(row.hostRuntimeState,'unverified');for(const key of ['bindingId','installationId','purpose','credentials'])assert.equal(Object.hasOwn(row,key),false);}
  assert.equal(JSON.stringify(publicRows).includes(a.api.snapshot().bindingId),false);
  assert.equal((await other.list(room.roomId,{grantId:first.grantId})).state,'absent','member projection never expands management query');
  await assert.rejects(outside.participants(room.roomId),/chat_access_denied/);
  await assert.rejects(b.api.call(`/v2/chat/rooms/${room.roomId}/agent-revoke`,{grantId:first.grantId}),/chat_access_denied/);
  await assert.rejects(b.api.call(`/v2/chat/rooms/${room.roomId}/agent-participants`,{subjectId:owner}),/invalid_chat_request/);
  const child=await a.chat.create({title:'Synthetic selected child',kind:'ai-subzone',parentRoomId:room.roomId},{confirmed:true});
  await assert.rejects(other.participants(child.roomId),/chat_access_denied/);
  const definitions=nativeHttpDefinitions(b.api);assert.equal((await definitions.galaxy_chat_agent_participants.run({roomId:room.roomId,limit:10})).items.length,2);
  const localStore=store(),watch=createNativeWatch({store:localStore,api:a.api,subjectId:owner,now:()=>f.now});
  const started=await watch.start({roomId:room.roomId,agentGrantId:first.grantId,purpose:'Only this synthetic room',expiresAt:f.now+600},{confirmed:true});const id=started.items[0].id;
  offlineRevoke=true;const offline=await watch.stop(id);assert.equal(offline.state,'stopped');assert.equal(offline.retryStopRequired,true);assert.equal(offline.remoteGrantRevoked,false);
  const before=calls;assert.equal((await watch.check(id)).state,'inactive');assert.equal(calls,before,'local stop is durable before remote revocation');
  assert.equal((await mine.list(room.roomId,{grantId:first.grantId})).items[0].state,'active');
  offlineRevoke=false;loseRevoke=true;const lost=await watch.stop(id);assert.equal(lost.authorizationState,'unconfirmed');
  assert.equal((await mine.list(room.roomId,{grantId:first.grantId})).items[0].state,'revoked');
  const revokedAt=(await f.db.query('SELECT revoked_at FROM chat_agent_grants WHERE grant_id=$1',[first.grantId])).rows[0].revoked_at;
  const reloaded=createNativeWatch({store:localStore,api:a.api,subjectId:owner,now:()=>f.now});
  const retried=await reloaded.stop(id);assert.equal(retried.remoteGrantRevoked,true);assert.equal(retried.retryStopRequired,false);assert.equal(retried.externalModelCancellation,'host-must-confirm');
  assert.deepEqual((await f.db.query('SELECT revoked_at FROM chat_agent_grants WHERE grant_id=$1',[first.grantId])).rows[0].revoked_at,revokedAt);
  const revokeCount=revokeCalls;await reloaded.stop(id);assert.equal(revokeCalls,revokeCount,'known receipt avoids another revoke');
  await assert.rejects(a.api.call(`/v2/chat/rooms/${room.roomId}/send`,{clientMessageId:randomUUID(),text:'Must not send',replyTo:null,agentGrantId:first.grantId}),/chat_agent_not_authorized/);
  assert.equal((await mine.list(room.roomId,{grantId:second.grantId})).items[0].state,'active','unrelated grant remains');
  const visible=(await other.participants(room.roomId)).items.find(x=>x.grantId===first.grantId);assert.equal(visible.state,'revoked');assert.deepEqual(visible.allowedActions,[]);
 }finally{for(const runtime of runtimes)runtime.close();await new Promise(r=>api.close(r));await f.db.close();}
});
