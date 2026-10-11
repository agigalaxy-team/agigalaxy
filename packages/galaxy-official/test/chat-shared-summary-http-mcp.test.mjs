import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createPersonalMcp} from '../src/personal-mcp.mjs';
import {createChatSharedSummaryClient} from '../src/chat-shared-summary-client.mjs';
import {invite} from './chat-workflow.mjs';
test('shared HTTP client and actual MCP tool transport preserve explicit room publication',async()=>{
 const f=await serviceFixture(['binding','notifications']),peer=await serviceFixture(['binding','notifications'],f.db,{migrateDatabase:false}),bodies=new Map();
 f.chat.requireAccountWithin=async()=>{};f.chat.consumeInviteWithin=async()=>{};f.chat.markInviteRespondedWithin=async()=>{};
 f.chat.transport={available:true,project:async()=>{},send:async x=>{bodies.set(x.messageId,{archiveId:x.messageId,text:x.text,revision:1});return{archiveId:x.messageId};},read:async x=>x.ids.map(id=>bodies.get(id)),erase:async x=>{bodies.delete(x.messageId);return{archiveDeleted:true};}};
 const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 // The actor was authenticated by the fixture's real binding/session workflow.
 // This isolated MCP transport is not an OAuth-provider integration claim.
 const mcp=createServer(async(req,res)=>{const server=createPersonalMcp(f,peer.actor),transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  try{await server.connect(transport);await transport.handleRequest(req,res);}finally{await server.close();}});
 await new Promise(resolve=>mcp.listen(0,'127.0.0.1',resolve));const model=new Client({name:'summary-contract-test',version:'1'});
 try{const roomId=randomUUID();await f.chat.create(f.actor,{roomId,operationId:randomUUID(),title:'Actual HTTP summary entry'});await invite(f.chat,f.actor,roomId,peer.actor);
  const sent=await f.chat.send(f.actor,roomId,{clientMessageId:randomUUID(),text:'Selected original source'}),ref={messageId:sent.messageId,revision:1};
  const origin='http://127.0.0.1:'+api.address().port,call=async(path,input)=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+peer.credential},body:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw new Error(body.error);return body;};
  const client=createChatSharedSummaryClient({call}),request={shareId:randomUUID(),roomId,expectedMemberRevision:2,audience:'room-authorized-members',content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'1',complete:false},fragments:[],keyMessageRefs:[ref]}};
  assert.equal((await client.publish(request)).state,'published');assert.equal((await client.get({roomId,shareId:request.shareId})).sourceFacts[0].authorId,f.actor.subjectId);
  await assert.rejects(client.publish({...request,subjectId:f.actor.subjectId}),/invalid_shared_summary/);
  await model.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+mcp.address().port)));
  const names=(await model.listTools()).tools.map(t=>t.name);assert(names.includes('galaxy_chat_shared_summary_publish'));assert(names.includes('galaxy_personal_summary_preferences'));assert(names.includes('galaxy_inbox_query'));assert(!names.includes('galaxy_inbox_mark_read'));
  const invoke=async(name,input)=>{const result=await model.callTool({name,arguments:input});return{...result,value:result.isError?null:JSON.parse(result.content[0].text)};};
  assert.equal((await invoke('galaxy_personal_summary_preferences',{})).value.enabled,false);
  const noGrant=await invoke('galaxy_chat_shared_summary_publish',{...request,shareId:randomUUID()});assert.equal(noGrant.isError,true);
  const grantId=randomUUID();await f.chat.grantAgent(peer.actor,roomId,{grantId,bindingId:peer.actor.bindingId,mode:'respond',expiresAt:f.chat.now()+3600});
  const published=await invoke('galaxy_chat_shared_summary_publish',{...request,shareId:randomUUID(),agentGrantId:grantId});assert.equal(published.isError,undefined);assert.equal(published.value.state,'published');
  const message=(await f.chat.history(f.actor,roomId)).messages.find(m=>m.messageId===published.value.messageId);assert.equal(message.actorKind,'agent');
  assert.equal((await invoke('galaxy_inbox_query',{})).value.deliveryConfirmed,false);
  await client.retract({roomId,shareId:request.shareId});assert.equal((await client.get({roomId,shareId:request.shareId})).state,'retracted');
 }finally{await model.close();mcp.closeAllConnections();api.closeAllConnections();await Promise.all([new Promise(resolve=>mcp.close(resolve)),new Promise(resolve=>api.close(resolve))]);await f.db.close();}
});
