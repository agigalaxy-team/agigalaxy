import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createCompactController} from './controller.mjs';
import {panelResult,componentResult} from './result.mjs';
import {readableContent} from './presentation.mjs';
import {syntheticMessageTransport} from './purpose-fixture.mjs';

test('current native conversation reads real history, preserves a private reply, sends once and reconciles a lost reply automatically',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-native-purpose-'));let api,runtime,controller;
 let drop=false,sendCalls=0;
 try{
  api=createApi({...f,rateLimit:1000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname;if(path.endsWith('/send'))sendCalls++;const result=await fetch(base+path,options);
    if(drop&&path.endsWith('/send')&&result.status===200){drop=false;throw Error('synthetic_lost_message_ack');}return result;},openBrowser:async()=>({launched:true})});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});
  const subjectId=runtime.api.snapshot().subjectId;f.chat.requireAccountWithin=async(_tx,actor)=>assert.equal(actor.subjectId,subjectId);f.chat.transport=syntheticMessageTransport();
  const roomId=randomUUID();await runtime.api.call('/v2/chat/rooms/create',{roomId,operationId:randomUUID(),title:'合成：继续文档解析工作',kind:'ordinary',taskRefs:[],retentionDays:90});
  controller=createCompactController(runtime);const view=await controller.show({object:{kind:'room',id:roomId},origin:{host:'synthetic-purpose-host',workRef:'private-original-work'}});
  assert.equal(view.source.conversation.canReply,false);assert.deepEqual(view.source.conversation.messages,[]);
  await assert.rejects(controller.sendMessage({viewId:view.viewId,clientMessageId:randomUUID(),text:'尚无授权，不发送'}),/chat_agent_not_authorized/);assert.equal(sendCalls,0);
  const grantId=randomUUID();await runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-grant',{grantId,bindingId:runtime.api.snapshot().bindingId,mode:'respond',primaryResponder:false,expiresAt:f.now+3600});
  const ready=await controller.refresh({viewId:view.viewId});assert.equal(ready.source.conversation.canReply,true);
  const unsent='PRIVATE_UNSENT_REPLY_IN_THIS_DEVICE';const saved=await controller.saveReply({viewId:view.viewId,expectedRevision:0,draft:unsent}),projected=panelResult(saved);
  assert.ok(!JSON.stringify(projected.content).includes(unsent));assert.ok(!JSON.stringify(projected.structuredContent).includes(unsent));assert.equal(componentResult(projected).replyDraft.text,unsent);
  const first={viewId:view.viewId,clientMessageId:randomUUID(),text:'合成：先核对解析错误。'};
  const sent=await controller.sendMessage(first);assert.equal(sent.messageResult.state,'accepted');assert.equal(sent.source.conversation.messages.at(-1).text,first.text);assert.equal(sent.source.conversation.messages.at(-1).authorLabel,'我');
  await controller.sendMessage(first);assert.equal(sendCalls,1);
  drop=true;const second={viewId:view.viewId,clientMessageId:randomUUID(),text:'合成：丢失响应也不重复发送。'};
  const recovered=await controller.sendMessage(second);assert.equal(recovered.messageResult.state,'accepted');assert.equal(sendCalls,2);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM chat_message_refs')).rows[0].n,2);
  const opened=await controller.open({viewId:view.viewId});assert.equal(opened.targetPath,'/app/rooms/'+roomId);
  const returned=await controller.resume({viewId:view.viewId,navigationId:opened.navigationId});assert.equal(returned.viewId,view.viewId);assert.equal(returned.replyDraft.text,unsent);assert.equal(returned.source.conversation.messages.length,2);
  await runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-revoke',{grantId});
  await assert.rejects(controller.sendMessage({viewId:view.viewId,clientMessageId:randomUUID(),text:'撤销后不发送'}),/chat_agent_not_authorized/);assert.equal(sendCalls,2);
  await runtime.api.call('/v2/chat/rooms/'+roomId+'/leave',{});const unavailable=await controller.refresh({viewId:view.viewId});assert.equal(unavailable.source,null);assert.ok(unavailable.sourceError);assert.equal(unavailable.replyDraft.text,unsent);assert.ok(!JSON.stringify(unavailable).includes(second.text));
 }finally{controller?.close();runtime?.close();if(api?.listening)await new Promise(ok=>api.close(ok));await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-purpose-'));await rm(target,{recursive:true,force:true});}
});

test('human content uses authored material and keeps internal references out of the normal presentation',()=>{
 const taskId=randomUUID(),operationId=randomUUID(),raw={operationId,taskId,title:'当前请求',summary:'具体要获得的帮助',workContext:{goal:'检查一个错误',currentSituation:'已有最小输入',attemptRefs:[{attemptId:randomUUID()}]},payloadHash:'a'.repeat(64),authorizationContext:{bindingId:randomUUID()}};
 const rows=readableContent(raw);assert.deepEqual(rows.map(r=>r.text),['当前请求','具体要获得的帮助','检查一个错误','已有最小输入']);
 const result=panelResult({schemaVersion:1,viewId:randomUUID(),source:{title:raw.title,summary:raw.summary,source:{taskId}},draft:{text:'PRIVATE_NOTE',revision:1,scope:'this-device-only'},replyDraft:{text:'PRIVATE_REPLY',revision:1,scope:'this-device-only'}});
 assert.equal(result.content[0].text,'当前请求\n\n具体要获得的帮助');assert.ok(!JSON.stringify(result.content).includes(taskId));assert.ok(!JSON.stringify(result.structuredContent).includes('PRIVATE_NOTE'));assert.ok(!JSON.stringify(result.structuredContent).includes('PRIVATE_REPLY'));
});
