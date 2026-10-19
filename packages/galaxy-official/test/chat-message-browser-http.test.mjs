import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {nativeHttpDefinitions} from '../../galaxy-edge-mcp/src/native-v2/http-tools.mjs';
import {createPersonalMcp} from '../src/personal-mcp.mjs';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {createServer} from 'node:http';

test('real browser runtime reload restores full authorized history and reconciles the original lost send after leaving',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),rows=new Map(),bodies=new Map(),store={get:async key=>structuredClone(rows.get(key)),put:async(key,value)=>rows.set(key,structuredClone(value)),
  update:async(key,change)=>{const next=change(structuredClone(rows.get(key)));if(next?.then)throw Error('local_update_async_callback');const committed=structuredClone(next);rows.set(key,committed);return structuredClone(committed);}};
 f.chat.requireAccountWithin=async()=>{};f.chat.consumeInviteWithin=async()=>{};f.chat.markInviteRespondedWithin=async()=>{};
 let sends=0,reads=0;f.chat.transport={available:true,project:async()=>{},send:async input=>{sends++;bodies.set(input.messageId,{archiveId:input.messageId,text:input.text,revision:1});return{archiveId:input.messageId};},read:async input=>{reads++;return input.ids.flatMap(id=>bodies.has(id)?[bodies.get(id)]:[]);}};
 const server=createApi({...f,browserOrigins:['https://galaxy.example.org'],rateLimit:1000});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const mcp=createServer(async(req,res)=>{const product=createPersonalMcp(f,f.actor),transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});try{await product.connect(transport);await transport.handleRequest(req,res);}finally{await product.close();}});
 await new Promise(resolve=>mcp.listen(0,'127.0.0.1',resolve));const model=new Client({name:'ordinary-receipt-test',version:'1'});let runtime,drop=true;
 try{const base='http://127.0.0.1:'+server.address().port,fetcher=async(url,options)=>{const path=new URL(url).pathname,response=await fetch(base+path,{...options,headers:{...options.headers,Origin:'https://galaxy.example.org'}});
   if(path.endsWith('/send')&&drop){drop=false;assert.equal(response.status,200);throw new Error('synthetic_lost_send_http_ack');}return response;},config={endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys},runtimeOptions={store,fetch:fetcher,now:()=>f.now};
  runtime=await createExistingWebRuntime(config,runtimeOptions);await runtime.connect({confirmed:true});
  const room=await runtime.chat.create({title:'Synthetic ordinary restored history'},{confirmed:true}),decisionId=randomUUID();await runtime.api.call(`/v2/chat/rooms/${room.roomId}/propose`,{decisionId,expectedRevision:room.revision,action:'invite',targetSubjectId:f.actor.subjectId});await f.chat.acceptInvite(f.actor,room.roomId,{decisionId});
  await assert.rejects(runtime.chat.send(room.roomId,'Original ordinary selected message',{confirmed:true}),/synthetic_lost_send_http_ack/);const original=await runtime.chat.pending(room.roomId);assert.ok(original.requestHash);const subjectId=runtime.api.snapshot().subjectId;
  runtime.close();runtime=await createExistingWebRuntime(config,runtimeOptions);await runtime.connect({confirmed:true});assert.equal(runtime.api.snapshot().subjectId,subjectId);
  const restored=await runtime.chat.pending(room.roomId);assert.equal(restored.input.clientMessageId,original.input.clientMessageId);assert.equal(sends,1,'Reload does not automatically resend');
  const history=await runtime.api.call(`/v2/chat/rooms/${room.roomId}/history`,{});assert.equal(history.complete,true);assert.equal(history.messages[0].text,original.input.text);assert.deepEqual((await f.chat.history(f.actor,room.roomId)).messages.map(x=>x.messageId),history.messages.map(x=>x.messageId));
  await runtime.disconnect();await runtime.connect({confirmed:true});assert.equal((await runtime.chat.pending(room.roomId)).requestHash,original.requestHash,'Same runtime can explicitly reconnect, with a fresh per-operation lease');
  await runtime.api.call(`/v2/chat/rooms/${room.roomId}/leave`,{});await assert.rejects(runtime.api.call(`/v2/chat/rooms/${room.roomId}/receipt`,{clientMessageId:original.input.clientMessageId}),/chat_access_denied/);
  const before={sends,reads},query={roomId:room.roomId,clientMessageId:original.input.clientMessageId,requestHash:original.requestHash};
  const native=await nativeHttpDefinitions(runtime.api).galaxy_chat_message_status.run(query);assert.equal(native.state,'accepted');assert.equal(native.contentReturned,false);
  const receipt=await runtime.chat.retry(room.roomId,{confirmed:true});assert.equal(receipt.state,'accepted');assert.equal(receipt.currentAccessGranted,false);assert.equal(await runtime.chat.pending(room.roomId),null);assert.deepEqual({sends,reads},before);
  await model.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+mcp.address().port)));const foreign=await model.callTool({name:'galaxy_chat_message_status',arguments:query});assert.equal(foreign.isError,undefined);assert.equal(JSON.parse(foreign.content[0].text).state,'absent');
 }finally{runtime?.close();await model.close();server.closeAllConnections();mcp.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>mcp.close(resolve))]);await f.db.close();}
});
