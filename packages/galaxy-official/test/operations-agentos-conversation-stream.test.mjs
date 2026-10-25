import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OperationsAgentOsClient} from '../src/operations-agentos-client.mjs';
import {browserConversationEvent,conversationStreamEvent,nativeSseFrames} from '../src/operations-agentos-conversation-stream.mjs';

test('private native SSE preserves exact indexed Unicode text on resume while excluding reasoning, tool payloads and aggregate/error content',async()=>{
 const runId=randomUUID(),operationId=randomUUID(),conversation={id:randomUUID(),sessionId:randomUUID(),domain:'governance',mode:'conversation'},encoder=new TextEncoder();
 const text='第一段：当前可核对。\n\n|项目|状态|\n|---|---|\n|公开资料|已取得|\n\n保持 Unicode 🌌 与完整段落。';
 const raw=[
  {event:'ReasoningContent',run_id:runId,event_index:1,content:'PRIVATE_REASONING'},
  {event:'RunContent',run_id:runId,event_index:2,content:'先核对当前对象。',content_type:'str',reasoning_content:'PRIVATE_REASONING',model_provider_data:{secret:'PRIVATE_PROVIDER'}},
  {event:'ToolCallStarted',run_id:runId,event_index:3,tool:{tool_args:'PRIVATE_ARGS',result:'PRIVATE_RESULT'}},
  {event:'ToolCallCompleted',run_id:runId,event_index:4,tool:{result:'PRIVATE_RESULT'}},
  {event:'RunContent',run_id:'another-run',event_index:5,content:'PRIVATE_OTHER_OWNER'},
  {event:'RunContent',run_id:runId,event_index:5,content:text.slice(0,11),content_type:'str'},
  {event:'RunContent',run_id:runId,event_index:6,content:text.slice(11),content_type:'str'},
  {event:'RunContentCompleted',run_id:runId,event_index:7,content:'PRIVATE_INTERMEDIATE_AGGREGATE'},
  {event:'RunCompleted',run_id:runId,event_index:8,content:'PRIVATE_NATIVE_AGGREGATE',messages:[{content:'PRIVATE_MESSAGES'}]},
 ];
 const wire=': keepalive\r\n\r\n'+raw.map(value=>'event: '+value.event+'\r\ndata: '+JSON.stringify(value)+'\r\n\r\n').join('');
 let fetches=0,cancelled=0,observedBody;
 const client=new OperationsAgentOsClient({url:'http://127.0.0.1:9999',signingKey:'synthetic-signing-key-'.repeat(3),now:()=>1988193660,fetchImpl:async(url,options)=>{
  fetches++;assert(url.endsWith('/agents/galaxy-conversation-governance/runs/'+runId+'/resume'));assert.equal(options.method,'POST');
  assert.equal(new URLSearchParams(options.body).get('session_id'),conversation.sessionId);assert.equal(new URLSearchParams(options.body).get('last_event_index'),'1');assert.equal(options.headers.accept,'text/event-stream');
  const bytes=encoder.encode(wire);let offset=0;
  observedBody=new ReadableStream({pull(controller){if(offset<bytes.length)controller.enqueue(bytes.slice(offset,++offset));else controller.close();},cancel(){cancelled++;}});
  return new Response(observedBody,{headers:{'content-type':'text/event-stream; charset=utf-8'}});
 }});
 const projected=[];for await(const event of client.conversationEvents(conversation,runId,{after:1}))projected.push(event);
 assert.equal(fetches,1);assert.equal(observedBody.locked,false,'closing a terminal observer releases its reader');assert(cancelled<=1);assert(!JSON.stringify(projected).includes('PRIVATE_'));
 assert.deepEqual(projected.map(x=>x.kind),['text','reset','phase','text','text','phase','terminal']);
 let visible='';for(const item of projected){if(item.kind==='reset')visible='';if(item.kind==='text')visible+=item.text;}assert.equal(visible,text,'no sentence, table, newline or Unicode clipping');
 assert.equal(projected.at(-1).status,'COMPLETED');assert(!Object.hasOwn(projected.at(-1),'content'),'final content must come from authoritative original-result GET');
 assert.equal(conversationStreamEvent({event:'RunContent',run_id:runId,event_index:6,content:'duplicate'},{runId,after:6}),null);
 assert.deepEqual(conversationStreamEvent({event:'RunContent',run_id:runId,content:'PRIVATE_UNINDEXED'},{runId}),{kind:'resync',eventIndex:null});
 assert.deepEqual(conversationStreamEvent({event:'ToolCallStarted',run_id:runId,tool:{arguments:'PRIVATE_UNINDEXED_RESET'}},{runId}),{kind:'resync',eventIndex:null});
 assert.deepEqual(conversationStreamEvent({event:'error',error:'PRIVATE_PROVIDER_ERROR'},{runId}),{kind:'resync',eventIndex:null});
 assert.equal(conversationStreamEvent({event:'RunContent',run_id:runId,event_index:9,content:{field:'PRIVATE_STRUCTURED'},content_type:'dict'},{runId}),null);
 const browser=projected.map(item=>browserConversationEvent({...item,operationId,readExpiresAt:1988193690,raw:'PRIVATE_UNKNOWN_FIELD'},operationId));
 assert(!JSON.stringify(browser).includes('PRIVATE_'));assert.equal(browserConversationEvent({...projected[0],operationId:'different-turn'},operationId),null);
 assert.deepEqual(browserConversationEvent({kind:'lease',operationId,readExpiresAt:1988193690,private:'PRIVATE'},operationId),{kind:'lease',operationId,readExpiresAt:1988193690,stopAvailable:false});
 assert.deepEqual(browserConversationEvent({kind:'blocked',operationId,private:'PRIVATE'},operationId),{kind:'blocked',operationId,eventIndex:null});
 const consume=async body=>{for await(const unused of nativeSseFrames(body)){void unused;}};
 await assert.rejects(consume(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([255,10]));controller.close();}})),{code:'operations_agentos_response_invalid'});
 await assert.rejects(consume(new ReadableStream({start(controller){controller.enqueue(encoder.encode('data: {"incomplete":true}'));controller.close();}})),{code:'operations_agentos_response_invalid'});
 await assert.rejects(consume(new ReadableStream({start(controller){controller.enqueue(encoder.encode('data: '+JSON.stringify({large:'x'.repeat(1024*1024)})+'\n\n'));controller.close();}})),{code:'operations_agentos_response_invalid'});
});
