import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { platform, arch, cpus, totalmem } from 'node:os';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { workerReads } from '../../src/infrastructure/worker-reads.mjs';
import { serviceFixture } from '../service-fixture.mjs';
import { createApi } from '../../src/http.mjs';
import { createOperationalMetrics } from '../../src/operations/metrics.mjs';
import { defaultRequestQuotaPolicy } from '../../src/adapters/http/request-quotas.mjs';
import { defaultResourceBudgetPolicy } from '../../src/infrastructure/resource-budgets.mjs';
import { EvidenceService } from '../../src/evidence.mjs';
import { ConsentReader } from '../../src/consent-reader.mjs';
import { inspectGithubRun } from '../../src/github-evidence.mjs';

test('sustained mixed HTTP load overlaps Worker leases and preserves revocation',{timeout:150000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1','Use isolated PostgreSQL launcher');
  const db=new pg.Pool({max:2,statement_timeout:10000});
  let apiDb,workerDb,server,child,childExit,workerRun,sampler,revocation;
  let stop=false;
  const workerResults=[],samples=[],roots=[],lanes=[],fixtures=[];
  const clock=()=>Math.floor(Date.now()/1000)+60;
  const resources=structuredClone(defaultResourceBudgetPolicy),requestPolicy=structuredClone(defaultRequestQuotaPolicy);
  for(const category of Object.values(requestPolicy.categories))for(const key of Object.keys(category))category[key]=1000000;
  const rootFor=f=>({id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Mixed capacity',summary:'Synthetic '+ 'x'.repeat(512),
    source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]});
  const httpRequest=(f,path,body)=>({method:body===undefined?'GET':'POST',path,headers:{authorization:'Bearer '+f.credential,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const lag=monitorEventLoopDelay({resolution:10});
  try{
    await migrate(db);
    for(const role of ['api','worker'])await db.query(await readFile(new URL('../../src/infrastructure/'+role+'-role.sql',import.meta.url),'utf8'));
    apiDb=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
    workerDb=new pg.Pool({max:4,options:'-c role=galaxy_evidence_worker',statement_timeout:10000});
    let revokeGrant,revokeEvidence;
    for(let i=0;i<8;i++){
      const f=await serviceFixture(['binding','consent','case-teaser','evidence'],apiDb,{migrateDatabase:false,repositories:apiReads,now:clock(),resourceBudgetPolicy:resources});fixtures.push(f);
      const parent=rootFor(f);await f.cases.submit(f.actor,await f.authorize(parent));
      const attempt={id:randomUUID(),kind:'attempt',caseId:parent.id,expectedVersion:1,sequence:1,approach:'Synthetic',configuration:{environment:'mixed-load',version:'1',tools:[]}};
      await f.cases.submit(f.actor,await f.authorize(attempt));
      const result={id:randomUUID(),kind:'result',caseId:parent.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Synthetic',failureReason:'',limitations:['Fixture only']};
      await f.cases.submit(f.actor,await f.authorize(result));
      for(let j=0;j<12;j++){
        const value={id:randomUUID(),caseId:parent.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'mixed',runId:i*12+j+1,attempt:1,commit:'c'.repeat(40)}};
        const grant=await f.authorize(value,'evidence.submit');await f.evidence.submit(f.actor,grant);
        if(i===7&&j===11){revokeGrant=grant.consentId;revokeEvidence=value.id;}
      }
      const lane=[];
      for(let j=0;j<60;j++){
        const root=rootFor(f);roots.push(root);
        lane.push(httpRequest(f,'/v1/cases',await f.authorize(root)),httpRequest(f,'/v1/cases/'+parent.id));
      }
      lanes.push(lane);
    }
    const metrics=createOperationalMetrics({component:'api',db:apiDb,now:()=>clock()*1000,defaultMetrics:false});
    server=createApi({...fixtures[0],requestQuotaPolicy:requestPolicy,metrics});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
    let completed=0;
    const cpu=process.cpuUsage(),started=performance.now();lag.enable();
    sampler=(async()=>{
      while(!stop){
        const row=(await db.query("SELECT count(*) FILTER(WHERE state='pending')::int AS pending,count(*) FILTER(WHERE state='running' AND locked_until>$1)::int AS active,count(*) FILTER(WHERE state='completed')::int AS completed FROM jobs",[new Date(clock()*1000).toISOString()])).rows[0];
        const maxSubject=(await db.query("SELECT coalesce(max(n),0)::int AS n FROM (SELECT count(*) AS n FROM jobs j JOIN evidence_submissions e ON e.id::text=j.payload->>'evidenceId' WHERE j.state='running' AND j.locked_until>$1 GROUP BY e.subject_id) s",[new Date(clock()*1000).toISOString()])).rows[0].n;
        samples.push({elapsedMs:Math.round(performance.now()-started),...row,maxSubjectActive:maxSubject,rssBytes:process.memoryUsage().rss});
        await metrics.render();
        await delay(250);
      }
    })();
    const verify=async(source,at)=>{
      await delay(1000); // Explicit synthetic external verifier latency, not live GitHub.
      return inspectGithubRun(source,{id:source.runId,run_attempt:1,head_sha:source.commit,repository:{full_name:'fixture/mixed',id:1,private:false},
        updated_at:new Date(at*1000).toISOString(),status:'completed',conclusion:'success'},at);
    };
    workerRun=Promise.all(Array.from({length:4},async()=>{
      const worker=new EvidenceService(null,new ConsentReader({now:clock,readGrant:workerReads.readGrant}),{db:workerDb,endpoint:fixtures[0].access.endpoint,now:clock,readCase:workerReads.readCase,resourceBudgetPolicy:resources});
      while(!stop&&completed<96&&performance.now()-started<90000){
        const result=await worker.processNext(verify);
        if(result.processed){completed++;workerResults.push(result.state);}
        else await delay(25);
      }
    }));
    // Preserve rejection visibility even while the HTTP child is still running.
    void workerRun.catch(()=>{});void sampler.catch(()=>{});
    revocation=(async()=>{
      await delay(15000);
      if(stop)return null;
      const begin=performance.now();
      const f=fixtures[7],response=await fetch(url+'/v1/consents/'+revokeGrant+'/revoke',{method:'POST',headers:{authorization:'Bearer '+f.credential,'content-type':'application/json'},body:'{}'});
      assert.equal(response.status,200);await response.arrayBuffer();
      return {elapsedIntoRunMs:Math.round(begin-started),ackMs:performance.now()-begin};
    })();void revocation.catch(()=>{});
    child=fork(fileURLToPath(new URL('../capacity-driver.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,NODE_TEST_CONTEXT:''}});
    childExit=new Promise(resolve=>child.once('exit',resolve));
    let timeout;
    const load=await new Promise((resolve,reject)=>{
      timeout=setTimeout(()=>reject(new Error('Sustained driver timed out')),75000);
      child.once('message',message=>message.ok?resolve(message.result):reject(new Error(message.error)));
      child.once('error',()=>reject(new Error('Sustained driver failed')));
      child.once('exit',code=>{if(code!==0)reject(new Error('Sustained driver exited'));});
      child.send({url,lanes,overallRate:32});
    }).finally(()=>clearTimeout(timeout));
    const acknowledged=await revocation;
    await workerRun;stop=true;await sampler;lag.disable();
    assert.equal(load.responses,960);assert.equal(load.statusCodes['200']?.count,960);assert.equal(load.errors,0);assert.equal(load.timeouts,0);
    assert.ok(load.durationSeconds>=25,'Rate-limited phase must sustain arrivals');
    assert.equal(Number((await db.query('SELECT count(*) FROM cases WHERE id=ANY($1::uuid[])',[roots.map(root=>root.id)])).rows[0].count),480);
    assert.equal(workerResults.length,96);assert.equal(workerResults.filter(state=>state==='revoked').length,1);
    assert.equal(workerResults.filter(state=>state==='observed').length,95);
    assert.equal((await db.query('SELECT state FROM evidence_submissions WHERE id=$1',[revokeEvidence])).rows[0].state,'revoked');
    assert.equal(Number((await db.query("SELECT count(*) FROM jobs WHERE state IN ('pending','running')")).rows[0].count),0);
    assert.ok(samples.some(sample=>sample.active===4));
    assert.ok(samples.every(sample=>sample.active<=4&&sample.maxSubjectActive<=1));
    await metrics.render();
    const metricSum=async name=>(await metrics.registry.getSingleMetric('galaxy_'+name).get()).values.reduce((sum,sample)=>sum+sample.value,0);
    const measured={httpRequests:await metricSum('http_requests_total'),requestBodyBytes:await metricSum('http_request_body_bytes_total'),
      responseBodyBytes:await metricSum('http_response_body_bytes_total'),databaseCollectionSuccess:await metricSum('database_collection_success'),collectionCacheMs:15000};
    assert.equal(measured.httpRequests,961);assert.ok(measured.requestBodyBytes>0);assert.ok(measured.responseBodyBytes>0);assert.equal(measured.databaseCollectionSuccess,1);
    const report={version:1,timestamp:new Date().toISOString(),kind:'sustained-api-worker-mix',node:process.version,postgres:(await db.query('SHOW server_version')).rows[0].server_version,
      host:{platform:platform(),architecture:arch(),logicalCpus:cpus().length,totalMemoryBytes:totalmem()},
      load,metrics:measured,worker:{completed:96,observed:95,revoked:1,concurrency:4,syntheticVerifierDelayMs:1000},revocation:acknowledged,
      cpuMicroseconds:process.cpuUsage(cpu),eventLoopP99Ms:lag.percentile(99)/1e6,samples,
      limits:['loopback HTTP;no public TLS/network/billing','API and Worker services share one Node process;CPU/RSS include setup and both roles','verifier supplies synthetic evidence with1s delay;no actual external calls','eight subjects;480 unique writes and480 reads;frequency quotas elevated for calibration','30second rate-limited sample;not a soak or saturation capacity claim']};
    const directory=new URL('../../../../outputs/capacity/',import.meta.url);await mkdir(directory,{recursive:true});
    const file=new URL('sustained-'+Date.now()+'.json',directory);await writeFile(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({sustainedReport:fileURLToPath(file),responses:load.responses,p99Ms:load.latencyMs.p99,workerCompleted:96,revocationAckMs:acknowledged.ackMs}));
  }finally{
    stop=true;if(child){child.kill();await childExit;}
    await Promise.allSettled([workerRun,sampler,revocation].map(value=>Promise.resolve(value)));
    lag.disable();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(workerDb)await workerDb.end();if(apiDb)await apiDb.end();await db.end();
  }
});
