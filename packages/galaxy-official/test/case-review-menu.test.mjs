import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCaseReviewMenu } from '../../../integrations/host-adapters/opencode-stable/case-review-menu.mjs';

async function waitFor(predicate){const until=Date.now()+4000;while(!predicate()){if(Date.now()>until)throw new Error('Case review menu transition timeout');await new Promise(resolve=>setTimeout(resolve,5));}}
function fixture(){
  let page,active=true,prepared,executed=0,version=5;
  const caseId=randomUUID(),resultId=randomUUID(),threadId=randomUUID();
  const controller={cancel(){},status:async()=>({state:'session-local',scopes:['case-teaser','consent']}),getCase:async()=>({caseId,version,state:'open',events:[{kind:'case',id:caseId,version:1,title:'Original title'},{kind:'result',id:resultId,version:3,summary:'Original result'}],
    reviews:[{threadId,targetEventId:resultId,type:'correction',state:'resolved',changes:[{state:'opened',summary:'Original concern'},{state:'resolved',summary:'Owner response'}]}]}),
    prepareCaseReview:async input=>{prepared=input;return {endpoint:'https://official.example.org',payloadJson:JSON.stringify(input),intentJson:JSON.stringify({visibility:input.visibility}),confirmation:'CONFIRM REVIEW fixture'};},
    executeCaseReview:async(_preview,confirmation)=>{assert.equal(confirmation,'CONFIRM REVIEW fixture');executed++;return {eventId:'recorded',version:6};}};
  const menu=createCaseReviewMenu({controller,caseId,sourceVersion:5,language:'zh-CN',isCurrent:()=>active,onBack:()=>{active=false;},
    select:value=>{page={kind:'select',...value};},prompt:value=>{page={kind:'prompt',...value};},info:(title,message,onConfirm)=>{page={kind:'info',title,message,onConfirm};}});
  return {menu,caseId,resultId,threadId,get page(){return page;},get prepared(){return prepared;},get executed(){return executed;},get active(){return active;},changeVersion:()=>version++};
}
test('native Case review selects an exact target, previews disclosure and ignores a canceled confirmation',async()=>{
  const f=fixture();f.menu.open();await waitFor(()=>f.page?.kind==='select');
  f.page.routes[3]();f.page.routes[2]();assert.match(f.page.title,/不是独立裁决/);assert.match(f.page.title,/整条Case不再公开/);
  f.page.routes[1]();const stale=f.page.onConfirm;f.page.onConfirm('Explain source');stale('Stale text');
  f.page.routes[2]();f.page.onConfirm('Owner dispute statement');f.page.routes[5]();await waitFor(()=>f.page.kind==='select'&&f.page.options.some(o=>o.title==='允许本次内容与范围'));
  assert.equal(f.prepared.targetEventId,f.resultId);assert.equal(f.prepared.expectedVersion,5);assert.equal(f.prepared.visibility,'Private');
  assert.deepEqual(f.prepared.review,{type:'dispute',state:'opened'});assert.equal(f.prepared.reason,'Explain source');
  const staleConfirmation=f.page.routes[1];f.page.onBack();staleConfirmation();assert.equal(f.executed,0);
  f.page.routes[3]();f.page.routes[2]();f.page.routes[5]();await waitFor(()=>f.page.kind==='select'&&f.page.options.some(o=>o.title==='允许本次内容与范围'));
  assert.equal(f.prepared.visibility,'Public');
  const scope=f.page.options.find(option=>option.number==='1').description;
  assert.ok(scope.includes('Owner dispute statement'));assert.match(scope,/所有人/);
  f.page.routes[2]();assert.equal(f.page.kind,'info');assert.ok(f.page.message.includes(JSON.stringify(f.prepared)));
  assert.equal(f.executed,0);f.page.onConfirm();f.page.routes[1]();
  await waitFor(()=>f.page.kind==='info'&&f.executed===1);assert.match(f.page.message,/原记录保留/);f.page.onConfirm();assert.equal(f.active,false);
});
test('native review offers legal lifecycle transitions and requires a fresh history version',async()=>{
  const f=fixture();f.menu.open();await waitFor(()=>f.page?.kind==='select');f.page.routes[4]();f.page.routes[1]();
  assert.match(f.page.title,/Original concern/);assert.match(f.page.title,/Owner response/);assert.equal(f.page.options.length,1);
  f.page.routes[1]();f.page.routes[1]();f.page.onConfirm('Reopen reason');f.page.routes[2]();f.page.onConfirm('New concern');f.page.routes[5]();
  await waitFor(()=>f.page.kind==='select'&&f.page.options.some(o=>o.title==='允许本次内容与范围'));assert.deepEqual(f.prepared.review,{threadId:f.threadId,type:'correction',state:'reopened'});
  const stale=fixture();stale.changeVersion();stale.menu.open();await waitFor(()=>stale.page?.kind==='info'&&stale.page.message.includes('version changed'));
  assert.equal(stale.prepared,undefined);
});
