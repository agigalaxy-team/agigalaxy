import test from 'node:test';
import assert from 'node:assert/strict';
import {taskSummaryWithin} from '../src/operations/autonomy/task-summary.mjs';
import {OperationsAutonomy} from '../src/operations/autonomy/service.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const current = {id, ai_account_id:'22222222-2222-4222-8222-222222222222',domain:'overview',source:'routine',mode:'ai',state:'running',
  config_id:'33333333-3333-4333-8333-333333333333',config_revision:7,plan_version:5,prompt_version:9,delegation_version:3,
  configuration:{prompt:'PRIVATE_PROMPT',goal:'PRIVATE_GOAL'},summary:'PRIVATE_BUSINESS_TEXT'};
function owner({denied=false,management=true}={}) {
  const calls=[], db={transaction:'current'}, actor={kind:'operations-ai-service',taskId:id,businessAuthorization:{version:13,permissions:['workbench.read','accounts.read','ai.prompts.read']}};
  const capabilities={schemaVersion:1,sourceAiAccountId:current.ai_account_id};
  return {db,actor,capabilities,calls,
    taskWithin:async(tx,key)=>{assert.equal(tx,db);assert.equal(key,id);calls.push('task');return structuredClone(current);},
    authorizeTaskWithin:async(tx,row)=>{assert.equal(tx,db);assert.equal(row.id,id);calls.push('authorize');if(denied)throw Object.assign(new Error('inactive'),{code:'operations_autonomy_task_inactive',status:409});return actor;},
    authority:{permissions:management?{managementCapabilitiesWithin:async(tx,context)=>{assert.equal(tx,db);assert.equal(context.actor,actor);calls.push('management');return capabilities;}}:{}},
    stamp:()=>({checkedAt:1000,readExpiresAt:1030}),
  };
}

test('uses current persisted task and current trusted duty actor, never caller versions or prompt text',async()=>{
  const service=owner();
  const result=await taskSummaryWithin(service,service.db,{id,prompt_version:999,configuration:{prompt:'CALLER_TEXT'}});
  assert.equal(result.task.promptVersion,9);assert.equal(result.task.planVersion,5);assert.equal(result.task.roleVersion,13);
  assert.equal(result.managementCapabilities,service.capabilities);
  assert.deepEqual(service.calls,['task','authorize','management']);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|CALLER_TEXT|configuration|credential|modelBinding/);
});
test('capability discovery cannot claim a valid business inspection or zero business totals',async()=>{
  const service=owner(),result=await taskSummaryWithin(service,service.db,{id});
  assert.equal(result.availability,'available');assert.equal(result.inspectionChecked,false);
  assert.equal(result.basis,'capability-discovery-not-business-inspection');
  for(const field of ['counts','businessCompleted','completed','expected','summary','prompt'])assert.equal(Object.hasOwn(result,field),false);
});
test('inactive/revoked task stops before any management projection',async()=>{
  const service=owner({denied:true});await assert.rejects(taskSummaryWithin(service,service.db,{id}),{code:'operations_autonomy_task_inactive'});
  assert.deepEqual(service.calls,['task','authorize']);
});
test('missing management handler is explicit and never fabricates an empty capability grant',async()=>{
  const service=owner({management:false}),result=await taskSummaryWithin(service,service.db,{id});
  assert.equal(result.managementCapabilities,null);assert.equal(result.managementAvailability,'not-configured');
  assert.deepEqual(service.calls,['task','authorize']);assert.equal(result.readExpiresAt,1030);
});
test('query availability uses the existing projector and preserves actual missing rights',async()=>{
  const service=owner(),result=await taskSummaryWithin(service,service.db,{id});
  const {agentOsQueryAccess}=await import('../src/shared/operations-agentos-query-access.mjs');
  assert.deepEqual(result.queryAccess,agentOsQueryAccess(service.actor.businessAuthorization.permissions));
  assert.notDeepEqual(result.queryAccess,agentOsQueryAccess(['workbench.read','accounts.read','chat-reports.read','chat-reports.materials.read']));
});
test('real candidate toolsWithin advertises built-in discovery for a current query role without custom summary injection',async()=>{
  const service=Object.assign(Object.create(OperationsAutonomy.prototype),{
    aiWorkAccounts:{authorizationWithin:async()=>({permissions:['accounts.read']})},queryTools:{},authority:{},
  });
  assert.deepEqual(await service.toolsWithin({},current,{}),['current-summary','query-operations','read-operation-object']);
});
test('real candidate tool path counts only explicit inspected summary or actual available query/object, not capability discovery',async()=>{
  const service=owner();let effective=0;
  const db=service.db;db.transaction=async callback=>callback(db);db.query=async(sql)=>{if(sql.includes('SET effective_check=true'))effective++;return{rows:[]};};
  const runtime=Object.assign(Object.create(OperationsAutonomy.prototype),service,{
    endpoint:'official',now:()=>1000,toolsWithin:async()=>['current-summary','query-operations','read-operation-object'],
    queryTools:{execute:async()=>({availability:'available'})},
  });
  const send=tool=>runtime.tool({taskId:id,callId:'44444444-4444-4444-8444-444444444444',tool,arguments:{}});
  const value=await send('current-summary');assert.equal(value.inspectionChecked,false);assert.equal(effective,0);
  runtime.summaryForTask=async()=>({availability:'available'});await send('current-summary');assert.equal(effective,0);
  runtime.summaryForTask=async()=>({availability:'available',inspectionChecked:true});await send('current-summary');assert.equal(effective,1);
  await send('query-operations');await send('read-operation-object');assert.equal(effective,3);
  runtime.queryTools.execute=async()=>({availability:'not-authorized'});await send('query-operations');assert.equal(effective,3);
});
