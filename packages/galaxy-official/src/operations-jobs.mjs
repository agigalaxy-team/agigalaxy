import { PgBoss } from 'pg-boss';
import { ServiceError } from './shared/service-error.mjs';
import { transaction } from './database.mjs';
import {withRuntimeDiagnosticContext} from './shared/runtime-diagnostics.mjs';

export const operationsJobSchema = 'galaxy_jobs';
export const operationsQueues = Object.freeze(['information-watch', 'search-recovery', 'content-publication', 'account-notice', 'retention-cleanup','messaging-run','messaging-delivery','autonomy-task','autonomy-tick']);
export const operationsAuditActions = Object.freeze(['job-cancel', 'job-retry', 'search-retry']);
const queueName = name => {
  if (!operationsQueues.includes(name)) throw new ServiceError('operations_queue_unknown', 400);
  return name;
};
export const operationsDatabase = db => ({
  async executeSql(text, values) {
    // PGlite's simple-query interface returns all statement results just like
    // pg. Parameterized statements still use query on the pinned connection.
    if (typeof db.exec === 'function' && !values?.length) {
      const results = await db.exec(text);
      return results.length === 1 ? results[0] : results;
    }
    return db.query(text, values);
  },
});
const codeOf = error => /^[a-z][a-z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : 'operations_job_failed';
const time = value => value ? new Date(value).toISOString() : null;

export function operationJobView(job) {
  return {
    id: job.id, queue: job.name, state: job.state,
    createdAt: time(job.createdOn), startedAt: time(job.startedOn), completedAt: time(job.completedOn),
    availableAt: time(job.startAfter), retryCount: job.retryCount, retryLimit: job.retryLimit,
    subjectId: job.data?.subjectId ?? null,
    resourceId: job.data?.watchId ?? job.data?.jobId ?? job.data?.publicationId ?? job.data?.noticeId ?? job.data?.runId ?? null,
    error: typeof job.output?.code === 'string' ? job.output.code : null,
  };
}

// Queue installation and fixed queue definitions belong to schema migration 93.
// The API/worker use their existing pool and cannot create tables or load keys.
export function createOperationsJobs({ db, boss: suppliedBoss, onError = () => {}, onEvent = () => {}, supervise = true,scheduling=false } = {}) {
  if (!db?.query) throw new Error('Operations jobs require the existing PostgreSQL pool');
  const boss = suppliedBoss ?? new PgBoss({
    db: operationsDatabase(db), schema: operationsJobSchema, migrate: false, createSchema: false,
    schedule: scheduling, supervise, reindex: false, persistQueueStats: false, persistWarnings: false,
    registerInstance: false, openTelemetry: { enabled: false },
  });
  const consumers = new Map(), cancellations = new Map();
  let starting = null, stopped = false;
  const report=input=>{try{onError(input);}catch{/* Diagnostics never change queue state. */}};
  const notify=input=>{try{onEvent(input);}catch{}};
  boss.on('error', error => report({code:codeOf(error),stage:'queue-error',error}));
  const start = () => {
    if (stopped) throw new Error('Operations jobs have stopped');
    return starting ??= boss.start().catch(error => { starting = null; throw error; });
  };
  async function enqueue(name, data, { key, startAfter, db: within } = {}) {
    queueName(name);
    if (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > 65536)
      throw new ServiceError('operations_job_payload_invalid', 400);
    if (typeof key !== 'string' || !key.length || key.length > 300) throw new ServiceError('operations_job_key_required', 400);
    const options={singletonKey:key,...(within?{db:operationsDatabase(within)}:{})};
    return startAfter?boss.sendAfter(name,data,options,new Date(startAfter)):boss.send(name,data,options);
  }
  function previewSchedule(cron,{timezone,from=new Date(),count=3}={}){
    if(typeof cron!=='string'||!cron.trim()||cron.length>160||/^(?:DTSTART|RRULE):/i.test(cron)||typeof timezone!=='string'||!timezone)
      throw new ServiceError('operations_messaging_schedule_invalid',400);
    try{return boss.previewSchedule(cron,{tz:timezone,from:new Date(from),count}).map(value=>value.toISOString());}
    catch{throw new ServiceError('operations_messaging_schedule_invalid',400);}
  }
  async function schedule(name,cron,data,{key,timezone,db:within,missed='skip'}={}){
    if(!['messaging-run'].includes(queueName(name))||typeof key!=='string'||!key||key.length>300||!['skip','once'].includes(missed))throw new ServiceError('operations_messaging_schedule_invalid',400);
    previewSchedule(cron,{timezone,count:1});
    return boss.schedule(name,cron,data,{key,tz:timezone,missed,...(within?{db:operationsDatabase(within)}:{})});
  }
  async function unschedule(name,key,{db:within}={}){
    if(queueName(name)!=='messaging-run'||typeof key!=='string'||!key||key.length>300)throw new ServiceError('operations_messaging_schedule_invalid',400);
    return boss.unschedule(name,key,(within?{db:operationsDatabase(within)}:{}));
  }
  async function execute(job, handler) {
    const startedAt=performance.now(),fields={queue:job.name,jobId:job.id,attempt:job.retryCount??0,stage:'queue-execute'};
    return withRuntimeDiagnosticContext(fields,async()=>{
      try {
        job.signal?.throwIfAborted();
        const result=await handler(job.data,{signal:job.signal,jobId:job.id,attempt:job.retryCount??0,createdAt:time(job.createdOn),availableAt:time(job.startAfter),startedAt:time(job.startedOn)});
        // This is the handler result; the queue still persists its own ACK.
        notify({event:'operations_job_finished',...fields,startedAt,outcome:'succeeded'});
        return result;
      }catch(error){
        if(job.signal?.aborted)notify({event:'operations_job_finished',...fields,startedAt,outcome:'cancelled'});
        else report({...fields,startedAt,outcome:'failed',code:codeOf(error),error});
        // Persist the existing bounded job code, not diagnostic objects or bodies.
        throw Object.assign(new Error(codeOf(error)),{code:codeOf(error)});
      }
    });
  }
  async function work(name, handler) {
    queueName(name);
    if (consumers.has(name)) throw new Error('Operations queue already has a local consumer');
    await start();
    const id = await boss.work(name, { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 1 },
      async ([job]) => execute(job, handler));
    consumers.set(name, id);
    return id;
  }
  async function stopWork(name) {
    const id = consumers.get(queueName(name));
    if (id) { await boss.offWork(name, { id, wait: true }); consumers.delete(name); }
  }
  async function get(name, id) {
    const [job] = await boss.findJobs(queueName(name), { id, limit: 1 });
    return job ? operationJobView(job) : null;
  }
  async function lockedJob(tx, name, id) {
    // Serialize operator commands with queue completion on the actual PG row.
    const found = (await tx.query('SELECT id FROM galaxy_jobs.job WHERE name=$1 AND id=$2 FOR UPDATE', [name,id])).rows[0];
    if (!found) throw new ServiceError('operations_job_not_found', 404);
    const [job] = await boss.findJobs(name, {id,limit:1,db:operationsDatabase(tx)});
    if (!job) throw new ServiceError('operations_job_not_found', 404);
    return job;
  }
  const commandResult = (name, before, after) => ({queue:name,jobId:before.id,previousState:before.state,
    state:after.state,changed:before.state!==after.state,
    ...(Number.isSafeInteger(before.data?.generation)&&before.data.generation>0?{generation:before.data.generation}:{})});
  return {
    start, enqueue, work, stopWork, get,schedule,unschedule,previewSchedule,
    onCancel(name, handler) {
      queueName(name);
      if (cancellations.has(name)) throw new Error('Operations cancellation handler already registered');
      cancellations.set(name, handler);
      return () => cancellations.delete(name);
    },
    async list(name, { after, limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError('operations_page_invalid', 400);
      const jobs = await boss.findJobs(queueName(name), { limit: limit + 1, ...(after ? { after } : {}) });
      return { items: jobs.slice(0, limit).map(operationJobView), nextAfter: jobs.length > limit ? jobs[limit - 1].id : null };
    },
    async cancel(name, id, {audit,endpoint,authorize} = {}) {
      queueName(name);
      if(name.startsWith('autonomy-'))throw new ServiceError('operations_autonomy_task_control_required',409);
      return transaction(db, async tx => {
        await authorize?.(tx);
        const adapter = operationsDatabase(tx);
        const current = await lockedJob(tx,name,id);
        const cancellable=['created', 'retry', 'active'].includes(current.state);
        const domainCancellation=['content-publication','account-notice','retention-cleanup','messaging-run','messaging-delivery'].includes(name);
        if(domainCancellation&&(cancellable||current.state==='cancelled')){
          if(!cancellations.has(name))throw new ServiceError(name==='content-publication'?'site_publication_unavailable':'operations_job_domain_unavailable',503);
          await cancellations.get(name)(tx,current.data,{jobId:id,endpoint});
        }
        if (cancellable) {
          // Content cancellation is a domain operation, not just a queue flag.
          if(!domainCancellation)await cancellations.get(name)?.(tx, current.data, {jobId:id,endpoint});
          await boss.cancel(name, id, { db: adapter });
        } else if(current.state!=='cancelled')throw new ServiceError('operations_job_not_cancellable',409);
        const [latest] = await boss.findJobs(name, { id, limit: 1, db: adapter });
        if(!latest)throw new ServiceError('operations_job_not_found',404);
        await audit?.(tx,commandResult(name,current,latest));
        return operationJobView(latest);
      });
    },
    async retry(name, id, {audit,authorize} = {}) {
      queueName(name);
      if(name.startsWith('autonomy-'))throw new ServiceError('operations_autonomy_task_control_required',409);
      return transaction(db,async tx=>{
        await authorize?.(tx);
        const current=await lockedJob(tx,name,id),adapter=operationsDatabase(tx);
        // Cancellation is an owner's stop, not an automatic retry candidate.
        if(current.state!=='failed')throw new ServiceError('operations_job_not_failed',409);
        await boss.retry(name,id,{db:adapter});
        const [latest]=await boss.findJobs(name,{id,limit:1,db:adapter});
        if(!latest)throw new ServiceError('operations_job_not_found',404);
        await audit?.(tx,commandResult(name,current,latest));
        return operationJobView(latest);
      });
    },
    async stop() { stopped = true; await boss.stop({ graceful: true, timeout: 20000 }); consumers.clear(); },
  };
}
