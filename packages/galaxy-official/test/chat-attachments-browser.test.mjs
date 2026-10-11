import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createAttachmentsClient} from '../../galaxy-web/src/chat-attachments-client.mjs';
import {createChatClient} from '../../galaxy-web/src/chat-client.mjs';
import {attachmentContractFixture} from './chat-attachments-workflow.mjs';
const store=()=>{const m=new Map();return {get:async k=>structuredClone(m.get(k)),put:async(k,v)=>m.set(k,structuredClone(v)),update:async(k,updater)=>{const next=updater(structuredClone(m.get(k)));if(next&&typeof next.then==='function')throw Error('synchronous_update_required');m.set(k,structuredClone(next));return structuredClone(next);}};};
test('browser binary transfer recovers exact upload receipt and checks digest/current identity without exposing credentials',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),contract=attachmentContractFixture();
 Object.assign(f.attachments,contract);f.chat.requireAccountWithin=async()=>{};
 f.chat.transport={available:true,project:async()=>{},send:async x=>({archiveId:x.messageId})};
 const server=createApi({...f,browserOrigins:['https://galaxy.example.org'],rateLimit:1000});let runtime,drop=true,tamper=false,sends=0;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const fetcher=async(url,options)=>{const path=new URL(url).pathname,response=await fetch(base+path,{...options,headers:{...options.headers,Origin:'https://galaxy.example.org'}});
   if(path.endsWith('/upload')){sends++;if(drop){drop=false;assert.equal(response.status,200);throw new Error('synthetic lost upload response');}}
   if(tamper&&path.endsWith('/content'))return new Response('changed',{status:200,headers:response.headers});return response;};
  const state=store();runtime=await createWebRuntime({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys},{store:state,fetch:fetcher,now:()=>f.now});
  await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
  const room=await runtime.chat.create({title:'File browser workflow'},{confirmed:true}),files=createAttachmentsClient(runtime),file=new File(['actual browser upload body'],'sample.txt',{type:'text/plain'});
  await assert.rejects(files.send(room.roomId,file,{confirmed:true}),/lost upload/);const original=await files.pending(room.roomId);assert.ok(original.input.sha256);assert.equal(original.bytes,undefined);
  await assert.rejects(files.retry(room.roomId,new File(['wrong'],'sample.txt',{type:'text/plain'}),{confirmed:true}),/不一致/);
  const replay=await createAttachmentsClient(runtime).retry(room.roomId,file,{confirmed:true});assert.equal(replay.state,'scan-pending');assert.equal(sends,1,'Lost reply recovers metadata without a second upload');
  await f.attachments.scanPending();const item=await files.read(original.input.attachmentId);
  const sent=await runtime.chat.send(room.roomId,'selected file',{confirmed:true,attachments:[{id:item.attachmentId,sha256:item.sha256}]});assert.equal(sent.state,'accepted');
  const bytes=await files.download(item);assert.equal(new TextDecoder().decode(bytes),'actual browser upload body');
  tamper=true;await assert.rejects(files.download(item),/integrity/);tamper=false;
  await assert.rejects(runtime.api.attachmentTransfer('https://other.example.org'),/Invalid attachment/);
  await files.revoke(room.roomId,item.attachmentId);await assert.rejects(files.download(item),/attachment_content_unavailable/);
  assert.equal((await createChatClient(runtime).pending(room.roomId)),null);
 }finally{runtime?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.db.close();}
});
