import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createPersonalMcp} from '../src/adapters/mcp/personal/handler.mjs';
import {createChatSharedSummaryClient,sharedSummaryRequestHash} from "../src/clients/chat-shared-summary.mjs";
import {serviceAccessV2} from '../src/operations/service-access-v2.mjs';
import {nativeHttpDefinitions} from '../../galaxy-edge-mcp/src/native-v2/tools/http.mjs';
import {invite} from './chat-workflow.mjs';

test('lost HTTP publication acknowledgement survives source withdrawal and departure through ordinary MCP and native receipt adapters',async()=>{
 const f=await serviceFixture(['binding']),peer=await serviceFixture(['binding'],f.db,{migrateDatabase:false}),bodies=new Map();let sends=0,reads=0,erases=0;
 f.chat.requireAccountWithin=async()=>{};f.chat.consumeInviteWithin=async()=>{};f.chat.markInviteRespondedWithin=async()=>{};
 // Actual HTTP, database and MCP transports; the external MAM and verified-account
 // adapter are explicit contract doubles, not a running Prosody or account proof.
 f.chat.transport={available:true,project:async()=>{},send:async input=>{sends++;bodies.set(input.messageId,{archiveId:input.messageId,text:input.text,revision:1});return{archiveId:input.messageId};},
  read:async input=>{reads++;return input.ids.flatMap(id=>bodies.has(id)?[bodies.get(id)]:[]);},erase:async input=>{erases++;bodies.delete(input.messageId);return{archiveDeleted:true};}};
 const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const mcp=createServer(async(req,res)=>{const server=createPersonalMcp(f,peer.actor),transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  try{await server.connect(transport);await transport.handleRequest(req,res);}finally{await server.close();}});
 await new Promise(resolve=>mcp.listen(0,'127.0.0.1',resolve));const model=new Client({name:'share-continuity-test',version:'1'});
 try{const roomId=randomUUID();await f.chat.create(f.actor,{roomId,operationId:randomUUID(),title:'Synthetic continuity via real transports'});await invite(f.chat,f.actor,roomId,peer.actor);
  const source=await f.chat.send(f.actor,roomId,{clientMessageId:randomUUID(),text:'Selected source body'}),ref={messageId:source.messageId,revision:1};
  const request={shareId:randomUUID(),roomId,expectedMemberRevision:2,audience:'room-authorized-members',content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'1',complete:false},
   fragments:[{id:randomUUID(),kind:'derived',text:'Selected source-derived private explanation',sourceRefs:[ref]}],keyMessageRefs:[ref]}};
  const origin='http://127.0.0.1:'+api.address().port,calls=[];let losePublicationAck=true;
  const transport=async(path,input,credential=peer.credential)=>{calls.push({path,input});const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential},body:JSON.stringify(input)});
   const body=await response.json();if(!response.ok)throw new Error(body.error);return body;};
  const call=async(path,input)=>{const body=await transport(path,input);if(path.endsWith('/publish')&&losePublicationAck){losePublicationAck=false;throw new Error('synthetic_lost_http_ack_after_commit');}return body;};
  const client=createChatSharedSummaryClient({call}),query={roomId,shareId:request.shareId,requestHash:await sharedSummaryRequestHash(request)};
  await assert.rejects(client.publish(request),/synthetic_lost_http_ack_after_commit/);
  await f.chat.retract(f.actor,roomId,source.messageId);await f.sharedSummaries.purgeInvalidSources();await call(`/v2/chat/rooms/${roomId}/leave`,{});
  await assert.rejects(client.get({roomId,shareId:request.shareId}),/chat_access_denied/);
  const before={sends,reads,erases},receipt=await client.receipt(query);assert.equal(receipt.state,'published');assert.equal(receipt.currentAccessGranted,false);assert.equal(receipt.contentReturned,false);assert.equal(receipt.othersReadStatus,'not-asserted');
  assert.equal(JSON.stringify(receipt).includes(request.content.fragments[0].text),false);
  await model.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+mcp.address().port)));
  const tools=(await model.listTools()).tools;assert.equal(tools.find(x=>x.name==='galaxy_chat_shared_summary_receipt').annotations.readOnlyHint,true);
  const result=await model.callTool({name:'galaxy_chat_shared_summary_receipt',arguments:query});assert.equal(result.isError,undefined);assert.deepEqual(JSON.parse(result.content[0].text),receipt);
  const definition=nativeHttpDefinitions({call}).galaxy_chat_shared_summary_receipt;assert.equal(definition.write,false);assert.deepEqual(await definition.run(query),receipt);
  assert.equal((await transport('/v2/chat/shared-summaries/receipt',query,f.credential)).state,'absent');
  assert.equal((await client.receipt({...query,requestHash:'0'.repeat(64)})).state,'conflict');
  assert.deepEqual({sends,reads,erases},before,'Receipt projections never resend or fetch old MAM bodies');
  assert.equal(calls.filter(x=>x.path==='/v2/chat/shared-summaries/publish').length,1,'A committed unknown publication is never retried after leaving');
  assert.equal(serviceAccessV2('POST','/v2/chat/shared-summaries/receipt'),'read');assert.equal(serviceAccessV2('POST','/v2/chat/shared-summaries/retract'),'stop');assert.equal(serviceAccessV2('POST','/v2/chat/shared-summaries/publish'),null);
 }finally{await model.close();mcp.closeAllConnections();api.closeAllConnections();await Promise.all([new Promise(resolve=>mcp.close(resolve)),new Promise(resolve=>api.close(resolve))]);await f.db.close();}
});
