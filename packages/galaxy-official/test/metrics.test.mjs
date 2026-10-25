import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/http.mjs';
import { createOperationalMetrics,startMetricsListener,closeMetricsListener,loadMetricsConfiguration } from '../src/operations/metrics.mjs';
const values=async(metrics,name)=>(await metrics.registry.getSingleMetric('galaxy_'+name).get()).values;

test('real HTTP metrics count successful, failed and streamed responses with bounded labels',async()=>{
  const metrics=createOperationalMetrics({component:'api',defaultMetrics:false});
  metrics.builderProbe({processed:true,state:'reachable'});metrics.builderProbe({processed:true,state:'private-url-value'});
  assert.equal((await values(metrics,'builder_probe_observations_total')).length,1);
  const bindings={endpoint:'https://official.example.org'};
  const api=createApi({bindings,metrics,readiness:async()=>false,
    keyring:{fixture:true},docsMcp:async(_request,response)=>{response.write('银河');response.end(Buffer.from('ok'));}});
  api.listen(0,'127.0.0.1');await once(api,'listening');
  bindings.endpoint='https://127.0.0.1:'+api.address().port;
  const listener=await startMetricsListener(metrics,0),origin='http://127.0.0.1:'+api.address().port;
  try{
    for(const path of ['/healthz','/readyz','/private-subject-secret'])await (await fetch(origin+path)).arrayBuffer();
    assert.equal(await (await fetch(origin+'/mcp/docs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'银河'})})).text(),'银河ok');
    const samples=await values(metrics,'http_requests_total');
    assert.equal(samples.reduce((sum,s)=>sum+s.value,0),4);
    assert.equal(samples.find(s=>s.labels.route==='GET /readyz').labels.status,'503');
    assert.equal((await values(metrics,'http_response_body_bytes_total')).find(s=>s.labels.route==='POST /mcp/docs').value,8);
    assert.equal((await values(metrics,'http_request_body_bytes_total')).find(s=>s.labels.route==='POST /mcp/docs').value,Buffer.byteLength(JSON.stringify({method:'银河'})));
    assert.equal((await values(metrics,'http_in_flight'))[0].value,0);
    const response=await fetch('http://127.0.0.1:'+listener.address().port+'/metrics'),body=await response.text();
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/plain|openmetrics/);
    assert.match(body,/galaxy_http_requests_total/);assert.doesNotMatch(body,/private-subject-secret|Bearer|payloadJson/);
    assert.match(body,/galaxy_cost_input_available\{component="api"\} 0/);
    assert.doesNotMatch(body,/galaxy_cost_amount/);
    assert.equal((await fetch(origin+'/metrics')).status,404);
    assert.equal((await fetch('http://127.0.0.1:'+listener.address().port+'/metrics?private=x')).status,404);
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await closeMetricsListener(listener);}
});

test('cached collection coalesces scrapes, clears failed values and keeps unavailable measurements explicit',async()=>{
  let reads=0,autonomyReads=0,fail=false,now=2000000000000,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const row={database_bytes:'12000',pending:2,running:1,completed:4,failed:0,active:1,oldest:30,revoked_jobs:1,oldest_revocation:5,
    dependent_revoked_jobs:2,oldest_dependent_revocation:6,invalidated_search_documents:0,connected:2,evidence_bearing:1};
  const metrics=createOperationalMetrics({component:'api',defaultMetrics:false,now:()=>now,db:{async query(sql){const autonomy=sql.includes('operations_autonomy_configs_v1');if(autonomy)autonomyReads++;else reads++;await gate;if(fail)throw new Error('Private backend value');return {rows:[autonomy?{enabled:1,health_available:true,tick_age:20,tick_limit:150,late:0,stalled:0}:row]};}}});
  const a=metrics.render(),b=metrics.render();release();await Promise.all([a,b]);assert.equal(reads,1);assert.equal(autonomyReads,1);
  assert.equal((await values(metrics,'database_bytes'))[0].value,12000);
  assert.equal((await values(metrics,'revocation_dependent_open_jobs'))[0].value,2);
  assert.equal((await values(metrics,'revocation_oldest_dependent_job_age_seconds'))[0].value,6);
  fail=true;now+=16000;const failed=await metrics.render();
  assert.equal(reads,2);assert.equal(autonomyReads,2);assert.match(failed,/galaxy_database_collection_success\{component="api"\} 0/);assert.match(failed,/galaxy_autonomy_collection_success\{component="api"\} 0/);
  assert.doesNotMatch(failed,/galaxy_database_bytes\{component="api"\}/);
  assert.equal((await values(metrics,'revocation_dependent_open_jobs')).length,0);
  assert.doesNotMatch(failed,/stage="connected"|Private backend value/);
  const worker=createOperationalMetrics({component:'worker',defaultMetrics:false,now:()=>now});
  worker.workerIteration({processed:true,state:'observed'},0.25);worker.workerIteration({budgetLimited:true},0.01);
  assert.equal((await values(worker,'worker_iterations_total')).find(s=>s.labels.outcome==='observed').value,1);
  assert.equal((await values(worker,'worker_last_iteration_timestamp_seconds'))[0].value,now/1000);
});

test('cost and filesystem inputs are explicit and report real local capacity',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-metrics-'));
  try{
    const path=join(directory,'cost.json'),cost={version:1,currency:'USD',kind:'operator-estimate',amount:12.5,budget:30,
      periodStart:'2026-09-01T00:00:00Z',periodEnd:'2026-10-01T00:00:00Z',observedAt:'2026-09-10T00:00:00Z'};
    await writeFile(path,JSON.stringify(cost));
    const config=await loadMetricsConfiguration({GALAXY_METRICS_PORT:'9464',GALAXY_METRICS_STORAGE_DIRECTORY:directory,GALAXY_METRICS_COST_FILE:path});
    const metrics=createOperationalMetrics({component:'api',defaultMetrics:false,cacheMs:0,...config});await metrics.render();
    assert.equal((await values(metrics,'cost_amount'))[0].value,12.5);
    const storage=await values(metrics,'storage_bytes');
    assert.ok(storage.find(s=>s.labels.kind==='total').value>0);
    assert.ok(storage.find(s=>s.labels.kind==='available').value<=storage.find(s=>s.labels.kind==='total').value);
    await writeFile(path,JSON.stringify({...cost,currency:'CNY',kind:'billing-export',amount:25}));
    await metrics.render();
    assert.deepEqual((await values(metrics,'cost_amount')).map(s=>({currency:s.labels.currency,kind:s.labels.kind,value:s.value})),[{currency:'CNY',kind:'billing-export',value:25}]);
    assert.equal((await values(metrics,'cost_observed_timestamp_seconds'))[0].value,Date.parse(cost.observedAt)/1000,'reading again must not freshen billing observation time');
    await writeFile(path,'invalid cost input');await metrics.render();
    assert.equal((await values(metrics,'cost_input_available'))[0].value,0);
    assert.equal((await values(metrics,'cost_amount')).length,0);
    assert.equal((await values(metrics,'cost_observed_timestamp_seconds')).length,0);
    assert.ok((await values(metrics,'cost_last_success_timestamp_seconds'))[0].value>0);
    await writeFile(path,JSON.stringify(cost));await metrics.render();
    assert.equal((await values(metrics,'cost_input_available'))[0].value,1);
    assert.equal((await values(metrics,'cost_amount'))[0].value,12.5);
    await assert.rejects(loadMetricsConfiguration({GALAXY_METRICS_PORT:'NaN'}));
    assert.equal((await loadMetricsConfiguration({})).cost,null);
  }finally{await rm(directory,{recursive:true,force:true});}
});
