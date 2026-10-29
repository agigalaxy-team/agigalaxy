import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchActionCards,workbenchCardPath} from "../src/lib/workbench/workbench-action-cards.ts";
test('workbench cards retain the server operation and current domain without leaking private command metadata or foreign receipts',()=>{
 const raw={cardId:'11111111-1111-4111-8111-111111111111',operationId:'22222222-2222-4222-8222-222222222222',kind:'feedback-update',domain:'governance',state:'prepared',target:{kind:'feedback',id:'INTERNAL_ID',label:'提交失败的反馈',href:'javascript:alert(1)'},title:'更新反馈',impact:['状态改为处理中'],basis:[{label:'来源',value:'本人使用反馈'}],requiredAction:'feedback.update',capability:{canConfirm:true},checkedAt:1000,readExpiresAt:1030,command:{password:'PRIVATE_COMMAND'},result:{operationId:'33333333-3333-4333-8333-333333333333',summary:'FOREIGN_RESULT'}};
 const [card]=workbenchActionCards([raw],'governance');assert.equal(card.operationId,raw.operationId);assert.equal(card.capability.canConfirm,true);assert.equal(card.target.href,null);assert.equal(card.result,null);
 for(const hidden of ['PRIVATE_COMMAND','INTERNAL_ID','FOREIGN_RESULT'])assert.equal(JSON.stringify(card).includes(hidden),false);
 assert.deepEqual(workbenchActionCards([raw],'overview'),[]);assert.deepEqual(workbenchActionCards([{...raw,kind:'arbitrary-http'}],'governance'),[]);
 assert.equal(workbenchActionCards([{...raw,state:'unknown',target:{...raw.target,href:'/admin/operations/feedback?id=one'}}],'governance')[0].capability.canConfirm,false);
 assert.equal(workbenchCardPath('governance',raw.cardId),'/v1/operations/agentos/conversations/governance/cards/'+raw.cardId);
});


test('typed queue and index cards retain the concrete reviewed target and unknown outcomes cannot confirm again',()=>{
 for(const kind of ['job-cancel','job-retry','search-retry']){
  const domain=kind==='search-retry'?'discovery':'maintenance',targetId='33333333-3333-4333-8333-333333333333',
   raw={cardId:'11111111-1111-4111-8111-111111111111',operationId:'22222222-2222-4222-8222-222222222222',kind,domain,state:'prepared',target:{kind:kind==='search-retry'?'search-job':'queue-job',label:'具体失败任务',href:'/admin/operations/jobs'},title:'处理这项任务',impact:['重试只表示重新排队'],basis:[{label:'任务 ID',value:targetId},{label:'当前状态',value:'failed'}],requiredAction:kind==='search-retry'?'search.retry':kind==='job-cancel'?'jobs.cancel':'jobs.retry',capability:{canConfirm:true},checkedAt:1000,readExpiresAt:1030};
  const card=workbenchActionCards([raw],domain)[0];assert.equal(card.operationId,raw.operationId);assert.equal(card.basis[0].value,targetId);assert.equal(card.capability.canConfirm,true);
  assert.equal(workbenchActionCards([{...raw,state:'unknown'}],domain)[0].capability.canConfirm,false);
 }
});


test('strategy cards preserve complete reviewed differences and refuse incomplete review',()=>{
 const raw={cardId:'11111111-1111-4111-8111-111111111111',operationId:'22222222-2222-4222-8222-222222222222',kind:'strategy-draft',domain:'overview',state:'prepared',target:{kind:'strategy',label:'策略',href:'/admin/operations/strategy'},title:'保存策略',impact:Array.from({length:80},(_,i)=>`差异 ${i}\n完整内容`),basis:[{label:'当前管理版本',value:'3'}],requiredAction:'strategies.configure',capability:{canConfirm:true},checkedAt:1000,readExpiresAt:1030};
 for(const kind of ['strategy-draft','strategy-rehearsal','strategy-publish']){
  const card=workbenchActionCards([{...raw,kind}],'overview')[0];assert.deepEqual(card.impact,raw.impact);assert.deepEqual(card.basis,raw.basis);assert.equal(card.capability.canConfirm,true);
  for(const bad of [{impact:[]},{basis:[]},{impact:[...raw.impact,'超出行数']},{impact:['x'.repeat(5001)]},{impact:Array(5).fill('x'.repeat(5000))},{basis:[{label:'版本',value:'x'.repeat(5001)}]}]){
   const invalid=workbenchActionCards([{...raw,...bad,kind}],'overview')[0];assert.equal(invalid.capability.canConfirm,false);assert.equal(invalid.capability.reason,'strategy-review-unavailable');
  }
 }
});
