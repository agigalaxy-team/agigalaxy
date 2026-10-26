import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationsAiRunsService} from "../src/operations/agentos/runs.mjs";

const cid='11111111-1111-4111-8111-111111111111';
const v1='models-11111111-1111-4111-8111-111111111111',v2='models-22222222-2222-4222-8222-222222222222';
function fixture(extra={}){
 const raw={runId:'native-model-version',conversationId:cid,sessionId:'session-one',componentId:'galaxy-conversation-governance',componentType:'agent',domain:'governance',state:'COMPLETED',rolePromptVersion:7,...extra};
 const state={bound:true,denyAt:0,checks:[],nativeCalls:0,dbQueries:[]};
 const service=new OperationsAiRunsService({authority:{endpoint:'official',now:()=>1000,human:async(_actor,{action})=>{state.checks.push(action);if(state.checks.length===state.denyAt)throw Object.assign(new Error('operations_permission_denied'),{code:'operations_permission_denied',status:403});},db:{query:async(sql,args)=>{state.dbQueries.push({sql,args});return{rows:state.bound?[{id:cid,domain:'governance',session_id:'session-one',display_name:'管理者'}]:[]};}}},client:{runs:async()=>{state.nativeCalls++;return{items:[raw],total:1};},runDetail:async()=>{state.nativeCalls++;return{run:raw,spans:[],events:[],privateModelName:'PRIVATE_MODEL',baseUrl:'https://PRIVATE_ENDPOINT.invalid',apiKey:'PRIVATE_CREDENTIAL'};}}});
 return{service,raw,state};
}

test('normal run list and detail project only recorded version identifiers and preserve binding/checks',async()=>{
 const {service,state}=fixture({modelSettingsVersion:v2,modelSettingsVersions:[v1,v2],modelName:'PRIVATE_MODEL',baseUrl:'https://PRIVATE_ENDPOINT.invalid',apiKey:'PRIVATE_CREDENTIAL'});
 for(const result of [(await service.runs({})).items[0],(await service.runDetail({},'native-model-version')).run]){
  assert.equal(result.modelSettingsVersion,v2);assert.deepEqual(result.modelSettingsVersions,[v1,v2]);assert.equal(result.conversation?.id,cid);assert.equal(result.rolePromptVersion,7);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
 }
 assert.deepEqual(state.checks,['audit.read','audit.read','audit.read','audit.read']);assert.ok(state.dbQueries.every(q=>q.args[0]==='official'&&q.args[1]===cid));
 state.bound=false;const unbound=(await service.runDetail({},'native-model-version')).run;assert.equal(unbound.conversationId,null);assert.equal(unbound.conversation,null);assert.equal(unbound.rolePromptVersion,null);
});

test('old or unknown versions remain null without reading current configuration or deriving one field from the other',async()=>{
 const {service,raw,state}=fixture();
 for(const read of [()=>service.runs({}).then(v=>v.items[0]),()=>service.runDetail({},raw.runId).then(v=>v.run)]){
  const run=await read();assert.equal(run.modelSettingsVersion,null);assert.equal(run.modelSettingsVersions,null);
 }
 raw.modelSettingsVersions=[v1];let run=(await service.runDetail({},raw.runId)).run;assert.equal(run.modelSettingsVersion,null);assert.deepEqual(run.modelSettingsVersions,[v1]);
 raw.modelSettingsVersion=v2;raw.modelSettingsVersions=null;run=(await service.runDetail({},raw.runId)).run;assert.equal(run.modelSettingsVersion,v2);assert.equal(run.modelSettingsVersions,null);
 assert.ok(state.dbQueries.every(q=>!q.sql.includes('model_settings')));
});

test('invalid version fields fail closed as a whole, retaining only independently valid recorded fields',async()=>{
 const {service,raw}=fixture();
 for(const value of ['',0,{},'https://private.invalid',' secret','x'.repeat(129),null,undefined]){
  raw.modelSettingsVersion=value;raw.modelSettingsVersions=[v1];const run=(await service.runDetail({},raw.runId)).run;assert.equal(run.modelSettingsVersion,null);assert.deepEqual(run.modelSettingsVersions,[v1]);
 }
 for(const value of [[],v1,{},[v1,0],[v1,'https://private.invalid'],[null],null,undefined]){
  raw.modelSettingsVersion=v1;raw.modelSettingsVersions=value;const run=(await service.runDetail({},raw.runId)).run;assert.equal(run.modelSettingsVersion,v1);assert.equal(run.modelSettingsVersions,null);
 }
 raw.modelSettingsVersion='A'.repeat(128);raw.modelSettingsVersions=['A'.repeat(128),'unconfigured-v1'];const run=(await service.runDetail({},raw.runId)).run;assert.equal(run.modelSettingsVersion,'A'.repeat(128));assert.deepEqual(run.modelSettingsVersions,['A'.repeat(128),'unconfigured-v1']);
});

test('audit permission denial before fetch and revocation after fetch both suppress metadata',async()=>{
 for(const route of ['list','detail'])for(const denyAt of [1,2]){
  const {service,state}=fixture({modelSettingsVersion:v1,modelSettingsVersions:[v1]});state.denyAt=denyAt;
  await assert.rejects(route==='list'?service.runs({}):service.runDetail({},'native-model-version'),{code:'operations_permission_denied',status:403});
  assert.equal(state.nativeCalls,denyAt===1?0:1);assert.equal(state.checks.length,denyAt);
 }
});
