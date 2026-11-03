import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {workbenchActionCards,workbenchCardGroups,workbenchCardPath} from '../src/lib/workbench/workbench-action-cards.ts';
import {WorkbenchActionCards} from '../src/components/workbench/WorkbenchActionCards.tsx';

const base={cardId:'11111111-1111-4111-8111-111111111111',operationId:'22222222-2222-4222-8222-222222222222',turnId:'33333333-3333-4333-8333-333333333333',kind:'feedback-update',domain:'governance',state:'prepared',target:{kind:'feedback',id:'INTERNAL_ID',label:'反馈',href:'/admin/operations/feedback'},title:'RAW_INTERNAL_TITLE',impact:['{"rawImpact":"PRIVATE_IMPACT"}'],basis:[{label:'rawBasis',value:'{"secret":"PRIVATE_BASIS"}'}],requiredAction:'internal.action',command:{password:'PRIVATE_COMMAND'},capability:{canConfirm:true,canDismiss:true},checkedAt:1000,readExpiresAt:2000,presentation:{summary:'更新反馈',changes:[{label:'状态',before:'待处理',after:'处理中'}],details:[{label:'对象',value:'用户反馈'}],warnings:['处理后保留记录'],reviewable:true}};
const parsed=(raw,domain=raw.domain)=>workbenchActionCards([raw],domain)[0];
const html=(raw,readOnly=false)=>renderToStaticMarkup(React.createElement(WorkbenchActionCards,{cards:workbenchActionCards([raw],raw.domain),verified:true,busy:false,pendingCardId:null,onConfirm:()=>assert.fail('SSR must not execute'),now:1200,readOnly}));

function verifyReview(raw){
 const card=parsed(raw);assert.ok(card);assert.equal(card.operationId,base.operationId);assert.deepEqual(card.presentation,raw.presentation);assert.equal(card.capability.canConfirm,true);
 const output=html(raw);for(const value of ['更新反馈','待处理','处理中','用户反馈','处理后保留记录','按此方案处理'])assert.ok(output.includes(value));
 for(const secret of ['RAW_INTERNAL_TITLE','PRIVATE_IMPACT','PRIVATE_BASIS','PRIVATE_COMMAND','internal.action','rawImpact','rawBasis'])assert.equal(output.includes(secret),false);
 for(const presentation of [null,{...raw.presentation,reviewable:false},{...raw.presentation,summary:'{"private":"RAW_JSON"}'},{...raw.presentation,changes:[{label:'状态',before:'旧值',after:'{"raw":"RAW_JSON"}'}]},{...raw.presentation,details:null},{...raw.presentation,warnings:['x'.repeat(5001)]}]){
  const invalid={...raw,presentation},result=parsed(invalid);assert.equal(result.capability.canConfirm,false);assert.equal(result.capability.reason,'presentation-review-unavailable');const rendered=html(invalid);assert.match(rendered,/原业务页面处理/);assert.doesNotMatch(rendered,/按此方案处理|RAW_JSON/);
 }
 // Legacy payloads are compatibility data, never an independent permission
 // or review gate when the business presentation is complete.
 assert.equal(parsed({...raw,impact:[],basis:[]}).capability.canConfirm,true);
 assert.equal(parsed({...raw,capability:{canConfirm:false}}).capability.canConfirm,false);
 for(const state of ['processing','unknown','completed','not-available','not-selected'])assert.equal(parsed({...raw,state}).capability.canConfirm,false);
 assert.doesNotMatch(html(raw,true),/按此方案处理|暂不处理/);
}

test('original operation binding, destination validation and foreign receipts remain intact',()=>{
 const raw={...base,target:{...base.target,href:'javascript:alert(1)'},result:{operationId:'44444444-4444-4444-8444-444444444444',state:'completed',summary:'FOREIGN_RESULT'}};
 const card=parsed(raw);assert.equal(card.target.href,null);assert.equal(card.result,null);assert.equal(card.operationId,base.operationId);assert.equal(card.turnId,base.turnId);
 assert.doesNotMatch(html(raw),/FOREIGN_RESULT|javascript:|INTERNAL_ID/);
 assert.deepEqual(workbenchActionCards([raw],'overview'),[]);assert.deepEqual(workbenchActionCards([{...raw,kind:'arbitrary-http'}],'governance'),[]);
 assert.equal(workbenchCardPath('governance',raw.cardId),'/v1/operations/agentos/conversations/governance/cards/'+raw.cardId);
});

test('business review is complete and raw command data stays out of every supported card family',()=>{
 const families={overview:['strategy-draft','strategy-rehearsal','strategy-publish','rule-publish','rule-restore'],messaging:['messaging-state','notice-draft-create','notice-draft-save','notice-state','message-draft-create','message-draft-save'],discovery:['search-draft-save','search-apply','search-restore','search-retry','recommendation-policy-save','recommendation-theme-update'],governance:['feedback-update','content-tag-create','content-tag-update'],maintenance:['job-cancel','job-retry','file-cleanup-plan-create','file-cleanup-plan-cancel','file-cleanup-approve']};
 for(const [domain,kinds] of Object.entries(families))for(const kind of kinds)verifyReview({...base,domain,kind});
});

test('only readable business results are rendered and unselected options remain unexecutable',()=>{
 const outcome={...base,state:'completed',result:{operationId:base.operationId,state:'completed',summary:'反馈已更新。'}};
 assert.match(html(outcome),/反馈已更新/);assert.doesNotMatch(html(outcome),/按此方案处理/);
 for(const summary of ['{"private":"RAW_RESULT"}','operations_internal_result'])assert.doesNotMatch(html({...outcome,result:{...outcome.result,summary}}),/RAW_RESULT|operations_internal_result/);
 for(const changed of [{state:'not-selected'},{state:'not-available',result:{operationId:base.operationId,state:'not-selected',summary:''}},{state:'not-available',capability:{canConfirm:false,reason:'not-selected'}}]){const view=html({...base,...changed});assert.match(view,/未选用/);assert.doesNotMatch(view,/按此方案处理/);}
});


test('choice counts accept positive groups and render by group without exposing raw data',()=>{
 for(const count of [2,3,4,7]){
  const raw=Array.from({length:count},(_,index)=>({...base,cardId:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,choice:{groupId:'choices',index:index+1,count,exclusive:true}}));
  const cards=workbenchActionCards(raw,'governance');assert.equal(cards.length,count);assert.deepEqual(cards.map(card=>card.choice.index),raw.map(card=>card.choice.index));
  const output=renderToStaticMarkup(React.createElement(WorkbenchActionCards,{cards,verified:true,busy:false,pendingCardId:null,onConfirm:()=>assert.fail('SSR must not execute'),now:1200}));
  assert.match(output,/wb-action-cards--choices/);assert.doesNotMatch(output,/PRIVATE_COMMAND|rawImpact/);
 }
 for(const choice of [{groupId:'g',index:0,count:0,exclusive:true},{groupId:'g',index:3,count:2,exclusive:true},{groupId:'g',index:-1,count:2,exclusive:true},{groupId:'g',index:0,count:1.5,exclusive:true}])assert.equal(parsed({...base,choice}).choice,null);
 assert.equal(parsed({...base,choice:{groupId:'legacy',index:0,count:2,exclusive:true}}).choice.index,0);
 const single=html({...base,choice:{groupId:'g',index:1,count:1,exclusive:false}});assert.doesNotMatch(single,/wb-action-cards--choices/);
});


test('groups sort options, support partial history and keep unrelated cards separate',()=>{
 const raw=(id,choice)=>({...base,cardId:`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`,choice});
 const choice=(groupId,index,count=4)=>({groupId,index,count,exclusive:true});
 const cards=workbenchActionCards([raw(1,choice('a',3)),raw(2,null),raw(3,choice('a',1)),raw(4,choice('b',2,2)),raw(5,choice('b',1,2))],'governance');
 const groups=workbenchCardGroups(cards);assert.deepEqual(groups.map(group=>group.map(card=>card.cardId)),[[cards[2].cardId,cards[0].cardId],[cards[1].cardId],[cards[4].cardId,cards[3].cardId]]);
 const duplicate=workbenchActionCards([raw(6,choice('a',0)),raw(7,choice('a',0))],'governance');assert.equal(workbenchCardGroups(duplicate).length,2);
});

test('task assignment card preserves a user goal and separates assignment from completion',()=>{
 const goal='Compare reports mentioning {"topic":"accessibility"} and track changes.';
 const value={...base,kind:'task-dispatch',title:'交办持续分析',requiredAction:'autonomy.control',presentation:{summary:'交办持续分析',details:[{label:'工作目标',value:goal},{label:'执行安排',value:'每 37 分钟'}],changes:[],warnings:[],reviewable:true}};
 const card=parsed(value);assert.equal(card.capability.canConfirm,true);assert.equal(card.presentation.details[0].value,goal);assert.match(html(value),/按此方案处理/);
 const completed={...value,state:'completed',result:{operationId:base.operationId,state:'completed',summary:'任务已交办，首轮已排队。'}};
 assert.match(html(completed),/已交办/);assert.doesNotMatch(html(completed),/role="status">已完成/);
});
