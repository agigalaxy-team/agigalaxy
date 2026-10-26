import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchActionCards,workbenchCardPath} from '../src/lib/workbench-action-cards.ts';
test('workbench cards retain the server operation and current domain without leaking private command metadata or foreign receipts',()=>{
 const raw={cardId:'11111111-1111-4111-8111-111111111111',operationId:'22222222-2222-4222-8222-222222222222',kind:'feedback-update',domain:'governance',state:'prepared',target:{kind:'feedback',id:'INTERNAL_ID',label:'提交失败的反馈',href:'javascript:alert(1)'},title:'更新反馈',impact:['状态改为处理中'],basis:[{label:'来源',value:'本人使用反馈'}],requiredAction:'feedback.update',capability:{canConfirm:true},checkedAt:1000,readExpiresAt:1030,command:{password:'PRIVATE_COMMAND'},result:{operationId:'33333333-3333-4333-8333-333333333333',summary:'FOREIGN_RESULT'}};
 const [card]=workbenchActionCards([raw],'governance');assert.equal(card.operationId,raw.operationId);assert.equal(card.capability.canConfirm,true);assert.equal(card.target.href,null);assert.equal(card.result,null);
 for(const hidden of ['PRIVATE_COMMAND','INTERNAL_ID','FOREIGN_RESULT'])assert.equal(JSON.stringify(card).includes(hidden),false);
 assert.deepEqual(workbenchActionCards([raw],'overview'),[]);assert.deepEqual(workbenchActionCards([{...raw,kind:'arbitrary-http'}],'governance'),[]);
 assert.equal(workbenchActionCards([{...raw,state:'unknown',target:{...raw.target,href:'/admin/operations/feedback?id=one'}}],'governance')[0].capability.canConfirm,false);
 assert.equal(workbenchCardPath('governance',raw.cardId),'/v1/operations/agentos/conversations/governance/cards/'+raw.cardId);
});
