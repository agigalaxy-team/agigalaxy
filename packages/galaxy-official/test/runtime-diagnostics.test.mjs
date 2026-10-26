import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {safeRuntimeError,withRuntimeDiagnosticContext} from '../src/shared/runtime-diagnostics.mjs';
import {runtimeLogEvent,installRuntimeFailureHandlers} from '../src/operations/runtime-log.mjs';
import {createOperationsJobs} from "../src/operations/jobs/service.mjs";
import {openDatabase,transaction} from "../src/infrastructure/database.mjs";
import {createApi} from '../src/http.mjs';
import {failureRoute} from '../src/adapters/http/failure-audit.mjs';

const secret='private-credential-and-message-must-never-appear';
function databaseError(){
  const error=Object.assign(new Error(secret),{code:'23505',detail:secret,query:secret,path:secret,password:secret});
  error.stack=`Error: ${secret}\n    at privateFunction (file:///opt/galaxy/releases/0.1.22/packages/galaxy-official/src/infrastructure/database.mjs:17:9)\n    at privateFunction (https://secret.example/${secret}?code=${secret}:1:2)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)`;
  return error;
}

test('diagnostics keep machine cause and source locations without messages, URLs, SQL or arbitrary fields',()=>{
  const cause=databaseError(),error=new Error(secret,{cause});
  error.name=secret;error.code=secret;
  const view=safeRuntimeError(error);
  assert.equal(view.errorName,'Error');assert.equal(view.errorCode,'unclassified_error');
  assert.equal(view.cause.errorCode,'23505');
  assert.deepEqual(view.cause.stackFrames,[{file:"packages/galaxy-official/src/infrastructure/database.mjs",line:17,column:9},
    {file:'node:internal/process/task_queues',line:105,column:5}]);
  assert.doesNotMatch(JSON.stringify(view),new RegExp(secret+'|privateFunction|secret.example|/opt/galaxy'));
  assert.equal(runtimeLogEvent({event:'operations_job_failed',stage:secret,error:cause,body:secret}).stage,undefined);
  const formatted=runtimeLogEvent({event:'operations_job_failed',error:cause});
  assert.deepEqual(runtimeLogEvent(formatted),formatted,'a boundary and a sink can both safely format the same diagnostic');
  const child=Object.assign(new Error(secret),{cmd:secret,code:2,stdout:secret,stderr:secret});
  assert.equal(safeRuntimeError(child).errorExitCode,2);assert.doesNotMatch(JSON.stringify(safeRuntimeError(child)),new RegExp(secret));
  const id=randomUUID();
  assert.equal(failureRoute('GET','/v1/account/public/'+id+'/posts'),'GET /v1/account/public/:id/posts');
  assert.equal(failureRoute('GET','/v1/account/public/by-uid/G12345678901'),'GET /v1/account/public/by-uid/:uid');
  assert.equal(failureRoute('POST','/v1/operations/jobs/information-watch/'+id+'/retry'),'POST /v1/operations/jobs/information-watch/:id/retry');
  assert.equal(runtimeLogEvent({event:'http_completed',route:'GET /v1/account/public/:id/posts'}).route,'GET /v1/account/public/:id/posts');
  for(const event of ['operations_job_failed','operations_job_finished','information_watch_deferred','chat_transport_unavailable',
    'chat_retention_deferred','external_credentials_status_unavailable','product_lifecycle_cleanup','attachment_processing_deferred',
    'ci_v2_observation_job','content_publication_worker_started','content_publication_step_failed'])
    assert.equal(runtimeLogEvent({event}).event,event);
});

test('job diagnostics use exact job/request scope while persisted failures retain only the old machine-code output',async()=>{
  class Boss extends EventEmitter{
    async start(){}
    async work(_name,_options,handler){this.handler=handler;return randomUUID();}
    async stop(){}
  }
  const boss=new Boss(),records=[],jobId=randomUUID(),requestId=randomUUID();
  const jobs=createOperationsJobs({db:{query(){assert.fail('consumer setup must not query here');}},boss,
    onError:input=>records.push(runtimeLogEvent({event:'operations_job_failed',...input}))});
  await jobs.work('information-watch',async()=>{throw databaseError();});
  await withRuntimeDiagnosticContext({requestId},async()=>{
    await assert.rejects(boss.handler([{id:jobId,name:'information-watch',retryCount:2,data:{body:secret}}]),error=>
      error.message==='operations_job_failed'&&error.code==='operations_job_failed'&&error.cause===undefined);
  });
  assert.equal(records.length,1);assert.equal(records[0].requestId,requestId);assert.equal(records[0].jobId,jobId);
  assert.equal(records[0].queue,'information-watch');assert.equal(records[0].attempt,2);
  assert.equal(records[0].errorCode,'23505');assert.ok(records[0].durationMs>=0);
  assert.doesNotMatch(JSON.stringify(records),new RegExp(secret));
  await jobs.stop();
});

test('pool and rollback diagnostics preserve the operation error and discard the broken connection',async()=>{
  const records=[],pool=openDatabase('postgresql://synthetic:synthetic@127.0.0.1:1/unused',
    {logger:input=>records.push(runtimeLogEvent(input))});
  const operationError=new Error(secret),rollbackError=databaseError();let discarded;
  pool.connect=async()=>({async query(sql){if(sql==='ROLLBACK')throw rollbackError;},release(error){discarded=error;}});
  try{
    pool.emit('error',databaseError());
    await assert.rejects(transaction(pool,async()=>{throw operationError;}),error=>error===operationError);
    assert.equal(discarded,rollbackError);
    assert.deepEqual(records.map(row=>row.stage),['database-pool','transaction-rollback']);
    assert.ok(records.every(row=>row.errorCode==='23505'));
    assert.doesNotMatch(JSON.stringify(records),new RegExp(secret));
  }finally{await pool.end();}
});

test('HTTP joins failure and completion by API-generated ID, template and elapsed time without public header authority',async()=>{
  const records=[],publicRequestId=randomUUID();
  const api=createApi({bindings:{endpoint:'https://fixture.example'},
    access:{authenticate:async()=>({subjectId:'GUID'+'A'.repeat(28),bindingId:randomUUID()})},
    cases:{submit:async()=>{throw databaseError();}},logger:input=>records.push(runtimeLogEvent(input))});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${api.address().port}/v1/cases`,{method:'POST',headers:{
      'Content-Type':'application/json','Authorization':'Bearer '+secret,'X-Request-Id':publicRequestId},
      body:JSON.stringify({consentId:'fixture',payloadJson:JSON.stringify({kind:'case',privateMaterial:secret})})});
    assert.equal(response.status,500);await response.arrayBuffer();
    await new Promise(resolve=>setImmediate(resolve));
    const requestId=response.headers.get('X-Request-Id');assert.notEqual(requestId,publicRequestId);
    const failed=records.find(row=>row.event==='http_rejected'),completed=records.find(row=>row.event==='http_completed');
    assert.equal(failed.requestId,requestId);assert.equal(completed.requestId,requestId);
    assert.equal(failed.route,'POST /v1/cases');assert.equal(failed.stage,'http-dispatch');
    assert.equal(failed.errorCode,'23505');assert.ok(failed.durationMs>=0);assert.ok(completed.durationMs>=0);
    assert.doesNotMatch(JSON.stringify(records),new RegExp(secret));
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
});

test('fatal runtime errors invoke the drain once and never print unknown rejection input',async()=>{
  const target=new EventEmitter(),records=[];let drains=0;
  const dispose=installRuntimeFailureHandlers({process:target,logger:input=>records.push(runtimeLogEvent(input)),onFatal:()=>{drains++;}});
  target.emit('unhandledRejection',secret);target.emit('uncaughtException',databaseError());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(drains,1);assert.equal(target.exitCode,1);assert.equal(records.length,1);
  assert.equal(records[0].event,'runtime_unhandled_rejection');assert.equal(records[0].errorCode,'unclassified_error');
  assert.doesNotMatch(JSON.stringify(records),new RegExp(secret));dispose();
  assert.equal(target.listenerCount('uncaughtException'),0);
});
