import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {workbenchActionCards} from '../src/lib/workbench/workbench-action-cards.ts';
import {WorkbenchActionCards} from '../src/components/workbench/WorkbenchActionCards.tsx';
const base={cardId:'11111111-1111-4111-8111-111111111111',operationId:'22222222-2222-4222-8222-222222222222',turnId:'33333333-3333-4333-8333-333333333333',kind:'feedback-update',domain:'governance',state:'prepared',target:{kind:'feedback',label:'反馈',href:'/admin/operations/feedback'},title:'内部标题',impact:['内部正文'],basis:[],requiredAction:'internal.action',capability:{canConfirm:true},checkedAt:1000,readExpiresAt:2000,presentation:{summary:'更新反馈',changes:[{label:'状态',before:'待处理',after:'处理中'}],details:[],warnings:[],reviewable:true}};
function render(item,readOnly=false){return renderToStaticMarkup(React.createElement(WorkbenchActionCards,{cards:workbenchActionCards([item],'governance'),verified:true,busy:false,pendingCardId:null,onConfirm:()=>{},now:1200,readOnly}));}
test('business presentation exclusively drives readable review and read-only records',()=>{const html=render(base);assert.match(html,/更新反馈/);assert.match(html,/待处理/);assert.match(html,/处理中/);assert.match(html,/按此方案处理/);assert.doesNotMatch(html,/内部标题|内部正文|internal.action/);assert.doesNotMatch(render(base,true),/按此方案处理/);});
test('missing, unreviewable or structured presentation cannot be confirmed',()=>{for(const presentation of [null,{...base.presentation,reviewable:false},{...base.presentation,summary:'{"raw":"value"}'}]){const value={...base,presentation};assert.equal(workbenchActionCards([value],'governance')[0].capability.canConfirm,false);const html=render(value);assert.match(html,/原业务页面处理/);assert.doesNotMatch(html,/按此方案处理|raw/);}});
