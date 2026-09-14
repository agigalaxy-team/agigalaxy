import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { createLocalAssistanceStore } from '../src/local-assistance-store.mjs';
import { createAssistanceFlow } from '../src/assistance-flow.mjs';
import { createAssistanceDraftMenu } from '../../../integrations/host-adapters/opencode-stable/assistance-draft-menu.mjs';
import { createAssistanceMenu } from '../../../integrations/host-adapters/opencode-stable/assistance-menu.mjs';

const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Draft UI did not settle');};
test('native delivery draft retains fields when only the Case version changes and signs the refreshed version',async t=>{
  const f=await fixture(t),caseId=randomUUID();
  const current={request:{id:randomUUID(),title:'Updated Case delivery',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:2000001000},
    requesterId:'GUID'+'A'.repeat(28),selected:{providerId:f.identity.id,offerId:randomUUID()},version:4,view:'selected-provider',state:'active',offers:[],
    deliverySource:{caseId,reviewVersion:3,correctionCount:0},eventFeatures:{deliveryCaseReview:1,resumeWorkResolution:1},contextAccessGranted:false,paymentExecuted:false,capabilityVerified:false};
  f.controller.getAssistance=async()=>current;const h=f.host();h.menu.createEvent({record:current,eventKind:'deliver'});
  await wait(()=>h.page()?.kind==='prompt');const attemptId=randomUUID();await h.enter(attemptId);await h.enter('Saved corrected delivery');await h.enter('');
  current.deliverySource={caseId,reviewVersion:4,correctionCount:1};h.choose('预览事件与授权');await wait(()=>h.page()?.options?.some(o=>o.title==='按当前版本继续编辑'));
  assert.equal(f.previews.length,0);assert.ok(h.page().title.includes('Case 3'));assert.ok(h.page().title.includes('Case 4'));
  h.choose('按当前版本继续编辑');await wait(()=>h.page()?.options?.some(o=>o.title==='预览事件与授权'));assert.ok(h.page().title.includes('Case纠正/复核版本: 4'));
  h.choose('预览事件与授权');await wait(()=>f.previews.length===1);const event=JSON.parse(f.previews[0].payloadJson).event;
  assert.equal(event.caseReviewVersion,4);assert.equal(event.attemptId,attemptId);assert.equal(event.summary,'Saved corrected delivery');
});
test('native resume-work draft preserves the explicit outcome in the full signed preview',async t=>{
  const f=await fixture(t),current={request:{id:randomUUID(),title:'Resume corrected work',visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:2000001000},
    requesterId:'GUID'+'A'.repeat(28),selected:{providerId:f.identity.id,offerId:randomUUID()},version:8,view:'selected-provider',state:'disputed',offers:[],
    eventFeatures:{resumeWorkResolution:1},contextAccessGranted:false,paymentExecuted:false,capabilityVerified:false};
  f.controller.getAssistance=async()=>current;const h=f.host();h.menu.createEvent({record:current,eventKind:'propose-resolution',target:{outcome:'resume-work'}});
  await wait(()=>h.page()?.kind==='prompt');await h.enter('Redo the current Case');assert.ok(h.page().title.includes('双方确认后继续工作'));h.choose('预览事件与授权');
  await wait(()=>f.previews.length===1);assert.equal(JSON.parse(f.previews[0].payloadJson).event.outcome,'resume-work');
});
test('native public contribution draft fixes an explicit Public consent without changing private defaults',async t=>{
  const f=await fixture(t);
  const current={request:{id:randomUUID(),title:'Public contribution',visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:2000001000},
    requesterId:'GUID'+'A'.repeat(28),selected:{providerId:f.identity.id,offerId:randomUUID()},version:3,view:'selected-provider',state:'awaiting-confirmation',offers:[],
    contextAccessGranted:false,paymentExecuted:false,capabilityVerified:false};
  f.controller.getAssistance=async()=>current;
  const h=f.host();h.menu.createEvent({record:current,eventKind:'confirm'});
  await wait(()=>h.page()?.options?.some(option=>option.title==='预览公开贡献事件'));
  assert.ok(h.page().options.some(option=>option.title==='预览事件与授权'));assert.equal(f.previews.length,0);
  h.choose('预览公开贡献事件');await wait(()=>f.previews.length===1);
  const preview=f.previews[0],intent=JSON.parse(preview.intentJson);
  assert.equal(intent.visibility,'Public');assert.equal(intent.purpose,'public-profile');assert.deepEqual(intent.viewers,[]);
  assert.equal(JSON.parse(preview.payloadJson).event.kind,'confirm');assert.equal(f.inputs[0].eventVisibility,'Public');
});
test('native provider feedback keeps private preview and offers an explicit public assessment',async t=>{
  const f=await fixture(t),current={request:{id:randomUUID(),title:'Feedback scope',visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:2000001000},
    requesterId:'GUID'+'A'.repeat(28),selected:{providerId:f.identity.id,offerId:randomUUID()},version:7,view:'selected-provider',state:'canceled',offers:[],
    eventFeatures:{publicRequesterFeedback:1},contextAccessGranted:false,paymentExecuted:false,capabilityVerified:false};
  f.controller.getAssistance=async()=>current;const h=f.host();h.menu.createEvent({record:current,eventKind:'requester-feedback'});
  await wait(()=>h.page()?.kind==='prompt');await h.enter('clear');await h.enter('yes');await h.enter('Request described the actual work');
  assert.ok(h.page().options.some(option=>option.title==='预览事件与授权'));assert.equal(f.previews.length,0);
  h.choose('预览公开反馈');await wait(()=>f.previews.length===1);
  const preview=f.previews[0],intent=JSON.parse(preview.intentJson);assert.equal(intent.visibility,'Public');assert.deepEqual(intent.viewers,[]);
  assert.equal(JSON.parse(preview.payloadJson).event.kind,'requester-feedback');
});
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'galaxy-assistance-draft-ui-'));
  const pending=new Set();
  const track=promise=>{pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;};
  t.after(async()=>{while(pending.size)await Promise.allSettled(pending);await rm(directory,{recursive:true,force:true});});
  await initializeGalaxyIntegration(directory,{profile:'coding-case',source:'test'});
  const identity=JSON.parse(await readFile(join(directory,'galaxy-id.json'),'utf8'));
  const endpoint='https://fixture.example',store=createLocalAssistanceStore({dataDirectory:directory,endpoint});
  const now=Math.floor(Date.now()/1000),authorization={subjectId:identity.id,bindingId:randomUUID(),scopes:['binding','consent','assistance'],bindingExpiresAt:now+900,endpoint};
  const flow=createAssistanceFlow({endpoint,journal:store,sessions:{readAuthorization:async()=>authorization,isAuthorizationCurrent:async()=>true,matchesAuthorization:()=>true},
    assistanceRead:async()=>controller.getAssistance(),signIntent:async()=>{throw new Error('No signing before confirmation');}});
  const inputs=[],previews=[];let saves=0,retries=0;
  const controller={cancel(){},createAssistanceDraft:()=>store.createDraft(),getAssistanceDraft:id=>store.getDraft(id),
    createAssistanceEventDraft:input=>store.createEventDraft(input),rebaseAssistanceDraft:input=>store.rebaseDraft(input),
    saveAssistanceDraft:input=>{saves++;return store.saveDraft(input);},listAssistanceDrafts:()=>store.listDrafts(),forgetAssistanceDraft:id=>store.forgetDraft(id),
    listCollaborationOperations:()=>store.list(),forgetCollaborationOperation:id=>store.forget(id),
    reconcileCollaboration:async()=>({state:'absent'}),
    qualificationPolicies:async()=>({policies:[{id:'compiler',version:'1',title:'Compiler policy',capabilityId:'compiler.fix',collaboration:'basic-bounty'}]})};
  controller.prepareCollaboration=async input=>{inputs.push(input);const preview=await flow.prepare(input);previews.push(preview);return preview;};
  for(const [name,method] of Object.entries(controller))if(name!=='cancel')controller[name]=(...args)=>track(Promise.resolve().then(()=>method(...args)));
  function host({root=false,offline=false}={}){
    let page,current=true;
    const menu=(root?createAssistanceMenu:createAssistanceDraftMenu)({controller,language:'zh-CN',isCurrent:()=>current,onBack:()=>{current=false;},canSubmit:!offline,
      onOpenRequest:()=>{throw new Error('No implicit request read');},
      onConfirm:(input,back,retry)=>{if(retry){retries++;return;}void track(controller.prepareCollaboration(input).then(()=>back()));},
      select:value=>{page={kind:'select',...value};},prompt:value=>{page={kind:'prompt',...value};},info:(title,text,onBack)=>{page={kind:'info',title,text,onBack};}});
    return {menu,page:()=>page,close:()=>{current=false;},choose(title){const option=page.options?.find(item=>item.title===title);assert.ok(option,title);page.routes[option.number]();},
      async enter(text){const old=page;assert.equal(old.kind,'prompt');old.onConfirm(text);await wait(()=>page!==old&&page.kind!=='info');},
      wait};
  }
  return {store,controller,host,inputs,previews,identity,saves:()=>saves,retries:()=>retries};
}

test('native Assistance draft resumes mid-budget after restart with all details, visibility and qualification intact',async t=>{
  const f=await fixture(t);let h=f.host();h.menu.create();await wait(()=>h.page()?.kind==='prompt');
  const stale=h.page();
  for(const value of [randomUUID(),'Compiler bounty','Build failure','Tried flag A; Tried flag B','Fix compiler','','24'])await h.enter(value);
  const savedCount=f.saves();stale.onConfirm('stale');assert.equal(f.saves(),savedCount);
  h.choose('私有：指定参与者');await wait(()=>h.page()?.kind==='prompt');await h.enter('GUID'+'A'.repeat(28));
  h.choose('预算区间');await wait(()=>h.page()?.kind==='prompt');await h.enter('10');
  const id=(await f.store.listDrafts()).items[0].id;
  h.close();h=f.host();h.menu.open();await wait(()=>h.page()?.options?.some(item=>item.title==='Compiler bounty'));
  h.choose('Compiler bounty');await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
  assert.match(h.page().title,/最高金额/);await h.enter('20');await h.enter('USD');
  await wait(()=>h.page()?.options?.some(item=>item.title==='预览完整请求与授权'));
  assert.equal(f.inputs.length,0);h.choose('留待以后继续');await wait(()=>h.page()?.options?.some(item=>item.title==='Compiler bounty'));
  h.choose('Compiler bounty');await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');h.choose('预览完整请求与授权');
  await wait(()=>f.previews.length===1);
  const input=f.inputs[0],payload=JSON.parse(f.previews[0].payloadJson);
  assert.equal(input.draftId,id);assert.equal(payload.id,id);assert.equal(payload.title,'Compiler bounty');
  assert.deepEqual(payload.attemptedApproaches,['Tried flag A','Tried flag B']);assert.equal(payload.visibility,'Private');
  assert.deepEqual(payload.budget,{mode:'range',minimum:'10',maximum:'20',unit:'USD'});assert.equal(payload.collaboration,'basic-bounty');
  assert.deepEqual(input.viewers,['GUID'+'A'.repeat(28)]);assert.equal('materials' in payload,false);assert.equal('rawContext' in payload,false);
  await wait(()=>h.page()?.options?.some(item=>item.title==='核对服务端接收结果'));
  assert.equal((await f.store.getDraft(id)).status,'prepared');
  h.choose('核对服务端接收结果');await wait(()=>h.page()?.options?.some(item=>item.title==='预览原内容并重试'));
  assert.equal(f.retries(),0);h.choose('预览原内容并重试');assert.equal(f.retries(),1);
});

test('native Assistance qualification selection survives restart and canceling a save does not reopen the editor',async t=>{
  const f=await fixture(t);let row=await f.store.createDraft();
  row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'qualification',values:{hours:'24',title:'Qualified request',capabilityId:'compiler.fix'},mode:'fixed',visibility:'Public'}});
  let h=f.host();h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
  await wait(()=>h.page()?.options?.some(item=>item.title==='Compiler policy'));h.choose('Compiler policy');
  await wait(()=>h.page()?.options?.some(item=>item.title==='预览完整请求与授权'));h.close();h=f.host();
  h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
  assert.equal((await f.store.getDraft(row.id)).content.qualification.policyId,'compiler');
  h.choose('修改草稿');await wait(()=>h.page()?.kind==='prompt');
  let release;const original=f.controller.saveAssistanceDraft;
  f.controller.saveAssistanceDraft=input=>new Promise(resolve=>{release=()=>original(input).then(resolve);});
  const prompt=h.page();prompt.onConfirm(randomUUID());assert.equal(h.page().kind,'info');h.page().onBack();
  await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));const recoveredPage=h.page();await release();
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.page(),recoveredPage);assert.equal(f.inputs.length,0);
});

test('native fixed and quote-only bounty drafts preserve extensible units and require explicit preview',async t=>{
  const f=await fixture(t);
  for(const mode of ['fixed','quote']){
    let row=await f.store.createDraft();
    row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'budget-fields',index:0,mode,visibility:'Public',
      values:{caseId:randomUUID(),title:mode+' request',problem:'Build fails',scope:'Inspect logs',hours:'24'}}});
    const h=f.host();h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
    if(mode==='fixed')await h.enter('10.00000001');await h.enter('external-unit');
    await wait(()=>h.page()?.options?.some(item=>item.title==='预览完整请求与授权'));
    const count=f.inputs.length;assert.equal((await f.store.getDraft(row.id)).status,'editing');
    h.choose('预览完整请求与授权');await wait(()=>f.previews.length===count+1);
    const payload=JSON.parse(f.previews.at(-1).payloadJson);
    assert.deepEqual(payload.budget,{mode,...(mode==='fixed'?{amount:'10.00000001'}:{}),unit:'external-unit'});
    assert.equal(payload.collaboration,'basic-bounty');assert.equal('payment' in payload,false);h.close();
  }
});

test('native offer resumes fields, qualification evidence and quote, and requires explicit refresh after the collaboration changes',async t=>{
  const f=await fixture(t),requester='GUID'+'A'.repeat(28),requestId=randomUUID();
  let current={request:{id:requestId,title:'Compiler help',collaboration:'basic-bounty',enrollmentExpiresAt:2000001000,qualification:{policyId:'compiler',policyVersion:'1'}},
    version:1,view:'applicant',requesterId:requester,state:'open',offers:[],contextAccessGranted:false,paymentExecuted:false,capabilityVerified:false};
  f.controller.getAssistance=async()=>current;
  let h=f.host();h.menu.createEvent({record:current,eventKind:'offer'});await wait(()=>h.page()?.kind==='prompt');
  await h.enter('Investigate compiler failure');
  const id=(await f.store.listDrafts()).items[0].id;h.close();h=f.host();h.menu.openDraft(id);
  await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
  await wait(()=>h.page()?.kind==='prompt'&&h.page().title.includes('协作范围'));await h.enter('Review selected diagnostics');
  const proofId=randomUUID(),assistanceId=randomUUID();await h.enter(proofId);await h.enter(assistanceId);
  h.choose('固定金额');await wait(()=>h.page()?.kind==='prompt');await h.enter('12.50');await h.enter('external-unit');
  await wait(()=>h.page()?.options?.some(item=>item.title==='预览事件与授权'));
  current={...current,version:2};h.choose('预览事件与授权');
  await wait(()=>h.page()?.options?.some(item=>item.title==='按当前版本继续编辑'));
  assert.match(h.page().title,/v1/);assert.match(h.page().title,/v2/);assert.equal(f.inputs.length,0);
  h.choose('按当前版本继续编辑');await wait(()=>h.page()?.options?.some(item=>item.title==='预览事件与授权'));
  assert.equal((await f.store.getDraft(id)).content.values.proposal,'Investigate compiler failure');
  h.choose('预览事件与授权');await wait(()=>f.previews.length===1);
  const payload=JSON.parse(f.previews[0].payloadJson),intent=JSON.parse(f.previews[0].intentJson);
  assert.equal(payload.assistanceId,requestId);assert.equal(payload.event.id,id);assert.equal(payload.event.expectedVersion,2);
  assert.deepEqual(payload.event.quote,{mode:'fixed',amount:'12.50',unit:'external-unit'});
  assert.deepEqual(payload.event.qualificationEvidence,{proofIds:[proofId],assistanceIds:[assistanceId]});
  assert.deepEqual(intent.viewers,[requester]);assert.equal((await f.store.getDraft(id)).status,'prepared');
});

test('native selected-target drafts retain their text when a participant or delivery target changes',async t=>{
  const f=await fixture(t),deliveryId=randomUUID();
  const current={request:{id:randomUUID(),title:'Delivery acceptance',collaboration:'open-assistance',enrollmentExpiresAt:2000001000},
    version:4,view:'requester',requesterId:f.identity.id,state:'delivered',offers:[],delivery:{id:deliveryId}};
  const row=await f.store.createEventDraft({record:current,eventKind:'accept',target:{deliveryId}});
  const saved=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,values:{summary:'Saved acceptance note'},step:'review'}});
  const h=f.host();f.controller.getAssistance=async()=>({...current,version:5,delivery:{id:randomUUID()}});
  h.menu.openDraft(saved.id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
  await wait(()=>h.page()?.kind==='info'&&h.page().text.includes('Draft target changed'));
  assert.equal(f.inputs.length,0);assert.equal((await f.store.getDraft(row.id)).content.values.summary,'Saved acceptance note');
  await assert.rejects(f.store.saveDraft({id:row.id,expectedRevision:saved.revision,content:{...saved.content,source:{...saved.content.source,version:5}}}),/explicit refresh/);
  await assert.rejects(f.store.rebaseDraft({id:row.id,expectedRevision:saved.revision,record:{...current,version:5,view:'applicant'}}),/participant role changed/);
});

test('native collaboration actions create durable event drafts and those drafts remain editable offline',async t=>{
  const f=await fixture(t);
  const current={request:{id:randomUUID(),title:'Native offer',problem:'Compiler fails',attemptedApproaches:[],scope:'Investigate',collaboration:'open-assistance',enrollmentExpiresAt:2000001000},
    requesterId:'GUID'+'A'.repeat(28),version:1,view:'applicant',state:'open',offers:[],contextAccessGranted:false,paymentExecuted:false,capabilityVerified:false};
  f.controller.getAssistance=async()=>current;
  let h=f.host({root:true});h.menu.openRequest(current.request.id);await wait(()=>h.page()?.options?.some(option=>option.title==='申请协助'));
  h.choose('申请协助');await wait(()=>h.page()?.kind==='prompt');await h.enter('Saved from real collaboration entry');
  const id=(await f.store.listDrafts()).items[0].id;h.close();
  f.controller.getAssistance=async()=>{throw new Error('Offline editing must not read the service');};
  h=f.host({offline:true});h.menu.openDraft(id);await wait(()=>h.page()?.options?.some(option=>option.title==='继续填写'));h.choose('继续填写');
  await h.enter('Selected diagnostics only');
  assert.ok(!h.page().options.some(option=>option.title==='预览事件与授权'));assert.equal(f.inputs.length,0);
  assert.equal((await f.store.getDraft(id)).content.values.proposal,'Saved from real collaboration entry');
  assert.equal((await f.store.getDraft(id)).content.values.scope,'Selected diagnostics only');
});

test('native delivery drafts retain typed Case references through restart and feedback keeps its boolean meaning',async t=>{
  const f=await fixture(t),attemptId=randomUUID(),evidenceIds=[randomUUID(),randomUUID()];
  let current={request:{id:randomUUID(),title:'Scoped delivery',collaboration:'open-assistance',enrollmentExpiresAt:2000001000},
    requesterId:'GUID'+'A'.repeat(28),selected:{providerId:f.identity.id,offerId:randomUUID()},version:4,view:'selected-provider',state:'active',
    agreedScope:'Selected diagnostics',offers:[],contextAccessGranted:false,paymentExecuted:false,capabilityVerified:false};
  f.controller.getAssistance=async()=>current;
  let h=f.host();h.menu.createEvent({record:current,eventKind:'deliver'});await wait(()=>h.page()?.kind==='prompt');
  await h.enter(attemptId);await h.enter('Patch and limitations');
  const id=(await f.store.listDrafts()).items[0].id;h.close();h=f.host();h.menu.openDraft(id);
  await wait(()=>h.page()?.options?.some(option=>option.title==='继续填写'));h.choose('继续填写');await wait(()=>h.page()?.kind==='prompt');
  await h.enter(evidenceIds.join('，'));h.choose('预览事件与授权');await wait(()=>f.previews.length===1);
  const event=JSON.parse(f.previews[0].payloadJson).event;
  assert.equal(event.attemptId,attemptId);assert.deepEqual(event.evidenceIds,evidenceIds);assert.equal(event.summary,'Patch and limitations');h.close();
  current={...current,version:6,state:'accepted'};
  h=f.host();h.menu.createEvent({record:current,eventKind:'requester-feedback'});await wait(()=>h.page()?.kind==='prompt');
  await h.enter('partly-clear');await h.enter('no');await h.enter('Work exceeded the agreed scope');
  h.choose('预览事件与授权');await wait(()=>f.previews.length===2);
  const feedback=JSON.parse(f.previews[1].payloadJson).event;
  assert.equal(feedback.scopeMatched,false);assert.equal(feedback.descriptionClarity,'partly-clear');
});
