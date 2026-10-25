import test from 'node:test';
import assert from 'node:assert/strict';
import {AutonomyReadModel} from '../src/operations/autonomy/views.mjs';

const id='11111111-1111-4111-8111-111111111111';
function fixture({usage,sourceAllowed=true,state='completed',modelState='completed'}={}){
 const row={id,domain:'overview',source:'workbench',mode:'human-ai',state,model_state:modelState,business_state:'not-started',revision:3,
  configuration:{},native_run_id:'exact-recorded-run',model_usage:usage,created_at:new Date(0),updated_at:new Date(1000)};
 let nativeReads=0,queries=0,sourceChecks=0;
 const db={async query(sql){queries++;assert.match(sql,/^(?:SELECT call_id|SELECT operation_id)/);return{rows:[]};}};
 const service=Object.assign(Object.create(AutonomyReadModel.prototype),{db,endpoint:'https://task-usage.synthetic.invalid',
  async checkTarget(actor,current){sourceChecks++;assert.equal(current,row);if(!sourceAllowed)throw Object.assign(Error('denied'),{status:403});},
  async continuationWithin(){return{allowed:false,decisions:[]};},async workbenchHrefWithin(){return null;},
  client:{async runDetail(){nativeReads++;throw Error('Task reads cannot substitute native metadata for persisted usage.');}},
 });
 return{row,read:()=>service.taskView(db,row,{businessAuthorization:{permissions:[]}}),counts:()=>({nativeReads,queries,sourceChecks})};
}

test('task detail projects only its persisted usage and keeps model completion separate from business effects',async()=>{
 for(const sample of [
  {state:'failed',modelState:'failed',usage:{calls:7,inputTokens:87888,outputTokens:3656,totalTokens:91544,durationMs:64692.19797896221}},
  {state:'completed',modelState:'completed',usage:{calls:11,inputTokens:130185,outputTokens:18114,totalTokens:148299,durationMs:62966.154811903834}},
 ]){
  const owner=fixture(sample),result=await owner.read();
  assert.equal(result.calls,sample.usage.calls);assert.deepEqual(result.tokens,{input:sample.usage.inputTokens,output:sample.usage.outputTokens,total:sample.usage.totalTokens});
  assert.equal(result.durationMs,sample.usage.durationMs);assert.equal(result.state,sample.state);assert.equal(result.modelState,sample.modelState);
  assert.equal(result.businessState,'not-started');assert.deepEqual(result.businessReceipts,[]);assert.equal(owner.counts().nativeReads,0);
 }
});

test('persisted zero, absent usage and invalid values remain distinct without exposing extra ledger fields',async()=>{
 const zero=await fixture({usage:{calls:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:0,privatePrompt:'PRIVATE_TEXT'}}).read();
 assert.equal(zero.calls,0);assert.equal(zero.durationMs,0);assert.deepEqual(zero.tokens,{input:0,output:0,total:0});assert.doesNotMatch(JSON.stringify(zero),/PRIVATE_TEXT|privatePrompt/);
 for(const usage of [undefined,null,{}, {calls:'7',inputTokens:-1,outputTokens:Infinity,totalTokens:NaN,durationMs:'12'}]){
  const result=await fixture({usage}).read();assert.equal(result.calls,null);assert.equal(result.durationMs,null);assert.deepEqual(result.tokens,{input:null,output:null,total:null});
 }
 const partial=await fixture({usage:{calls:null,inputTokens:4,outputTokens:null,totalTokens:null,durationMs:0}}).read();
 assert.equal(partial.calls,null);assert.deepEqual(partial.tokens,{input:4,output:null,total:null});assert.equal(partial.durationMs,0);
});

test('task source authorization still precedes usage and receipt projection',async()=>{
 const owner=fixture({sourceAllowed:false,usage:{calls:7,totalTokens:91544}});
 await assert.rejects(owner.read(),{status:403});assert.deepEqual(owner.counts(),{nativeReads:0,queries:0,sourceChecks:1});
});
