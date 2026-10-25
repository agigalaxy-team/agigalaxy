import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {aiDelegationActionKeys} from '../src/components/ai-delegation-types.ts';
import {createSettingsDraftMemory} from '../src/lib/settings-draft-memory.ts';
import {workbenchAiPromptReview,workbenchAiPromptReceipt} from '../src/lib/ai-work-prompt.ts';
import {aiManagementCapabilities,aiManagementFeatureLabel} from '../src/lib/ai-management-capabilities.ts';
import {workbenchActionCards} from '../src/lib/workbench-action-cards.ts';
import {WorkbenchActionCards} from '../src/components/workbench/WorkbenchActionCards.tsx';
import {WorkbenchManagementCapabilities} from '../src/components/workbench/WorkbenchManagementCapabilities.tsx';

const id=number=>'00000000-0000-4000-8000-'+String(number).padStart(12,'0');
const review={kind:'ai-work-prompt',aiAccountId:id(1),domain:'governance',name:'治理 AI',configId:id(2),expectedRevision:3,promptVersion:2,nextPromptVersion:3,scope:'role-work-requirements',source:'saved-configuration',before:'原岗位要求',after:'新岗位要求',effect:'new-rounds-only'};
const receipt={operationId:id(4),aiAccountId:id(1),configId:id(2),revision:4,promptVersion:3,delegationVersion:5,replayed:false};
const card={cardId:id(3),operationId:id(4),kind:'ai-work-prompt-save',domain:'overview',target:{kind:'ai-work-prompt',label:'治理 AI 的岗位工作要求',href:'/admin/operations/ai-work-accounts?domain=governance&tab=duty'},title:'修改岗位工作要求',impact:['新轮次采用新版本'],basis:[],review,requiredAction:'ai.prompts.update',capability:{canConfirm:true,canDismiss:true,reason:null},state:'prepared',result:null,checkedAt:1000,readExpiresAt:2000};
const renderCard=value=>renderToStaticMarkup(React.createElement(WorkbenchActionCards,{cards:workbenchActionCards([value],'overview'),verified:true,busy:false,pendingCardId:null,onConfirm:()=>assert.fail('SSR must not execute'),now:1200}));

test('existing delegation drafts and pending receipts stay unchanged; explicit prompt actions survive restoration without expanding roles or targets',()=>{
 const memory=createSettingsDraftMemory(),session=memory.open('principal','same-login'),oldActions=['read','create','update','assign','revoke'];
 const baseline={enabled:true,targetAiAccountIds:[id(1)],grantablePermissions:['content.hide'],allowedManagementActions:oldActions};
 const snapshot={drafts:{},editing:{},roleChoice:{},positions:[],delegationDraft:{...baseline,baseVersion:5,baseline}};
 session.write('ai-work',snapshot);session.setPending('ai-work',{operationId:id(4),kind:'delegation-save',domain:'overview'});
 assert.deepEqual(session.read('ai-work').delegationDraft.allowedManagementActions,oldActions);
 const changed=structuredClone(snapshot);changed.delegationDraft.allowedManagementActions=['prompt-update'];session.write('ai-work',changed);
 assert.deepEqual(session.read('ai-work').delegationDraft.allowedManagementActions,['prompt-update']);
 assert.deepEqual(session.read('ai-work').delegationDraft.baseline.allowedManagementActions,oldActions);
 assert.deepEqual(session.read('ai-work').delegationDraft.targetAiAccountIds,[id(1)]);
 assert.deepEqual(session.read('ai-work').delegationDraft.grantablePermissions,['content.hide']);
 session.clear('ai-work');assert.equal(session.read('ai-work'),null);assert.equal(session.pending('ai-work').operationId,id(4));
 assert.deepEqual(aiDelegationActionKeys,[...oldActions,'prompt-read','prompt-update']);
 memory.observeIdentity(null);assert.equal(session.current(),false);assert.equal(memory.open('principal','new-login').pending('ai-work'),null);
});

test('prompt cards retain both full 16000-character versions, escape markup, and keep the original confirmation path',()=>{
 const tag='<script>alert(1)</script>\n',before='前'.repeat(15996)+'原末尾!',after=tag+'新'.repeat(16000-tag.length-4)+'新末尾!';
 const value={...card,review:{...review,before,after}},parsed=workbenchActionCards([value],'overview')[0];
 assert.equal(parsed.review.before,before);assert.equal(parsed.review.after,after);assert.equal(parsed.capability.canConfirm,true);
 const html=renderCard(value);assert.ok(html.includes(before));assert.ok(html.includes('新'.repeat(15900)));assert.ok(html.includes('新末尾!'));assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.doesNotMatch(html,/<script>/);assert.match(html,/按此方案处理/);assert.doesNotMatch(html,/<details|<summary/);
 assert.equal(workbenchAiPromptReview({...review,before:'前'.repeat(16001)}),null);assert.equal(workbenchAiPromptReview({...review,scope:'system-prompt'}),null);assert.equal(workbenchAiPromptReview({...review,domain:['governance']}),null);
 const absent=workbenchActionCards([{...card,review:null}],'overview')[0];assert.equal(absent.capability.canConfirm,false);assert.equal(absent.capability.reason,'prompt-review-unavailable');assert.match(renderCard({...card,review:null}),/完整变更暂时无法取得/);assert.doesNotMatch(renderCard({...card,review:null}),/按此方案处理/);
});

test('only the bound original completed receipt can display saved prompt versions; pending and unavailable cards remain unresolved',()=>{
 assert.deepEqual(workbenchAiPromptReceipt(receipt,id(4),review),receipt);
 for(const mismatch of [{...receipt,operationId:id(8)},{...receipt,aiAccountId:id(8)},{...receipt,configId:id(8)},{...receipt,promptVersion:null}])assert.equal(workbenchAiPromptReceipt(mismatch,id(4),review),null);
 const completed={...card,state:'completed',result:{operationId:id(4),state:'completed',summary:'岗位工作要求已保存。',receipt}};
 assert.match(renderCard(completed),/原操作已保存岗位工作要求 v3/);assert.doesNotMatch(renderCard(completed),/按此方案处理/);
 assert.doesNotMatch(renderCard({...completed,result:{...completed.result,operationId:id(8)}}),/原操作已保存/);
 assert.doesNotMatch(renderCard({...completed,result:{...completed.result,receipt:{...receipt,aiAccountId:id(8)}}}),/原操作已保存/);
 for(const state of ['processing','unknown','not-available'])assert.doesNotMatch(renderCard({...completed,state}),/原操作已保存岗位工作要求|按此方案处理/);
 assert.match(renderCard({...card,state:'unknown'}),/正在读取这项处理的结果/);
});

const fact=(permission,patch={})=>({permission,systemSupport:'connected',permissionAllowed:true,delegated:true,available:true,confirmation:'operation-card',reasons:[],...patch});
const capabilities={schemaVersion:1,sourceAiAccountId:id(9),delegation:{id:id(10),version:5,enabled:true},targetAiAccounts:[{id:id(1),domain:'governance',name:'治理 AI',enabled:false}],role:Object.fromEntries(['read','create','update','assign','revoke'].map(key=>[key,fact('ai.roles.'+key)])),prompt:{scope:'role-work-requirements',read:fact('ai.prompts.read',{available:false,permissionAllowed:false,confirmation:'read-tool',reasons:['permission-missing']}),update:fact('ai.prompts.update',{available:false,delegated:false,reasons:['delegation-missing']})},ordinaryStrategy:{configure:fact('strategies.ordinary.configure',{systemSupport:'not-connected',available:false,reasons:['handler-not-connected']}),publish:fact('strategies.ordinary.publish')},modelConfiguration:fact('models.configure',{systemSupport:'human-only',available:false,confirmation:'human-console',reasons:['human-only']}),authorityBoundaries:fact('ai.delegation.configure',{systemSupport:'human-only',available:false,confirmation:'human-console',reasons:['human-only']})};

test('management hints display distinct server facts for missing permission, delegation, disconnected service and human-only settings',()=>{
 const parsed=aiManagementCapabilities(capabilities);assert.ok(parsed);assert.equal(parsed.prompt.read.available,false);assert.equal(parsed.prompt.update.available,false);
 const html=renderToStaticMarkup(React.createElement(WorkbenchManagementCapabilities,{value:capabilities}));
 for(const label of ['当前权限不足','未获管理授权','服务尚未接通','仅人工设置','治理 AI（停用）','委派 v5'])assert.ok(html.includes(label));
 assert.equal(aiManagementFeatureLabel(fact('ai.prompts.update')),'已获准 · 操作卡确认');
 assert.equal(aiManagementFeatureLabel(fact('ai.prompts.update',{confirmation:'autonomous-tool'})),'按当前任务授权处理');
 const unknown=renderToStaticMarkup(React.createElement(WorkbenchManagementCapabilities,{value:null}));assert.match(unknown,/暂时无法取得/);assert.doesNotMatch(unknown,/不支持|未接通|未获管理授权/);
 assert.equal(aiManagementCapabilities({...capabilities,prompt:{...capabilities.prompt,read:{...capabilities.prompt.read,systemSupport:['connected']}}}),null);
 assert.equal(aiManagementCapabilities({...capabilities,prompt:{...capabilities.prompt,scope:'global-system-frame'}}),null);
});
