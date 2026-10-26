import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationsAgentOsQueryTools} from "../src/operations/agentos/query-tools.mjs";
import {P13StrategiesReadModel} from '../src/operations/strategies/read-model.mjs';

// Exercise the actual strategy read-model DTO producer and query adapter.
// Database rows and current authorization are explicit in-memory doubles;
// this leaf does not claim PostgreSQL, native runtime or model coverage.
test('strategy query projects direct version DTOs without changing record history or exposing configuration', async()=>{
 const now=2000000000,endpoint='https://strategy-projection.example.invalid',
  actor={kind:'business-operator',operatorId:'synthetic-operator',endpoint},
  versionId='11111111-1111-4111-8111-111111111111',recordId='22222222-2222-4222-8222-222222222222',
  strategyId='33333333-3333-4333-8333-333333333333',runId='44444444-4444-4444-8444-444444444444',
  createdAt='2033-05-18T03:33:20.000Z',checks=[],queries=[];
 const versions=[7,6].map((version,index)=>({id:index?'55555555-5555-4555-8555-555555555555':versionId,version,
  configuration:{common:{objective:'PRIVATE_OBJECTIVE'},strategies:[{instructions:'PRIVATE_INSTRUCTIONS'}]},
  created_by:'PRIVATE_OPERATOR_IDENTIFIER',created_by_display_name:'真实来源的管理显示名',created_at:createdAt,
  parent_id:null,ordinary_strategy_id:null,ordinary_execution_id:null}));
 const records=[{id:recordId,sequence:9,version_id:versionId,strategy_id:strategyId,run_id:runId,kind:'publish',
  operator_id:'PRIVATE_OPERATOR_IDENTIFIER',operator_display_name:'真实来源的管理显示名',
  metadata:{reason:'PRIVATE_RECORD_REASON'},created_at:createdAt}];
 const requireAction=async(value,action)=>{assert.equal(value,actor);checks.push(action);return value;},
  db={query:async(sql,args)=>{
   assert.equal(args[0],endpoint);queries.push({sql,args});
   if(sql.includes('FROM operations_p13_strategy_versions_v1'))return{rows:versions};
   if(sql.includes('FROM operations_p13_strategy_events_v1'))return{rows:records};
   assert.fail('Unexpected query');
  }},
  strategies=new P13StrategiesReadModel({db,endpoint,businessAdmin:{permissions:{requireAction}},now:()=>now}),
  authority={now:()=>now,human:async(value,{action})=>requireAction(value,action)},
  tools=new OperationsAgentOsQueryTools({authority,services:{strategies}}),
  query=(view,filters)=>tools.execute({actor,domain:'overview',tool:'query-operations',arguments:{module:'strategies',view,filters}});

 const result=await query('versions',{limit:1});
 assert.equal(result.data.items[0].version,7,'versionView returns a numeric version directly, not a nested history version');
 assert.deepEqual(result.data.items,[{id:versionId,version:7,createdAt}]);
 assert.equal(result.pagination.complete,false);
 assert.deepEqual(result.pagination.next,{module:'strategies',view:'versions',filters:{limit:1,after:'7'}});
 assert.equal(result.checkedAt,now);assert.equal(result.readExpiresAt,now+30);
 assert.equal(queries[0].args[2],2,'actual producer reads one extra row for pagination');

 const history=await query('records',{limit:20,strategyId});
 assert.equal(history.data.items.length,1);
 assert.equal(history.data.items[0].id,recordId);assert.equal(history.data.items[0].sequence,'9');
 assert.equal(history.data.items[0].kind,'publish');assert.equal(history.data.items[0].createdAt,createdAt);
 assert.equal(history.data.items[0].operatorDisplayName,'真实来源的管理显示名');
 assert.equal(history.data.items[0].strategyId,strategyId);assert.equal(history.data.items[0].runId,runId);
 assert.equal(history.pagination.complete,true);assert.equal(history.pagination.next,null);
 assert.equal(queries[1].args[2],strategyId);
 for(const secret of ['PRIVATE_OBJECTIVE','PRIVATE_INSTRUCTIONS','PRIVATE_OPERATOR_IDENTIFIER','PRIVATE_RECORD_REASON'])
  assert(!JSON.stringify([result,history]).includes(secret),secret);
 assert.deepEqual(checks,['workbench.read','strategies.read','strategies.read','strategies.read','workbench.read','strategies.read',
  'workbench.read','strategies.read','strategies.read','strategies.read','workbench.read','strategies.read']);
});
