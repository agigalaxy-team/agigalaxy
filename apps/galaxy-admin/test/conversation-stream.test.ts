import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationEventStream,parseConversationStreamEvent} from "../src/lib/workbench/conversation-stream";
import {operationsProxyPolicy,operationsReadPath} from '../src/lib/proxy-policy.mjs';

test('browser stream reads exact indexed Unicode once and admits only original-turn closed routes and fields',async()=>{
 const operationId='10000000-1111-4111-8111-111111111111',encoder=new TextEncoder(),text='完整段落 🌌\n\n|项目|结果|\n|---|---|\n|原请求|保持|';
 const records=[{kind:'lease',operationId,readExpiresAt:1988193690,stopAvailable:true},
  {kind:'text',operationId,eventIndex:2,text:'不得重播'},
  {kind:'text',operationId,eventIndex:3,text:text.slice(0,6),reasoning:'PRIVATE_REASONING',arguments:'PRIVATE_ARGS'},
  {kind:'text',operationId,eventIndex:3,text:'duplicate'},
  {kind:'text',operationId:'another-turn',eventIndex:4,text:'PRIVATE_OTHER_TURN'},
  {kind:'text',operationId,eventIndex:4,text:text.slice(6)},
  {kind:'terminal',operationId,eventIndex:5,status:'COMPLETED',content:'PRIVATE_AGGREGATE'}];
 const wire=': keepalive\r\n\r\n'+records.map(row=>'event: message\r\ndata: '+JSON.stringify(row)+'\r\n\r\n').join(''),bytes=encoder.encode(wire);
 let requests=0;const events=[];
 const fetchImpl:typeof fetch=async(input,options)=>{
  requests++;assert.equal(String(input),'/v1/operations/agentos/conversations/governance/operations/'+operationId+'/events?after=2');assert.equal(options?.method,'GET');assert.equal(options?.credentials,'same-origin');assert.equal(options?.body,undefined);
  let cursor=0;return new Response(new ReadableStream({pull(controller){if(cursor<bytes.length)controller.enqueue(bytes.slice(cursor,++cursor));else controller.close();}}),{headers:{'content-type':'text/event-stream; charset=utf-8'}});
 };
 for await(const event of conversationEventStream('governance',operationId,{after:2,signal:new AbortController().signal,fetchImpl}))events.push(event);
 assert.equal(requests,1);assert.deepEqual(events.map(event=>event.kind),['lease','text','text','terminal']);assert.equal(events.filter(event=>event.kind==='text').map(event=>event.text).join(''),text);assert(!JSON.stringify(events).includes('PRIVATE_'));
 assert.deepEqual(parseConversationStreamEvent({kind:'blocked',operationId,reason:'PRIVATE'},operationId),{kind:'blocked',operationId,eventIndex:null});
 assert.equal(parseConversationStreamEvent({kind:'text',operationId,eventIndex:null,text:'unindexed'},operationId),null);
 const broken:typeof fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([255,10,10]));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
 await assert.rejects(async()=>{for await(const unused of conversationEventStream('governance',operationId,{signal:new AbortController().signal,fetchImpl:broken}))void unused;},{code:'operations_agentos_response_invalid'});
 const origin='https://admin.synthetic.invalid',base='/v1/operations/agentos/conversations/governance/operations/'+operationId;
 const policy=(suffix:string,method='GET',requestOrigin:string|null=origin)=>operationsProxyPolicy({url:origin+base+suffix,method,headers:new Headers(requestOrigin?{origin:requestOrigin}:{'sec-fetch-site':'same-origin'}),publicOrigin:origin});
 assert.equal(policy('/events?after=3').allowed,true);assert.equal(policy('/cancel','POST').allowed,true);
 for(const suffix of['/events?after=3&after=4','/events?after=-1','/events?after=1&session_id=other','/cancel?after=1'])assert.equal(policy(suffix,suffix.startsWith('/cancel')?'POST':'GET').allowed,false);
 assert.equal(policy('/cancel').allowed,false);assert.equal(policy('/events','POST').allowed,false);assert.equal(policy('/cancel','POST',null).allowed,false);assert.equal(policy('/events','GET','https://other.invalid').allowed,false);
 assert.equal(operationsReadPath(base+'/events?after=0'),true);assert.equal(operationsReadPath(base+'/events?stream=true'),false);
 const existingUserReceipt='/v1/operations/users/'+operationId+'/operations/'+operationId;
 assert.equal(operationsReadPath(existingUserReceipt),true,'the already deployed 55 original-user-operation read closure is retained');
 assert.equal(operationsReadPath(existingUserReceipt+'?query=anything'),false);
});
