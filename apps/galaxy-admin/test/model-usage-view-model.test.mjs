import assert from 'node:assert/strict';
import test from 'node:test';
import {modelUsage,modelUsageNumber,modelUsageCoverage,modelUsageCallSegments,modelUsageRows} from "../src/lib/models/model-usage-view-model.ts";
const id='11111111-1111-4111-8111-111111111111',calls={total:4,completed:2,failed:1,unknown:1},tokens={input:100,output:20,total:null,cachedInput:0,reasoning:null};
const value=()=>({availability:{state:'available'},days:7,from:'2026-10-23T05:00:00+00:00',to:'2026-10-23T09:00:00+00:00',coverageFrom:'2026-10-23T05:00:00+00:00',coversWholeWindow:false,calls,tokens,unknownUsageCalls:1,byScenario:[{domain:'discovery',calls,tokens,unknownUsageCalls:1}],byModel:[{modelRecordId:id,calls,tokens,unknownUsageCalls:1}],basis:{source:'native-model-gateway-ledger',billing:'not-provided'},checkedAt:1792746000,readExpiresAt:1792746030,metadataOnly:true});

test('native reported token values preserve unknown/zero and are never recomputed or enlarged with billing/private metadata',()=>{
 const raw=value();raw.tokens.cost=123;raw.byModel[0].apiKey='NEVER_SHOW';raw.prompt='NEVER_SHOW';const projected=modelUsage(raw);assert.ok(projected);assert.equal(projected.tokens.input,100);assert.equal(projected.tokens.output,20);assert.equal(projected.tokens.total,null);assert.equal(projected.tokens.cachedInput,0);assert.equal(projected.tokens.reasoning,null);assert.ok(!JSON.stringify(projected).includes('NEVER_SHOW'));assert.equal(projected.tokens.cost,undefined);assert.equal(modelUsageNumber(null),'—');assert.equal(modelUsageNumber(0),'0');assert.equal(modelUsageNumber(-1),'—');assert.equal(modelUsageNumber(Number.MAX_SAFE_INTEGER+1),'—');
 const missing=modelUsage({...raw,availability:{state:'unavailable'}});assert.equal(missing.calls.total,null);assert.equal(missing.tokens.input,null);assert.deepEqual(missing.byModel,[]);
});

test('new ledger coverage retains the actual partial period and does not imply a complete seven-day history',()=>{
 const projected=modelUsage(value()),coverage=modelUsageCoverage(projected);assert.equal(coverage.complete,false);assert.ok(coverage.range.includes('2026/10/23'));assert.ok(coverage.start.includes('13:00'));assert.equal(projected.from,value().from);
 const missing=modelUsage({...value(),coverageFrom:undefined,coversWholeWindow:undefined});assert.equal(modelUsageCoverage(missing).complete,null);assert.equal(modelUsageCoverage(missing).start,null);
 const full=modelUsage({...value(),from:'2026-10-16T09:00:00+00:00',coverageFrom:'2026-10-15T09:00:00+00:00',coversWholeWindow:true});assert.equal(modelUsageCoverage(full).complete,true);
});

test('grouped summaries use real model names and fixed domains without filling absent groups or inventing a trend',()=>{
 const raw=value();raw.byScenario.push({domain:'private-chat',calls,tokens,unknownUsageCalls:1});raw.byModel.push({modelRecordId:'raw-provider-address',calls,tokens,unknownUsageCalls:1});const projected=modelUsage(raw);
 assert.equal(projected.byScenario.length,1);assert.equal(projected.byModel.length,1);assert.equal(modelUsageRows(projected,'scenario')[0].label,'内容与发现');assert.equal(modelUsageRows(projected,'model',{[id]:'真实配置名称'})[0].label,'真实配置名称');assert.equal(modelUsageRows(projected,'model',{})[0].label,'模型名称未记录');assert.equal(projected.series,undefined);
 assert.deepEqual(modelUsageCallSegments(calls).map(row=>row.percent),[50,25,25]);assert.equal(modelUsageCallSegments({...calls,total:7}),null);assert.equal(modelUsageCallSegments({...calls,unknown:null}),null);assert.equal(modelUsageCallSegments({total:0,completed:0,failed:0,unknown:0}),null);
});
