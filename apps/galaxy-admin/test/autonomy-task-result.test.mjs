import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AutonomyTaskResult} from '../src/components/autonomy/AutonomyTaskResult.tsx';
const section=(facts,options={})=>({availability:'available',complete:true,scope:'adopted-river-and-components',window:{requestedDays:null,from:null,to:null},coverage:{sampleComplete:null,sampleLimit:null,includesAllPlatformQueues:false,sourceWithheld:false},facts,findingCodes:[],...options});
test('inspection facts preserve bounded scope, unknown and zero separately from analysis',()=>{
 const task={summary:'原摘要',inspectionReport:{profileComplete:true,accessComplete:false,sections:{maintenance:section({componentTotal:0,queueCounts:{failed:null}},{findingCodes:['maintenance-unhealthy']}),search:section(null,{availability:'not-authorized',complete:false,window:null,coverage:null,findingCodes:['not-authorized']})}},finalAnalysis:{state:'available',text:'分析建议'}};
 const html=renderToStaticMarkup(createElement(AutonomyTaskResult,{task}));
 for(const expected of ['已接入业务队列','不代表全部平台队列','未取得','组件健康异常','未获读取权限','原目标评估摘要','原摘要','AI 分析与建议','分析建议','部分来源当前不可读取'])assert.ok(html.includes(expected),expected);
 assert.match(html,/组件总数<\/dt><dd>0<\/dd>/);
});
test('withheld or oversized analysis is not presented as complete',()=>{
 const render=finalAnalysis=>renderToStaticMarkup(createElement(AutonomyTaskResult,{task:{summary:null,inspectionReport:null,finalAnalysis}}));
 assert.match(render({state:'withheld',reason:'source-unverified'}),/当前无法读取最终分析/);
 assert.match(render({state:'too-large',reason:'text-limit'}),/超过保存上限，未保存/);
 assert.match(render(null),/本轮未保存最终分析/);
});

test('explicitly withheld assessment does not fall back to old summary',()=>{const html=renderToStaticMarkup(createElement(AutonomyTaskResult,{task:{summary:'不得显示旧摘要',assessmentSummary:null,inspectionReport:null,finalAnalysis:null}}));assert.doesNotMatch(html,/不得显示旧摘要/);});

test('created strategies use actual IDs and do not turn partial or denied into empty success',()=>{const render=x=>renderToStaticMarkup(createElement(AutonomyTaskResult,{task:{summary:null,strategyArtifacts:x}}));const found=render({availability:'available',items:[{operationId:'op1',sourceStrategyId:'source1',sourceVersionId:'version1',newStrategyId:'new1',versionId:'version2'}],collectionComplete:true,limit:50});assert.match(found,/strategy=new1/);assert.match(found,/来源模板 source1/);assert.match(found,/version=version2/);const partial=render({availability:'partial',items:[],collectionComplete:false,limit:50});assert.match(partial,/仅显示当前可读取的部分结果/);assert.doesNotMatch(partial,/没有已完成/);assert.match(render({availability:'not-authorized',items:[],collectionComplete:false,limit:50}),/无权读取策略来源/);assert.doesNotMatch(render({availability:'available',items:[],collectionComplete:true,limit:50}),/本任务创建的策略/);});
