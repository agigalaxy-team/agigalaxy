import test from 'node:test';
import assert from 'node:assert/strict';
// Match the real server assembly, which initializes the existing database /
// migration catalog before importing operation-domain readers. No DB is opened.
import "../src/infrastructure/database.mjs";
import {normalizeAnalyticsRetention} from '../src/shared/analytics-retention.mjs';
import {analyticsRetention} from "../../../apps/galaxy-admin/src/lib/analytics/analytics-view-model.ts";
import {OperationsAgentOsQueryTools} from "../src/operations/agentos/query-tools.mjs";

test('AI queries and the analytics UI share native cohort maturity, preserve elapsed zero and never report future zero as churn',async()=>{
 const checkedAt=Date.parse('2026-10-24T23:30:00Z')/1000,
  raw=[{cohort_interval:'Weighted Average',sum:10,values:[10,0,0,0],percentages:[1,0,0,0]},
   {cohort_interval:'2026-10-18',sum:10,values:[10,0,0,0],percentages:[1,0,0,0]},
   {cohort_interval:'2026-10-04',sum:10,values:[10,0,0,0],percentages:[1,0,0,0]}],original=structuredClone(raw);
 const utc=normalizeAnalyticsRetention(raw,checkedAt,'UTC'),recent=utc.rows.find(row=>row.cohort==='2026-10-18'),old=utc.rows.find(row=>row.cohort==='2026-10-04');
 assert.equal(recent.cells[0].state,'recorded');assert.deepEqual(recent.cells[1],{week:1,count:null,ratio:null,state:'not-reached'});
 assert.deepEqual(old.cells[1],{week:1,count:0,ratio:0,state:'recorded'});assert.equal(old.cells[3].state,'not-reached');
 assert.equal(utc.rows[0].average,true);assert.equal(utc.rows[0].cells[1].state,'recorded');assert.equal(utc.rows[0].cells[3].state,'not-reached');
 const unknown=normalizeAnalyticsRetention(raw,checkedAt,null),unknownCell=unknown.rows.find(row=>row.cohort==='2026-10-18').cells[1];
 assert.deepEqual(unknownCell,{week:1,count:null,ratio:null,state:'unknown'});
 assert.deepEqual(normalizeAnalyticsRetention(raw,checkedAt,undefined),unknown);
 assert.deepEqual(normalizeAnalyticsRetention(raw,checkedAt,'not-an-iana-zone'),unknown);
 assert.equal(normalizeAnalyticsRetention(raw,checkedAt,'Asia/Tokyo').rows.find(row=>row.cohort==='2026-10-18').cells[1].state,'recorded','only the acknowledged native zone may advance the cohort calendar');
 assert.equal(normalizeAnalyticsRetention([{...raw[1],cohort_interval:'2026-02-31'}],checkedAt,'UTC'),null);
 assert.equal(normalizeAnalyticsRetention(raw,NaN,'UTC'),null);assert.deepEqual(normalizeAnalyticsRetention([],checkedAt,null),{rows:[],weeks:[]});
 assert.equal(normalizeAnalyticsRetention([raw[0]],checkedAt,'UTC').rows[0].cells[1].state,'unknown','an isolated average has no observed maturity reference');
 assert.deepEqual(raw,original,'normalization does not change the native source');assert.deepEqual(analyticsRetention(raw,checkedAt,'UTC'),utc);
 const actor={kind:'business-operator'},authority={now:()=>checkedAt,human:async value=>{assert.equal(value,actor);return value;}};
 const tools=new OperationsAgentOsQueryTools({authority,services:{analytics:{analytics:async(_actor,input)=>({kind:input.kind,data:raw,checkedAt,basis:{window:'native-last-12-weeks',interval:'week',timezone:{name:'UTC',source:'native-acknowledged'}},source:'openpanel-native'})}}});
 const result=await tools.execute({actor,domain:'discovery',tool:'query-operations',arguments:{module:'analytics',view:'retention',filters:{days:90}}});
 assert.deepEqual(result.data.data,utc);assert.equal(result.data.basis.window,'native-last-12-weeks');assert.equal(result.data.data.rows.find(row=>row.cohort==='2026-10-18').cells[1].count,null);
});
