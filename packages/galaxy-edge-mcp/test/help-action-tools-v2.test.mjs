import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {registerHelpTools} from '../src/help-tools-v2.mjs';
import {createNativeToolServer} from '../src/native-v2/server.mjs';

const value=result=>JSON.parse(result.content[0].text);
function fixture(){let calls=0;const sessionId=randomUUID(),operationId=randomUUID(),payload={event:{kind:'invite',recipientId:'GUID'+'B'.repeat(28),message:'isolated exact invitation'}};
 const payloadJson=JSON.stringify(payload),payloadHash=createHash('sha256').update(payloadJson).digest('hex');
 const preview={operationId,payloadHash,state:'prepared',recipientIds:[payload.event.recipientId],visibility:'Private',materials:[],payload};
 const flow={start:async()=>({}),review:async()=>({offers:[]}),prepareAction:async()=>preview,actionPreview:async()=>preview,
  executeAction:async()=>{if(preview.state!=='acknowledged'){calls++;preview.state='acknowledged';}return{receipt:{state:'acknowledged',eventId:operationId},currentPermissionEstablished:false};},
  reconcileAction:async()=>({receipt:{state:'absent'},automaticallyRetried:false})};
 return{sessionId,operationId,payloadJson,payloadHash,preview,flow,calls:()=>calls};}
function wire(){const pending=new Map();let id=0;return{start:async()=>{},close:async()=>{},send:async m=>{pending.get(m.id)?.(m);pending.delete(m.id);},call(method,params){const requestId=++id;return new Promise(resolve=>{pending.set(requestId,resolve);this.onmessage({jsonrpc:'2.0',id:requestId,method,params});});},notify(){this.onmessage({jsonrpc:'2.0',method:'notifications/initialized'});}};}
test('ordinary help tools return exact preview and fail closed without a user review capability',async()=>{
 const f=fixture(),tools=new Map();registerHelpTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{flow:f.flow});
 const prepared=value(await tools.get('galaxy_help_prepare_action')({sessionId:f.sessionId,kind:'task-event',payloadJson:f.payloadJson}));
 assert.deepEqual(prepared.payload,f.preview.payload);assert.deepEqual(prepared.recipientIds,f.preview.recipientIds);
 const blocked=value(await tools.get('galaxy_help_execute_action')({sessionId:f.sessionId,operationId:f.operationId,payloadHash:f.payloadHash},{}));
 assert.equal(blocked.error,'help_exact_authorization_unavailable');assert.equal(f.calls(),0);
 const reconciled=value(await tools.get('galaxy_help_reconcile_action')({sessionId:f.sessionId,operationId:f.operationId}));assert.equal(reconciled.automaticallyRetried,false);assert.equal(f.calls(),0);
});
test('ordinary help execution carries the renewed exact authorization nonce and rejects stale choices before review',async()=>{
 const f=fixture(),tools=new Map(),authorizationRequestId=randomUUID();let reviews=0,submitted;
 f.preview.authorizationRequestId=authorizationRequestId;f.flow.executeAction=async(_id,input)=>{submitted=input;return{receipt:{eventId:f.operationId,state:'acknowledged'}};};
 registerHelpTools({registerTool:(name,_config,handler)=>tools.set(name,handler)},{flow:f.flow,review:async(_name,input,_ctx,run)=>{reviews++;assert.equal(input.preview.authorizationRequestId,authorizationRequestId);return{content:[{type:'text',text:JSON.stringify(await run())}]};}});
 const input={sessionId:f.sessionId,operationId:f.operationId,payloadHash:f.payloadHash};
 const missing=value(await tools.get('galaxy_help_execute_action')(input,{}));assert.equal(missing.error,'help_authorization_preview_changed');assert.equal(reviews,0);assert.equal(submitted,undefined);
 const wrong=value(await tools.get('galaxy_help_execute_action')({...input,authorizationRequestId:randomUUID()},{}));assert.equal(wrong.error,'help_authorization_preview_changed');assert.equal(reviews,0);
 const accepted=value(await tools.get('galaxy_help_execute_action')({...input,authorizationRequestId},{}));assert.equal(accepted.receipt.eventId,f.operationId);assert.equal(submitted.authorizationRequestId,authorizationRequestId);assert.equal(submitted.operationId,f.operationId);assert.equal(reviews,1);
});
test('native ordinary MCP fallback reviews exact recipients and content, then returns original ACK without another approval',async()=>{
 const f=fixture(),records=new Map(),runtime={website:'https://example.org',now:()=>1000,status:async()=>({identity:'GUID'+'A'.repeat(28)}),
  store:{get:async k=>records.get(k),put:async(k,v)=>records.set(k,v)},navigation:{open:async()=>({})},api:{endpoint:'https://example.org',snapshot:()=>null,call:async()=>({})},helpFlow:f.flow};
 const server=createNativeToolServer(runtime),transport=wire();await server.connect(transport);
 await transport.call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'isolated-no-ui-host',version:'1'}});transport.notify();
 try{
  const input={sessionId:f.sessionId,operationId:f.operationId,payloadHash:f.payloadHash};
  const wrong=await transport.call('tools/call',{name:'galaxy_help_execute_action',arguments:{...input,payloadHash:'b'.repeat(64)}});
  assert.equal(value(wrong.result).error,'help_action_preview_changed');assert.equal(f.calls(),0);
  const first=value((await transport.call('tools/call',{name:'galaxy_help_execute_action',arguments:input})).result);
  assert.equal(first.state,'user-choice-needs-browser');assert.equal(f.calls(),0);
  const html=await(await fetch(first.url)).text();assert.ok(html.includes(f.preview.recipientIds[0]));assert.ok(html.includes('isolated exact invitation'));
  await fetch(first.url,{method:'POST',headers:{origin:new URL(first.url).origin,'content-type':'application/x-www-form-urlencoded'},body:'action=allow'});
  const submitted=value((await transport.call('tools/call',{name:'galaxy_help_execute_action',arguments:input})).result);assert.equal(submitted.receipt.state,'acknowledged');assert.equal(f.calls(),1);
  const repeated=value((await transport.call('tools/call',{name:'galaxy_help_execute_action',arguments:input})).result);assert.equal(repeated.receipt.eventId,f.operationId);assert.equal(f.calls(),1,'ACK lookup returns the same original receipt without resubmission');
 }finally{await server.close();}
});
