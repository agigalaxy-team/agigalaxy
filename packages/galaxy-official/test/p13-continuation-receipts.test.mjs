import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {p13Fixture} from './p13-strategies-fixture.mjs';
import {P13StrategiesService} from '../src/operations/strategies/service.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('P13 original human continuation receipts recover before pause checks without a second decision or read-side dispatch',{timeout:60000},async t=>{
 const f=await p13Fixture(t),first=await f.task(),second=await f.task(),configuration=f.configuration({mode:'human-led'}),strategy=configuration.strategies[0];
 await f.publish(configuration,[first.execution.id,second.execution.id]);
 const pauseId=randomUUID()+':0',receipts=new Map();let dispatches=0,reads=0,failBefore=false,failAfter=true,unavailable=false;
 // Native HTTP/queue is explicit here. The companion native leaf uses the
 // actual fixed Agno/PostgreSQL queue and transaction, with no provider call.
 f.native.continuation=async(row,operationId)=>{reads++;if(unavailable)return null;const ctx=await f.service.nativeContext({runId:row.id,executionId:row.execution_id,operation:'read',continuationOperationId:operationId});
  return{operationId,runId:row.id,nativeRunId:ctx.continuation.nativeRunId,pauseId:ctx.continuation.pauseId,state:receipts.has(operationId)?'accepted':'not-recorded'};};
 f.native.continue=async(row,input)=>{dispatches++;const ctx=await f.service.nativeContext({runId:row.id,executionId:row.execution_id,operation:'run',continuationOperationId:input.operationId});
  assert.equal(ctx.continuation.pauseId,pauseId);assert.equal(ctx.continuation.confirmed,input.confirmed);
  if(failBefore){failBefore=false;throw new ServiceError('operations_agentos_native_failed',503);}
  receipts.set(input.operationId,ctx.continuation);f.nativeRuns.set(row.id,{...f.nativeRuns.get(row.id),status:'RUNNING',awaitingHuman:false,pauseId:null});
  if(failAfter){failAfter=false;throw new ServiceError('operations_agentos_native_failed',503);}
 };
 const prepare=async task=>{const id=randomUUID();await f.service.run(f.admin,{operationId:id,strategyId:strategy.id,executionId:task.execution.id},{authorize:async()=>f.admin});await f.service.step({runId:id,executionId:task.execution.id,nativeRunId:id,phase:'prepare'});f.nativeRuns.set(id,{runId:id,status:'PAUSED',awaitingHuman:true,pauseKind:'confirmation',pauseId,workflowId:'galaxy-p13-selected-content-v1',workflowVersion:1});return id;};
 const runId=await prepare(first),operationId=randomUUID(),input={operationId,confirmed:true},authorize=async()=>f.admin;
 await assert.rejects(f.service.continue(f.admin,runId,input,{authorize}),{code:'operations_agentos_native_failed'});
 assert.equal(dispatches,1);assert.equal((await f.service.operation(f.admin,operationId)).continuation.state,'accepted');assert.equal(dispatches,1,'GET never dispatches');
 const saved=(await f.db.query('SELECT input,result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[f.endpoint,operationId])).rows[0];
 assert.deepEqual(saved.input,{...input,runId});assert.deepEqual(saved.result.continuation,{nativeRunId:runId,pauseId});
 const restarted=new P13StrategiesService({...f.service});
 assert.equal((await restarted.continue(f.admin,runId,input,{authorize})).continuation.state,'accepted');assert.equal(dispatches,1,'restarted service replays accepted receipt while native is RUNNING');
 await assert.rejects(restarted.continue(f.admin,runId,{operationId,confirmed:false},{authorize}),{code:'p13_operation_conflict'});
 f.nativeRuns.get(runId).awaitingHuman=true;f.nativeRuns.get(runId).pauseId=pauseId;
 await assert.rejects(restarted.continue(f.admin,runId,{operationId:randomUUID(),confirmed:false},{authorize}),{code:'p13_pause_decision_already_recorded'});assert.equal(dispatches,1);
 unavailable=true;assert.equal((await restarted.operation(f.admin,operationId)).continuation.state,'unknown');assert.equal((await restarted.continue(f.admin,runId,input,{authorize})).continuation.state,'unknown');assert.equal(dispatches,1,'unknown receipt is never re-dispatched');unavailable=false;
 const otherRun=await prepare(second),otherOperation=randomUUID(),otherInput={operationId:otherOperation,confirmed:true};failBefore=true;
 await assert.rejects(restarted.continue(f.admin,otherRun,otherInput,{authorize}),{code:'operations_agentos_native_failed'});assert.equal(dispatches,2);
 assert.equal((await restarted.operation(f.admin,otherOperation)).continuation.state,'not-recorded');assert.equal(dispatches,2,'known pre-acceptance failure is only read by GET');
 assert.equal((await restarted.continue(f.admin,otherRun,otherInput,{authorize})).continuation.state,'accepted');assert.equal(dispatches,3,'only original POST with the same binding can finish the unaccepted decision');
 await assert.rejects(restarted.nativeContext({runId:runId,executionId:first.execution.id,operation:'read',continuationOperationId:otherOperation}),{code:'p13_native_binding_denied'});
 await f.db.query('UPDATE operations_automation_grants_v1 SET enabled=false,version=version+1 WHERE id=$1',[second.grant.id]);
 await assert.rejects(restarted.operation(f.admin,otherOperation),{code:'operations_agentos_authority_changed'});assert.equal(dispatches,3);
 // Already deployed legacy receipts lack a native pause binding. They must
 // stay unknown instead of being silently re-applied to a current pause.
 const legacyId=randomUUID();await f.db.query("INSERT INTO operations_p13_strategy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,'continue',$4,$5,$6)",[f.endpoint,legacyId,f.admin.operatorId,JSON.stringify({operationId:legacyId,confirmed:true,runId}),JSON.stringify({operationId:legacyId,runId,confirmed:true}),new Date(f.now()*1000)]);
 assert.equal((await restarted.continue(f.admin,runId,{operationId:legacyId,confirmed:true},{authorize})).continuation.state,'unknown');assert.equal(dispatches,3);assert.ok(reads>0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_content_visibility_v1')).rows[0].n,0,'receipt recovery never executes a business effect');
});
