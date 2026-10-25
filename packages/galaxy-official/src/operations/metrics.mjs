import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from '@prometheus-io/client';
import { createServer } from 'node:http';
import { lstat, readFile, statfs } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { costInputSchema } from './cost-input.mjs';
import { failureRoute } from '../adapters/http/failure-audit.mjs';
import { operationalSnapshot } from '../infrastructure/operational-snapshot.mjs';
import { backupActions,readBackupStatus } from './backup-status.mjs';
import {createAutonomyMetrics} from './autonomy/metrics.mjs';

async function readCostInput(path) {
  if(!isAbsolute(path))throw new Error('Absolute cost input path required');
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('Invalid cost input file');
  return costInputSchema.parse(JSON.parse(await readFile(path,'utf8')));
}
export async function loadMetricsConfiguration(env) {
  const port=env.GALAXY_METRICS_PORT===undefined?null:Number(env.GALAXY_METRICS_PORT);
  if(port!==null&&(!Number.isInteger(port)||port<1024||port>65535))throw new Error('Invalid metrics port');
  const storageDirectory=env.GALAXY_METRICS_STORAGE_DIRECTORY??null;
  if(storageDirectory!==null&&!isAbsolute(storageDirectory))throw new Error('Absolute metrics storage directory required');
  const costFile=env.GALAXY_METRICS_COST_FILE??null;
  const cost=costFile?await readCostInput(costFile):null;
  const backupStatusDirectory=env.GALAXY_BACKUP_STATUS_DIRECTORY??null;
  if(backupStatusDirectory!==null&&!isAbsolute(backupStatusDirectory))throw new Error('Absolute backup status directory required');
  const monitoredBackupActions=(env.GALAXY_METRICS_BACKUP_ACTIONS??'create,check,copy').split(',');
  if(!monitoredBackupActions.length||new Set(monitoredBackupActions).size!==monitoredBackupActions.length||monitoredBackupActions.some(action=>!backupActions.includes(action)))
    throw new Error('Invalid monitored backup actions');
  return {port,storageDirectory,cost,costFile,backupStatusDirectory,monitoredBackupActions};
}

export function createOperationalMetrics({component,db=null,storageDirectory=null,cost=null,costFile=null,now=Date.now,cacheMs=15000,defaultMetrics=true,logStatus=null,
  backupStatusDirectory=null,monitoredBackupActions=['create','check','copy']}){
  if(!['api','worker'].includes(component))throw new Error('Invalid metrics component');
  if(!Number.isSafeInteger(cacheMs)||cacheMs<0||cacheMs>60000)throw new Error('Invalid metrics cache');
  if(cost)cost=costInputSchema.parse(cost);
  if(costFile!==null&&!isAbsolute(costFile))throw new Error('Absolute cost input path required');
  const registry=new Registry();registry.setDefaultLabels({component});
  if(defaultMetrics)collectDefaultMetrics({register:registry,prefix:'galaxy_'});
  const counter=(name,help,labelNames=[])=>new Counter({name:'galaxy_'+name,help,labelNames,registers:[registry]});
  const gauge=(name,help,labelNames=[])=>new Gauge({name:'galaxy_'+name,help,labelNames,registers:[registry]});
  const histogram=(name,help,labelNames=[])=>new Histogram({name:'galaxy_'+name,help,labelNames,registers:[registry],buckets:[0.005,0.025,0.1,0.5,1,2.5,5,10,30]});
  const refreshAutonomy=db?createAutonomyMetrics({db,gauge,now}):null;
  const requests=counter('http_requests_total','Completed or closed application HTTP requests',['route','status']);
  const quotas=counter('resource_quota_rejections_total','Rejected resource or request quota growth',['kind']);
  const duration=histogram('http_request_duration_seconds','Application request duration to finish or close',['route','status']);
  const bytes=counter('http_response_body_bytes_total','Response body bytes handed to Node, excluding headers and TLS',['route']);
  const receivedBytes=counter('http_request_body_bytes_total','Request body bytes consumed by the JSON parser, excluding headers/TLS and unread rejected bodies',['route']);
  const inFlight=gauge('http_in_flight','Application requests not yet finished or closed');
  const revokeDuration=histogram('revocation_ack_duration_seconds','Successful revocation HTTP acknowledgment duration; not cross-system propagation',['route']);
  const parserErrors=counter('http_parser_errors_total','Rejected HTTP parser requests',['status']);
  const workerRuns=counter('worker_iterations_total','Evidence Worker iteration outcomes',['outcome']);
  const probeRuns=counter('builder_probe_observations_total','Builder endpoint observation outcomes',['outcome']);
  const workerDuration=histogram('worker_iteration_duration_seconds','Evidence Worker iteration time',['outcome']);
  const workerHeartbeat=gauge('worker_last_iteration_timestamp_seconds','Last finished Worker iteration time');
  const workerPaused=gauge('worker_retirement_paused','Worker prevented from claiming evidence by retirement or incident policy (legacy metric name)');
  const dbUp=gauge('database_collection_success','Last database metrics query succeeded');
  const dbLast=gauge('database_last_success_timestamp_seconds','Last successful database collection time');
  const dbBytes=gauge('database_bytes','PostgreSQL database physical bytes, excluding cluster WAL and backups');
  const jobs=gauge('jobs','Current stored jobs by state',['state']);
  const active=gauge('job_active_leases','Running jobs with unexpired leases');
  const oldest=gauge('job_oldest_open_age_seconds','Age of oldest pending or running job');
  const revokedJobs=gauge('revocation_open_jobs','Open jobs with directly revoked Evidence or Builder probe Consent or binding');
  const revokedAge=gauge('revocation_oldest_open_job_age_seconds','Age since direct Consent or binding revocation for an open job');
  const dependentRevokedJobs=gauge('revocation_dependent_open_jobs','Open Evidence/revalidation or Builder probe jobs with revoked direct or ancestor Consent/binding');
  const dependentRevokedAge=gauge('revocation_oldest_dependent_job_age_seconds','Age since earliest revoked dependency for an open Evidence or Builder probe job');
  const invalidatedSearch=gauge('revocation_search_documents','Stored search candidates still referencing a revoked Consent/binding; serving reads also recheck sources');
  const subjects=gauge('product_subjects','Aggregate server-side subjects under explicit stage definitions',['stage']);
  gauge('verified_capability_measurement_available','Independent capability measurement implemented').set(0);
  const storageUp=gauge('storage_collection_success','Configured local filesystem collection succeeded');
  const storageBytes=gauge('storage_bytes','Configured local filesystem capacity; not remote database storage',['kind']);
  const logReady=gauge('runtime_log_ready','Configured runtime log sink currently accepts writes');
  const logEvents=gauge('runtime_log_events','Process-lifetime runtime log events',['kind']);
  logReady.remove();
  gauge('backup_collection_enabled','Explicit backup status directory configured').set(backupStatusDirectory?1:0);
  const backupAvailable=gauge('backup_status_available','Expected backup action has a readable status',['action']);
  const backupRunning=gauge('backup_running','Latest backup action is still running',['action']);
  const backupSuccess=gauge('backup_last_attempt_success','Latest finished action succeeded; running state omitted',['action']);
  const backupStarted=gauge('backup_started_timestamp_seconds','Latest backup action start time',['action']);
  const backupFinished=gauge('backup_finished_timestamp_seconds','Latest backup action completion time',['action']);
  const backupLastSuccess=gauge('backup_last_success_timestamp_seconds','Latest successful action completion; no value until first success',['action']);
  const backupValues=[backupRunning,backupSuccess,backupStarted,backupFinished,backupLastSuccess];
  const costAvailable=gauge('cost_input_available','Explicit cost input supplied');
  costAvailable.set(cost?1:0);
  const costBudgetConfigured=gauge('cost_budget_configured','A numeric budget is supplied for the selected cost input');
  costBudgetConfigured.set(cost?.budget!=null?1:0);
  gauge('cost_collection_enabled','Explicit cost file or embedded cost input configured').set(costFile||cost?1:0);
  const costMetrics=costFile||cost?{
    amount:gauge('cost_amount','Supplied cumulative period amount; estimates are not bills',['currency','kind']),
    budget:gauge('cost_budget','Supplied period budget',['currency','kind']),
    scope:gauge('cost_scope_info','Selected cost scope; unallocated resource costs are not Galaxy incremental costs',['dimension','count','sha256','attribution']),
    start:gauge('cost_period_start_timestamp_seconds','Cost input period start'),
    end:gauge('cost_period_end_timestamp_seconds','Cost input period end'),
    observed:gauge('cost_observed_timestamp_seconds','Cost source observation time'),
    last:gauge('cost_last_success_timestamp_seconds','Last successful cost input read; not billing source freshness'),
  }:null;
  if(costMetrics)for(const metric of Object.values(costMetrics))if(!metric.labelNames.length)metric.remove();
  function updateCost(value){
    if(!costMetrics)return;
    for(const metric of [costMetrics.amount,costMetrics.budget,costMetrics.scope])metric.reset();
    for(const metric of [costMetrics.start,costMetrics.end,costMetrics.observed])metric.remove();
    costAvailable.set(value?1:0);
    costBudgetConfigured.set(value?.budget!=null?1:0);
    if(!value)return;
    const labels={currency:value.currency,kind:value.kind};
    costMetrics.amount.set(labels,value.amount);
    if(value.budget!==null)costMetrics.budget.set(labels,value.budget);
    if(value.scope)costMetrics.scope.set({...value.scope,count:String(value.scope.count)},1);
    costMetrics.start.set(Date.parse(value.periodStart)/1000);costMetrics.end.set(Date.parse(value.periodEnd)/1000);
    costMetrics.observed.set(Date.parse(value.observedAt)/1000);costMetrics.last.set(now()/1000);
  }
  updateCost(cost);
  inFlight.set(0);
  let lastAttempt=-Infinity,pending=null;
  const dbValues=[dbBytes,jobs,active,oldest,revokedJobs,revokedAge,dependentRevokedJobs,dependentRevokedAge,invalidatedSearch,subjects];
  gauge('database_collection_enabled','Database aggregates collected by this component').set(db?1:0);
  gauge('storage_collection_enabled','Local filesystem directory explicitly configured').set(storageDirectory?1:0);
  dbUp.remove();dbLast.remove();storageUp.remove();
  for(const metric of dbValues)if(!metric.labelNames.length)metric.remove();
  async function refresh(){
    if(pending)return pending;
    if(now()-lastAttempt<cacheMs)return;
    lastAttempt=now();
    pending=(async()=>{
      if(costFile){
        try{updateCost(await readCostInput(costFile));}catch{updateCost(null);}
      }
      if(backupStatusDirectory){
        for(const action of monitoredBackupActions){
          const labels={action};for(const metric of backupValues)metric.remove(labels);
          try{
            const state=await readBackupStatus(backupStatusDirectory,action);backupAvailable.set(labels,state?1:0);
            if(state){
              backupRunning.set(labels,state.outcome==='running'?1:0);backupStarted.set(labels,state.startedAt);
              if(state.finishedAt!==null){backupFinished.set(labels,state.finishedAt);backupSuccess.set(labels,state.outcome==='succeeded'?1:0);}
              if(state.lastSuccessAt!==null)backupLastSuccess.set(labels,state.lastSuccessAt);
            }
          }catch{backupAvailable.set(labels,0);}
        }
      }
      if(logStatus){
        try{
          const state=logStatus();logReady.set(state.ready?1:0);
          for(const kind of ['writeFailures','droppedRecords','rotationWarnings','rotations'])logEvents.set({kind},state[kind]);
        }catch{logReady.set(0);logEvents.reset();}
      }
      if(db){
        await refreshAutonomy();
        try{
          const s=await operationalSnapshot(db,now());
          dbBytes.set(s.database_bytes);
          for(const state of ['pending','running','completed','failed'])jobs.set({state},s[state]);
          active.set(s.active);oldest.set(s.oldest);revokedJobs.set(s.revoked_jobs);revokedAge.set(s.oldest_revocation);
          dependentRevokedJobs.set(s.dependent_revoked_jobs);dependentRevokedAge.set(s.oldest_dependent_revocation);invalidatedSearch.set(s.invalidated_search_documents);
          subjects.set({stage:'connected'},s.connected);subjects.set({stage:'evidence_bearing'},s.evidence_bearing);
          dbLast.set(now()/1000);dbUp.set(1);
        }catch{for(const metric of dbValues){if(metric.labelNames.length)metric.reset();else metric.remove();}dbUp.set(0);}
      }
      if(storageDirectory){
        try{
          const s=await statfs(storageDirectory,{bigint:true});
          storageBytes.set({kind:'total'},Number(s.blocks*s.bsize));
          storageBytes.set({kind:'available'},Number(s.bavail*s.bsize));storageUp.set(1);
        }catch{storageBytes.reset();storageUp.set(0);}
      }
    })().finally(()=>{pending=null;});
    return pending;
  }
  return {
    registry,
    builderProbe(result){if(result?.processed&&['reachable','authentication-required','protocol-mismatch','unavailable','revoked'].includes(result.state))probeRuns.inc({outcome:result.state});},
    quotaRejected(code){
      const kind={storage_quota_exceeded:'payload',job_queue_quota_exceeded:'queue',export_ticket_quota_exceeded:'exports',rate_limited:'request_rate'}[code];
      if(typeof kind==='string')quotas.inc({kind});
    },
    beginHttp(){
      const started=performance.now();inFlight.inc();let ended=false;
      return ({method,path,status,bodyBytes=0,receivedBodyBytes=0})=>{
        if(ended)return;ended=true;inFlight.dec();
        const route=failureRoute(method,path),code=Number.isInteger(status)&&status>=100&&status<=599?String(status):'499';
        const elapsed=Math.max(0,(performance.now()-started)/1000),labels={route,status:code};
        requests.inc(labels);duration.observe(labels,elapsed);
        if(Number.isFinite(bodyBytes)&&bodyBytes>=0)bytes.inc({route},bodyBytes);
        if(Number.isFinite(receivedBodyBytes)&&receivedBodyBytes>=0)receivedBytes.inc({route},receivedBodyBytes);
        if(code.startsWith('2')&&route.endsWith('/revoke'))revokeDuration.observe({route},elapsed);
      };
    },
    parserError(status){parserErrors.inc({status:[400,408,431].includes(status)?String(status):'400'});},
    workerIteration(result,seconds,{failed=false,paused=false}={}){
      const outcome=failed?'error':paused?'paused':result?.budgetLimited?'budget_limited':result?.leaseLost?'lease_lost':
        result?.processed&&['observed','revoked','unavailable'].includes(result.state)?result.state:'idle';
      workerRuns.inc({outcome});workerDuration.observe({outcome},Math.max(0,seconds));
      workerHeartbeat.set(now()/1000);workerPaused.set(paused?1:0);
    },
    async render(){await refresh();return registry.metrics();},
  };
}

// Kept off the public API and proxy surface. A local Prometheus/OTel collector
// can scrape this loopback socket; external monitoring requires its own route.
export async function startMetricsListener(metrics,port){
  if(port===null)return null;
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid metrics port');
  const server=createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');
    if(request.method!=='GET'||request.url!=='/metrics'){response.statusCode=404;response.end();return;}
    try{
      const body=await metrics.render();response.setHeader('Content-Type',metrics.registry.contentType);response.end(body);
    }catch{response.statusCode=503;response.end('metrics unavailable\n');}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=1000;server.maxHeadersCount=20;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return server;
}
export async function closeMetricsListener(server){
  if(!server)return;
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
