import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { createLocalAssistanceStore } from "../src/clients/local/assistance-store.mjs";
import { createAssistanceFlow } from "../src/clients/flows/assistance.mjs";
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
  h.choose('按当前版本继续编辑');await wait(()=>h.page()?.options?.some(o=>o.title==='预览事件与授权'));assert.ok(h.page().title.includes('工作纠正/复核版本: 4'));
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
async function fixture(t,{editableRequest=false}={}) {
  const directory=await mkdtemp(join(tmpdir(),'galaxy-assistance-draft-ui-'));
  const pending=new Set();
  const track=promise=>{pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;};
  t.after(async()=>{while(pending.size)await Promise.allSettled(pending);await rm(directory,{recursive:true,force:true});});
  await initializeGalaxyIntegration(directory,{profile:'coding-case',source:'test'});
  const identity=JSON.parse(await readFile(join(directory,'galaxy-id.json'),'utf8'));
  const endpoint='https://fixture.example',store=createLocalAssistanceStore({dataDirectory:directory,endpoint});
  const now=Math.floor(Date.now()/1000),authorization={subjectId:identity.id,bindingId:randomUUID(),scopes:['binding','consent','assistance'],bindingExpiresAt:now+900,expiresAt:now+600,revoked:false,credential:'A'.repeat(43),endpoint};
  let signAttempts=0;
  const flow=createAssistanceFlow({endpoint,journal:store,sessions:{readAuthorization:async()=>authorization,isAuthorizationCurrent:async()=>true,matchesAuthorization:()=>true},
    assistanceRead:async()=>controller.getAssistance(),signIntent:async()=>{signAttempts++;throw new Error('This UI fixture does not sign');}});
  const inputs=[],previews=[];let saves=0,retries=0,activePreview;
  const controller={cancel(){},createAssistanceDraft:()=>store.createDraft(),getAssistanceDraft:id=>store.getDraft(id),
    createAssistanceEventDraft:input=>store.createEventDraft(input),rebaseAssistanceDraft:input=>store.rebaseDraft(input),
    saveAssistanceDraft:input=>{saves++;return store.saveDraft(input);},listAssistanceDrafts:()=>store.listDrafts(),forgetAssistanceDraft:id=>store.forgetDraft(id),
    listCollaborationOperations:()=>store.list(),forgetCollaborationOperation:id=>store.forget(id),
    reconcileCollaboration:async()=>({state:'absent'}),
    qualificationPolicies:async()=>({policies:[{id:'compiler',version:'1',title:'Compiler policy',capabilityId:'compiler.fix',collaboration:'basic-bounty'}]})};
  controller.prepareCollaboration=async input=>{inputs.push(input);const preview=await flow.prepare(input);previews.push(preview);return preview;};
  if(editableRequest){
    controller.prepareCollaborationDraft=async input=>{const preview=await flow.prepareDraft(input);previews.push(preview);activePreview=preview;return preview;};
    controller.executeCollaboration=(preview,confirmation)=>flow.execute(preview,confirmation);
    controller.cancel=()=>{if(activePreview){flow.cancel(activePreview);activePreview=null;}};
  }
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
  return {store,controller,host,inputs,previews,identity,saves:()=>saves,retries:()=>retries,signAttempts:()=>signAttempts};
}

test('a saved historical mid-budget draft resumes its original details and range without recreating an ordinary compensation flow',async t=>{
  const f=await fixture(t);let row=await f.store.createDraft();
  row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,mode:'range',visibility:'Private',step:'budget-fields',index:1,
    values:{caseId:randomUUID(),title:'Compiler bounty',problem:'Build failure',attempts:'Tried flag A; Tried flag B',scope:'Fix compiler',hours:'24',viewers:'GUID'+'A'.repeat(28),minimum:'10'}}});
  const id=row.id;let h=f.host();
  h.close();h=f.host();h.menu.open();await wait(()=>h.page()?.options?.some(item=>item.title==='Compiler bounty'));
  h.choose('Compiler bounty');await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
  assert.match(h.page().title,/最高金额/);await h.enter('20');await h.enter('USD');
  await wait(()=>h.page()?.options?.some(item=>item.title==='发布求助'));
  assert.equal(f.inputs.length,0);h.choose('稍后继续');await wait(()=>h.page()?.options?.some(item=>item.title==='Compiler bounty'));
  h.choose('Compiler bounty');await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');h.choose('发布求助');
  await wait(()=>f.previews.length===1);
  const input=f.inputs[0],payload=JSON.parse(f.previews[0].payloadJson);
  assert.equal(input.draftId,id);assert.equal(payload.id,id);assert.equal(payload.title,'Compiler bounty');
  assert.deepEqual(payload.attemptedApproaches,['Tried flag A','Tried flag B']);assert.equal(payload.visibility,'Private');
  assert.deepEqual(payload.budget,{mode:'range',minimum:'10',maximum:'20',unit:'USD'});assert.equal(payload.collaboration,'basic-bounty');
  assert.deepEqual(input.viewers,['GUID'+'A'.repeat(28)]);assert.equal('materials' in payload,false);assert.equal('rawContext' in payload,false);
  await wait(()=>h.page()?.options?.some(item=>item.title==='预览原内容并重试'));
  assert.equal((await f.store.getDraft(id)).status,'prepared');
  assert.ok(!h.page().options.some(item=>item.title==='核对服务端接收结果'));
  assert.equal(f.retries(),0);h.choose('预览原内容并重试');assert.equal(f.retries(),1);
});

test('ordinary request final preview edits one field in the same draft and only its final Publish choice reaches signing',async t=>{
  const f=await fixture(t,{editableRequest:true}),caseId=randomUUID();
  f.controller.status=async()=>({subjectId:f.identity.id});f.controller.queryHistory=async()=>({items:[{caseId,title:'Original work',summary:'Original context',attempts:[]}],nextCursor:null});
  const h=f.host();h.menu.create();await wait(()=>h.page()?.options?.some(o=>o.title==='Original work'));h.choose('Original work');await wait(()=>h.page()?.kind==='prompt');
  await h.enter('Inspect exports');h.choose('仅自己');await wait(()=>h.page()?.options?.some(o=>o.title==='发布求助'));
  const row=(await f.store.listDrafts()).items[0],first=f.previews[0],stale=h.page().routes['1'];
  assert.equal((await f.store.getDraft(row.id)).status,'editing');assert.equal((await f.store.list()).items.length,0);assert.equal(f.signAttempts(),0);assert.ok(h.page().title.includes('Inspect exports'));
  assert.ok(!h.page().options.some(o=>/允许本次内容|报酬|资格|分类/.test(o.title)));
  h.choose('更多设置');assert.ok(!h.page().options.some(o=>/报酬|资格|分类/.test(o.title)));h.page().onBack();await wait(()=>f.previews.length===2);
  h.choose('修改内容');h.choose('希望得到怎样的协助');await wait(()=>h.page()?.kind==='prompt');assert.equal(h.page().value,'Inspect exports');await h.enter('Inspect only the current export');await wait(()=>f.previews.length===3);
  const changed=f.previews[2];assert.equal(first.eventId,changed.eventId);assert.equal(JSON.parse(changed.payloadJson).scope,'Inspect only the current export');assert.equal(JSON.parse(changed.payloadJson).problem,'Original context');
  stale();assert.equal(f.signAttempts(),0);assert.equal((await f.store.list()).items.length,0);
  h.choose('发布求助');await wait(()=>f.signAttempts()===1);await wait(()=>h.page()?.kind==='info'&&h.page().text.includes('暂未确认结果'));
  assert.equal((await f.store.getDraft(row.id)).status,'prepared');assert.equal((await f.store.list()).items.length,1);
});

test('native approach editing preserves legacy entries, literal semicolons and multiline source content',async t=>{
  const f=await fixture(t,{editableRequest:true});let row=await f.store.createDraft();
  row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'review',visibility:'Private',
    values:{caseId:randomUUID(),title:'Current help',problem:'Context',scope:'Inspect exports',hours:'24',attempts:'Tried A; Tried B'}}});
  const h=f.host();h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(o=>o.title==='继续填写'));h.choose('继续填写');await wait(()=>h.page()?.options?.some(o=>o.title==='发布求助'));
  assert.deepEqual(JSON.parse(f.previews.at(-1).payloadJson).attemptedApproaches,['Tried A','Tried B']);
  h.choose('修改内容');h.choose('已有尝试（可留空）');assert.equal(h.page().value,'Tried A\nTried B');await h.enter('Tried A; same authored sentence\nTried B');await wait(()=>h.page()?.options?.some(o=>o.title==='发布求助'));
  assert.deepEqual(JSON.parse(f.previews.at(-1).payloadJson).attemptedApproaches,['Tried A; same authored sentence','Tried B']);assert.equal(f.signAttempts(),0);
  h.choose('修改内容');const saved=await f.store.getDraft(row.id);await f.store.saveDraft({id:row.id,expectedRevision:saved.revision,content:{...saved.content,attemptedApproaches:['One approach\nwith its continuation','Another approach']}});
  h.close();const next=f.host();next.menu.openDraft(row.id);await wait(()=>next.page()?.options?.some(o=>o.title==='继续填写'));next.choose('继续填写');await wait(()=>next.page()?.options?.some(o=>o.title==='发布求助'));
  next.choose('修改内容');next.choose('已有尝试（可留空）');next.choose('尝试 1');assert.equal(next.page().value,'One approach\nwith its continuation');await next.enter('One approach\nwith its edited continuation');next.choose('保存已有尝试');await wait(()=>next.page()?.options?.some(o=>o.title==='发布求助'));
  assert.deepEqual(JSON.parse(f.previews.at(-1).payloadJson).attemptedApproaches,['One approach\nwith its edited continuation','Another approach']);assert.equal((await f.store.list()).items.length,0);assert.equal(f.signAttempts(),0);next.close();
});

test('a changed draft at the final Publish choice returns to the saved editable content without inventing an unknown receipt',async t=>{
  const f=await fixture(t,{editableRequest:true});let row=await f.store.createDraft();
  row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'review',visibility:'Private',
    values:{caseId:randomUUID(),title:'Current request',problem:'Current context',scope:'Original question',hours:'1'}}});
  const h=f.host();h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(o=>o.title==='继续填写'));h.choose('继续填写');await wait(()=>h.page()?.options?.some(o=>o.title==='发布求助'));
  await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,values:{...row.content.values,scope:'New saved question'}}});
  h.choose('发布求助');await wait(()=>h.page()?.kind==='info'&&h.page().text.includes('返回当前草稿'));
  assert.equal(f.signAttempts(),0);assert.equal((await f.store.list()).items.length,0);assert.equal((await f.store.getDraft(row.id)).status,'editing');
  h.page().onBack();await wait(()=>h.page()?.options?.some(o=>o.title==='继续填写'));h.choose('继续填写');await wait(()=>h.page()?.options?.some(o=>o.title==='发布求助'));
  assert.ok(h.page().title.includes('New saved question'));assert.equal(f.signAttempts(),0);
});

test('native Assistance qualification selection survives restart and canceling a save does not reopen the editor',async t=>{
  const f=await fixture(t);let row=await f.store.createDraft();
  row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'qualification',values:{hours:'24',title:'Qualified request',capabilityId:'compiler.fix'},mode:'fixed',visibility:'Public'}});
  let h=f.host();h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
  await wait(()=>h.page()?.options?.some(item=>item.title==='Compiler policy'));h.choose('Compiler policy');
  await wait(()=>h.page()?.options?.some(item=>item.title==='发布求助'));h.close();h=f.host();
  h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
  assert.equal((await f.store.getDraft(row.id)).content.qualification.policyId,'compiler');
  h.choose('修改草稿');await wait(()=>h.page()?.kind==='prompt');
  let release;const original=f.controller.saveAssistanceDraft;
  f.controller.saveAssistanceDraft=input=>new Promise(resolve=>{release=()=>original(input).then(resolve);});
  const prompt=h.page();prompt.onConfirm(randomUUID());assert.equal(h.page().kind,'info');h.page().onBack();
  await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));const recoveredPage=h.page();await release();
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.page(),recoveredPage);assert.equal(f.inputs.length,0);
});

test('connected collaboration drafts choose current readable work and preserve its exact locator without asking for an internal ID',async t=>{
  const f=await fixture(t),caseId=randomUUID(),attemptId=randomUUID(),reads=[];
  f.controller.status=async()=>({subjectId:f.identity.id});
  f.controller.queryHistory=async input=>{reads.push(input);return{items:[{caseId,title:'Current compiler work',summary:'Build still fails',attempts:[{id:attemptId,approach:'Inspect exports'}]}],nextCursor:null};};
  const h=f.host();h.menu.create();await wait(()=>h.page()?.options?.some(item=>item.title==='Current compiler work'));
  assert.equal(f.previews.length,0);assert.equal(h.page().title.includes(caseId),false);h.choose('Current compiler work');
  await wait(()=>h.page()?.kind==='prompt');assert.match(h.page().title,/希望得到怎样的协助/);await h.enter('Need help with this build');
  h.choose('公开请求说明');
  await wait(()=>h.page()?.options?.some(item=>item.title==='发布求助'));
  assert.equal(f.previews.length,0);assert.equal(reads.length,2);assert.ok(reads.every(input=>input.subjectId===f.identity.id));
  h.choose('发布求助');await wait(()=>f.previews.length===1);
  const payload=JSON.parse(f.previews[0].payloadJson);assert.equal(payload.caseId,caseId);assert.equal(payload.title,'Current compiler work');assert.equal(payload.problem,'Build still fails');assert.equal(payload.scope,'Need help with this build');assert.deepEqual(payload.attemptedApproaches,['Inspect exports']);
});

test('native fixed and quote-only bounty drafts preserve extensible units and require explicit preview',async t=>{
  const f=await fixture(t);
  for(const mode of ['fixed','quote']){
    let row=await f.store.createDraft();
    row=await f.store.saveDraft({id:row.id,expectedRevision:row.revision,content:{...row.content,step:'budget-fields',index:0,mode,visibility:'Public',
      values:{caseId:randomUUID(),title:mode+' request',problem:'Build fails',scope:'Inspect logs',hours:'24'}}});
    const h=f.host();h.menu.openDraft(row.id);await wait(()=>h.page()?.options?.some(item=>item.title==='继续填写'));h.choose('继续填写');
    if(mode==='fixed')await h.enter('10.00000001');await h.enter('external-unit');
    await wait(()=>h.page()?.options?.some(item=>item.title==='发布求助'));
    const count=f.inputs.length;assert.equal((await f.store.getDraft(row.id)).status,'editing');
    h.choose('发布求助');await wait(()=>f.previews.length===count+1);
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
  let h=f.host({root:true});h.menu.openRequest(current.request.id);await wait(()=>h.page()?.kind==='info'&&h.page().title===current.request.title);assert.ok(h.page().text.includes(current.request.scope));h.page().onBack();await wait(()=>h.page()?.options?.some(option=>option.title==='申请协助'));
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
