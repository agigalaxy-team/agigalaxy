import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StrategyRehearsalResult} from '../src/components/StrategyRehearsalResult.tsx';
import {AutonomyTaskControls} from '../src/components/AutonomyTaskControls.tsx';

const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-'+String(n).padStart(12,'0');
test('execution preview describes actual failed checks and per-action eligibility without exposing long identifiers',()=>{
 const strategy={id:id(1),name:'治理执行策略',enabled:true,execution:{}},preview={strategyId:strategy.id,valid:false,checks:[{key:'handler:content.hide',state:'fail',detail:null},{key:'source:content.hide:'+id(4),state:'unknown',detail:null},{key:'current-role',state:'pass',detail:null}],objects:[{action:'content.hide',id:id(4),kind:'post',available:true,version:id(5),revision:3}],grants:[{id:id(6),version:2}],scope:{kind:'eligible'},qualification:'checked-before-each-action',classification:'configuration-and-current-consumer',semanticJudgment:'not-validated',sideEffects:false,modelCalls:0};
 const value={valid:false,sideEffects:false,modelCalls:0,uncoveredStrategyIds:[strategy.id],samples:[],executionPreviews:[preview]},html=renderToStaticMarkup(createElement(StrategyRehearsalResult,{value,configuration:{strategies:[strategy]}}));
 assert.match(html,/治理执行策略/);assert.match(html,/处理服务尚未接通/);assert.match(html,/当前条件尚不能核对/);assert.match(html,/每次办理前逐一核对/);assert.match(html,/语义判断尚未验证/);assert.match(html,/模型调用 0/);assert.match(html,/授权 1 · 版本 2/);assert.doesNotMatch(html,/[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

test('a manual decision exposes only explicit rejection choices for an unresolved controlled call',()=>{
 const task={id:id(1),revision:2,state:'waiting-human',source:'routine',availableControls:['stop'],humanDecision:null,pendingCalls:[{callId:'call_1',operationId:id(2),tool:'execute-operation',code:'operations_autonomy_human_required'}],continuation:{allowed:false,decisions:[]}},render=value=>renderToStaticMarkup(createElement(AutonomyTaskControls,{task:value,csrfToken:'test-nonce',onChanged:async()=>{}}));
 const html=render(task);assert.match(html,/拒绝这项请求/);assert.match(html,/取消这项请求/);assert.match(html,/本项无需办理/);assert.doesNotMatch(html,/批准|业务已完成|沿原任务继续/);
 assert.doesNotMatch(render({...task,availableControls:[]}),/拒绝这项请求/);assert.doesNotMatch(render({...task,source:'workbench'}),/拒绝这项请求/);assert.doesNotMatch(render({...task,humanDecision:{kind:'takeover'}}),/拒绝这项请求/);
 assert.doesNotMatch(render({...task,continuation:{allowed:true,decisions:[{callId:'call_1',operationId:id(2),state:'rejected',basis:'persisted-human-decision'}]}}),/拒绝这项请求/);
});
