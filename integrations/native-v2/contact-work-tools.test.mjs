import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNativeContactWork} from './contact-work-tools.mjs';
import {createContactPurposeFixture,purposeData} from '../host-adapters/opencode-stable/contact-purpose-fixture.mjs';

test('Native contact Gate has no early effects; a lost acknowledgement and repeated original continuation keep one contact, response and ordinary room',{timeout:60000},async()=>{
 const f=await createContactPurposeFixture();try{
  const query={context:{kind:'ephemeral',title:'表格提取',functions:['表格提取']},purposes:['conversation']};
  const page=purposeData(await f.sender.call('galaxy_discovery_v2_query',query));assert.equal(page.items.length,1);
  const item=page.items[0],detail=purposeData(await f.sender.call('galaxy_discovery_v2_detail',{...query,opportunityRef:item.opportunityRef}));
  assert.ok(detail.experience.items.some(e=>e.kind==='case-history'&&e.results.some(r=>r.reportedOutcome==='partial')));
  const prepared=purposeData(await f.sender.call('galaxy_contact_work_prepare',{action:'send',context:query.context,opportunityRef:item.opportunityRef,purpose:'conversation',note:'合成：希望交流已有表格处理思路，不请求交付。'}));
  const gate=await f.sender.call('galaxy_contact_work_execute',{handle:prepared.handle});assert.equal(purposeData(gate).state,'user-choice-needs-browser');
  assert.match(gate.content[0].text,/发起这次联系/);assert.match(gate.content[0].text,/合成：文档工具维护者/);
  assert.match(gate.content[0].text,/希望交流已有表格处理思路，不请求交付/);assert.match(gate.content[0].text,/交流想法/);assert.match(gate.content[0].text,/文档表格工具/);
  assert.equal((await f.sender.call('galaxy_contact_work_resume',{handle:prepared.handle})).isError,true,'a model cannot turn a prepared operation into an approved resume');
  let observed=await f.observation();assert.equal(observed.sendRequests,0);assert.deepEqual(observed.counts,{tasks:0,participations:0,rooms:0});
  // Unit/service scope: simulate the already reviewed callback itself. This is
  // not Browser Gate or actual TUI acceptance evidence.
  const flow=createNativeContactWork(f.sender.runtime);f.setDropContactAck(true);
  const sent=await flow.execute(prepared.handle);assert.equal(sent.state,'acknowledged');assert.equal(sent.contact.state,'sent');assert.equal(sent.contact.roomId,null);
  await Promise.all([flow.resume(prepared.handle),flow.resume(prepared.handle),flow.status(prepared.handle)]);
  observed=await f.observation();assert.equal(observed.sendRequests,1);assert.equal(observed.contacts.length,1);assert.equal(observed.events.length,1);assert.equal(observed.consentRequests,1);
  const response=createNativeContactWork(f.recipient.runtime),accepted=await response.prepare({action:'accept',contactId:sent.receipt.contactId,note:''});
  assert.equal((await response.status(accepted.handle)).state,'prepared','an existing sent Contact is not evidence of this new response event');
  const acceptanceGate=await f.recipient.call('galaxy_contact_work_execute',{handle:accepted.handle});assert.equal(purposeData(acceptanceGate).state,'user-choice-needs-browser');
  assert.match(acceptanceGate.content[0].text,/希望交流已有表格处理思路，不请求交付/);
  assert.equal((await f.recipient.call('galaxy_contact_work_resume',{handle:accepted.handle})).isError,true);
  assert.equal((await f.observation()).responseRequests,0,'acceptance waits for its actual independent Native choice');
  const final=await response.execute(accepted.handle);assert.equal(final.contact.state,'accepted');assert.equal(final.contact.roomId,sent.receipt.contactId);
  await response.resume(accepted.handle);observed=await f.observation();assert.equal(observed.responseRequests,1);assert.deepEqual(observed.counts,{tasks:0,participations:0,rooms:1});
  assert.equal(observed.events.length,2);assert.equal(observed.contacts[0].events[0].kind,'send');
  const room=purposeData(await f.sender.call('galaxy_chat_room',{roomId:final.contact.roomId}));assert.equal(room.kind,'ordinary');assert.deepEqual(room.taskRefs,[]);assert.equal(room.independentMemberCount,2);
  const replyChoice=await f.sender.call('galaxy_chat_agent_grant',{roomId:room.roomId,grantId:randomUUID(),mode:'respond',primaryResponder:false,expiresAt:f.sender.runtime.now()+3600});
  assert.equal(purposeData(replyChoice).state,'user-choice-needs-browser');assert.match(replyChoice.content[0].text,/对话：合成：文档表格工具/);assert.equal((await f.observation()).messageRequests,0);
 }finally{await f.close();}
});

test('a changed exact source or binding cannot authorize a cached contact; original owner retains its pending locator',{timeout:60000},async()=>{
 const f=await createContactPurposeFixture();try{
  const context={kind:'ephemeral',title:'表格提取',functions:['表格提取']},query={context,purposes:['conversation']},item=purposeData(await f.sender.call('galaxy_discovery_v2_query',query)).items[0];
  const flow=createNativeContactWork(f.sender.runtime),prepared=await flow.prepare({action:'send',context,opportunityRef:item.opportunityRef,purpose:'conversation',note:'合成：只向原来的当前资料联系。'});
  await f.recipient.authorize({kind:'revise',operationId:randomUUID(),projectId:f.project.projectId,expectedRevision:1,patch:{summary:'合成：更新后的当前介绍'}},'project.write','/v2/projects',{visibility:'Public'});
  await assert.rejects(()=>flow.preview(prepared.handle),e=>e.code==='discovery_opportunity_unavailable');
  assert.equal((await f.observation()).sendRequests,0);
  const fresh=purposeData(await f.sender.call('galaxy_discovery_v2_query',query)).items[0],next=await flow.prepare({action:'send',context,opportunityRef:fresh.opportunityRef,purpose:'conversation',note:'合成：向新资料联系。'});
  await f.sender.runtime.disconnect();await f.sender.runtime.connect({confirmed:true});
  await assert.rejects(()=>flow.preview(next.handle),e=>e.code==='contact_work_identity_changed');
  assert.ok((await flow.pending()).items.some(p=>p.handle===next.handle));assert.equal((await flow.status(next.handle)).state,'prepared');assert.equal((await f.observation()).sendRequests,0);
 }finally{await f.close();}
});
