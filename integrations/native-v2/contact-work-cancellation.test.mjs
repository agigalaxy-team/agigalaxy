import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeChoice} from '../../packages/galaxy-edge-mcp/src/native-v2/interaction/choice.mjs';
import {createNativeContactWork,registerNativeContactWorkTools} from './contact-work-tools.mjs';
import {createContactPurposeFixture,purposeData} from '../host-adapters/opencode-stable/contact-purpose-fixture.mjs';

test('a canceled Native choice archives only its untouched draft; expiry, unknown delivery and a recipient decline retain distinct original operations',{timeout:60000},async()=>{
 const f=await createContactPurposeFixture();let choice;
 try{
  const handlers=new Map(),server={server:{getClientCapabilities:()=>({elicitation:{form:{}}})},registerTool:(name,_configuration,handler)=>handlers.set(name,handler)};
  choice=createNativeChoice({identity:()=>f.sender.subjectId,website:'https://selected.example',store:f.sender.runtime.store});
  let decision='cancel',reviews=0;
  const flow=registerNativeContactWorkTools(server,{runtime:f.sender.runtime,review:async(name,input,ctx,operation)=>{
   reviews++;
   if(decision==='unknown')return{content:[{type:'text',text:JSON.stringify({state:'unknown',sideEffect:false})}]};
   if(decision==='expired')throw Object.assign(Error('native_choice_changed_or_expired'),{code:'native_choice_changed_or_expired'});
   return choice.run(server,name,input,ctx,operation);
  }});
  // Real Native form-choice contract and local signed HTTP, not Browser or
  // physical TUI evidence. Declining never invokes the operation callback.
  const ctx={mcpReq:{elicitInput:async()=>({action:'decline'})}},execute=handle=>handlers.get('galaxy_contact_work_execute')({handle},ctx);
  const context={kind:'ephemeral',title:'表格提取',functions:['表格提取']},item=purposeData(await f.sender.call('galaxy_discovery_v2_query',{context,purposes:['conversation']})).items[0];
  const prepare=note=>flow.prepare({action:'send',context,opportunityRef:item.opportunityRef,purpose:'conversation',note});
  const key=handle=>'native-contact-work:'+f.sender.runtime.api.endpoint+':'+f.sender.subjectId+':'+handle;
  const canceled=await prepare('合成：保留这份原稿，但取消本次发送。'),original=await f.sender.runtime.store.get(key(canceled.handle));
  assert.equal(purposeData(await execute(canceled.handle)).state,'canceled');
  assert.equal((await flow.status(canceled.handle)).state,'canceled');
  assert.equal((await flow.pending()).items.some(row=>row.handle===canceled.handle),false);
  const retained=await f.sender.runtime.store.get(key(canceled.handle));
  assert.equal(retained.payloadJson,original.payloadJson);assert.equal(retained.payloadHash,original.payloadHash);assert.equal(retained.consentRequestId,original.consentRequestId);
  assert.equal(purposeData(await execute(canceled.handle)).state,'canceled');assert.equal((await flow.resume(canceled.handle)).state,'canceled');assert.equal(reviews,1);
  let observed=await f.observation();assert.equal(observed.consentRequests,0);assert.equal(observed.sendRequests,0);

  const expired=await prepare('合成：页面时限到期不是用户取消。'),expiredRow=await f.sender.runtime.store.get(key(expired.handle));
  await f.sender.runtime.store.put(key(expired.handle),{...expiredRow,expiresAt:Date.now()-1});
  assert.equal(purposeData(await execute(expired.handle)).error,'contact_work_preview_expired');assert.equal(reviews,1);
  assert.equal((await flow.status(expired.handle)).state,'prepared');
  const choiceExpired=await prepare('合成：过期的请求状态不能被当作取消。');decision='expired';
  assert.equal(purposeData(await execute(choiceExpired.handle)).error,'native_choice_changed_or_expired');assert.equal((await flow.status(choiceExpired.handle)).state,'prepared');
  const undecided=await prepare('合成：未知的选择结果仍需原选择。');decision='unknown';
  assert.equal(purposeData(await execute(undecided.handle)).state,'unknown');assert.equal((await flow.status(undecided.handle)).state,'prepared');
  await assert.rejects(()=>flow.resume(undecided.handle),error=>error.code==='contact_work_original_choice_required');
  observed=await f.observation();assert.equal(observed.consentRequests,0);assert.equal(observed.sendRequests,0);

  // Simulate a transport failure while the already reviewed callback is in
  // flight. A concurrent cancellation must not erase that approved unknown
  // operation. Continue the original bytes after checking its actual receipt.
  let release,postStarted;const started=new Promise(ok=>{postStarted=ok;});let losePost=true;
  const originalCall=f.sender.runtime.api.call,delivery=createNativeContactWork({...f.sender.runtime,api:{...f.sender.runtime.api,call:async(path,input,options)=>{
   if(path==='/v2/contacts'&&losePost){losePost=false;postStarted();return new Promise((_ok,no)=>{release=()=>no(Error('synthetic_transport_result_unknown'));});}
   return originalCall(path,input,options);
  }}});
  const pending=await delivery.prepare({action:'send',context,opportunityRef:item.opportunityRef,purpose:'conversation',note:'合成：原授权未知结果须继续原操作。'}),pendingRow=await f.sender.runtime.store.get(key(pending.handle));
  const sending=delivery.execute(pending.handle);await started;const lateCancel=delivery.cancelPrepared(pending.handle);release();
  assert.equal((await sending).state,'unknown');assert.equal((await lateCancel).state,'unknown');assert.equal((await delivery.cancelPrepared(pending.handle)).state,'unknown');
  assert.ok((await delivery.pending()).items.some(row=>row.handle===pending.handle&&row.state==='unknown'));
  assert.equal((await f.sender.runtime.store.get(key(pending.handle))).payloadJson,pendingRow.payloadJson);
  const sent=await delivery.resume(pending.handle);assert.equal(sent.state,'acknowledged');assert.equal(sent.receipt.operationId,JSON.parse(pendingRow.payloadJson).operationId);
  const recipient=createNativeContactWork(f.recipient.runtime),decline=await recipient.prepare({action:'decline',contactId:sent.receipt.contactId,note:'合成：这次交流暂不接受。'}),declined=await recipient.execute(decline.handle);
  assert.equal(declined.state,'acknowledged');assert.equal(declined.contact.state,'declined');assert.equal((await recipient.cancelPrepared(decline.handle)).state,'acknowledged');
  observed=await f.observation();assert.equal(observed.sendRequests,1);assert.equal(observed.responseRequests,1);assert.equal(observed.events.length,2);assert.deepEqual(observed.counts,{tasks:0,participations:0,rooms:0});
 }finally{await choice?.close();await f.close();}
});
