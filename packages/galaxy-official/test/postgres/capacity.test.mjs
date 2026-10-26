import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { cpus,totalmem } from 'node:os';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { serviceFixture } from '../service-fixture.mjs';
import { createApi } from '../../src/http.mjs';
import { defaultRequestQuotaPolicy } from '../../src/adapters/http/request-quotas.mjs';
import { defaultResourceBudgetPolicy } from '../../src/infrastructure/resource-budgets.mjs';
import { createOperationalMetrics } from '../../src/operations/metrics.mjs';

test('isolated PostgreSQL capacity baseline, default throttling and degraded revocation',{timeout:180000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1','Use isolated PostgreSQL launcher');
  const db=new pg.Pool({max:2,statement_timeout:10000});
  let apiDb,server;
  const phases=[];
  const now=Math.floor(Date.now()/1000);
  const policy=structuredClone(defaultRequestQuotaPolicy);
  for(const category of Object.values(policy.categories))for(const dimension of Object.keys(category))category[dimension]=1000000;
  const resourcePolicy=structuredClone(defaultResourceBudgetPolicy);
  const listen=async f=>{
    server=createApi({...f,requestQuotaPolicy:policy,resourceBudgetPolicy:resourcePolicy,metrics:createOperationalMetrics({component:'api',defaultMetrics:false})});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;
  };
  const close=async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}};
  const run=async(name,url,lanes)=>{
    const lag=monitorEventLoopDelay({resolution:10});lag.enable();
    const before=Number((await db.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
    const cpu=process.cpuUsage();let peakRss=process.memoryUsage().rss;
    const timer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},25);
    const child=fork(fileURLToPath(new URL('../capacity-driver.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,NODE_TEST_CONTEXT:''}});
    const exit=new Promise(resolve=>child.once('exit',resolve));
    let deadline;
    try{
      const result=await new Promise((resolve,reject)=>{
        deadline=setTimeout(()=>reject(new Error('Capacity phase timed out')),45000);
        child.once('message',message=>message.ok?resolve(message.result):reject(new Error(message.error)));
        child.once('error',()=>reject(new Error('Capacity driver could not start')));
        child.once('exit',code=>{if(code!==0)reject(new Error('Capacity driver exited'));});
        child.send({url,lanes});
      });
      const phase={name,...result,apiProcessCpuMicroseconds:process.cpuUsage(cpu),apiProcessPeakRssBytes:peakRss,
        eventLoopP99Ms:lag.percentile(99)/1e6,databaseGrowthBytes:Number((await db.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes)-before};
      phases.push(phase);
      console.log(JSON.stringify({phase:name,responses:result.responses,statusCodes:result.statusCodes,p99Ms:result.latencyMs.p99}));
      assert.equal(result.errors,0);assert.equal(result.timeouts,0);
      return result;
    }finally{clearTimeout(deadline);clearInterval(timer);lag.disable();child.kill();await exit;}
  };
  const request=(f,path,body)=>({method:body===undefined?'GET':'POST',path,headers:{authorization:'Bearer '+f.credential,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const rootFor=f=>({id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Capacity fixture',summary:'Synthetic bounded payload '+ 'x'.repeat(512),source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]});
  try{
    await migrate(db);
    await db.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    apiDb=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
    const fixtures=[];
    for(let i=0;i<8;i++)fixtures.push(await serviceFixture(['binding','consent','case-teaser'],apiDb,{migrateDatabase:false,repositories:apiReads,now,resourceBudgetPolicy:resourcePolicy}));
    let url=await listen(fixtures[0]);
    for(const connections of [1,4,8]){
      const lanes=[],roots=[];
      for(let i=0;i<connections;i++){
        const f=fixtures[i],lane=[];
        for(let j=0;j<96/connections;j++){const root=rootFor(f);roots.push(root);lane.push(request(f,'/v1/cases',await f.authorize(root)));}
        lanes.push(lane);
      }
      const result=await run('create-case-c'+connections,url,lanes);
      assert.equal(result.statusCodes['200']?.count,96);
      assert.equal(Number((await db.query('SELECT count(*) FROM cases WHERE id=ANY($1::uuid[])',[roots.map(root=>root.id)])).rows[0].count),96);
      const readLanes=lanes.map((_,i)=>Array.from({length:96/connections},()=>request(fixtures[i],'/v1/cases/'+roots[i*(96/connections)].id)));
      const read=await run('read-case-c'+connections,url,readLanes);assert.equal(read.statusCodes['200']?.count,96);
    }
    await close();
    // A fresh API window restores the actual default quotas for the burst phase.
    Object.assign(policy,structuredClone(defaultRequestQuotaPolicy));url=await listen(fixtures[0]);
    const f=fixtures[0],roots=[],lanes=Array.from({length:4},()=>[]);
    for(let i=0;i<64;i++){const root=rootFor(f);roots.push(root);lanes[i%4].push(request(f,'/v1/cases',await f.authorize(root)));}
    const burst=await run('default-quota-burst',url,lanes);
    assert.equal(burst.statusCodes['200']?.count,30);assert.equal(burst.statusCodes['429']?.count,34);
    assert.equal(Number((await db.query('SELECT count(*) FROM cases WHERE id=ANY($1::uuid[])',[roots.map(root=>root.id)])).rows[0].count),30);
    const started=performance.now();
    const revoked=await fetch(url+'/v1/bindings/'+f.actor.bindingId+'/revoke',{method:'POST',headers:{authorization:'Bearer '+f.credential,'content-type':'application/json'},body:'{}'});
    assert.equal(revoked.status,200);await revoked.arrayBuffer();const revokeAfterBurstMs=performance.now()-started;
    await close();
    // Stop new payload growth without blocking revocation or existing reads.
    Object.assign(policy,structuredClone(defaultRequestQuotaPolicy));resourcePolicy.maxPayloadBytesPerSubject=0;
    const g=fixtures[1];g.access.resourceBudgetPolicy.maxPayloadBytesPerSubject=0;
    url=await listen(g);const newRoot=rootFor(g);
    const rejected=await fetch(url+'/v1/cases',{method:'POST',headers:{authorization:'Bearer '+g.credential,'content-type':'application/json'},body:JSON.stringify(await g.authorize(newRoot))});
    assert.equal(rejected.status,409);assert.equal((await rejected.json()).error,'storage_quota_exceeded');
    const degraded=await fetch(url+'/v1/bindings/'+g.actor.bindingId+'/revoke',{method:'POST',headers:{authorization:'Bearer '+g.credential,'content-type':'application/json'},body:'{}'});
    assert.equal(degraded.status,200);await degraded.arrayBuffer();
    const report={version:1,timestamp:new Date().toISOString(),kind:'synthetic-local-postgres-capacity-baseline',node:process.version,postgres:(await db.query('SHOW server_version')).rows[0].server_version,
      host:{platform:process.platform,arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},poolSize:8,tool:'autocannon8.0.0',phases,
      defaultQuotaBurst:{accepted:30,rejected:34,revokeAfterBurstMs},degraded:{payloadGrowthRejected:true,revocationAvailable:true},
      capacityPolicyHash:createHash('sha256').update(JSON.stringify(defaultResourceBudgetPolicy)).digest('hex'),
      limits:['short finite loopback HTTP batches;not sustained throughput','consent setup excluded;small synthetic payloads','generator separate process;API-process CPU excludes PostgreSQL CPU','default quota burst latency mixes success and429','no TLS/proxy/remote-network/worker fetch/billing measurement','no production capacity or SLA claim']};
    const directory=new URL('../../../../outputs/capacity/',import.meta.url);await mkdir(directory,{recursive:true});
    const file=new URL('baseline-'+Date.now()+'.json',directory);await writeFile(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({capacityReport:fileURLToPath(file)}));
  }finally{await close();if(apiDb)await apiDb.end();await db.end();}
});
