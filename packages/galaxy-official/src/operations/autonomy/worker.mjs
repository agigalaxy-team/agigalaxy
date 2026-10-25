import {randomUUID} from 'node:crypto';
import {transaction} from '../../database.mjs';
import {terminalStates,nextDue,iso} from './contract.mjs';
import {scheduleAutonomyStrategiesWithin} from './strategy.mjs';
import {refreshTaskModelUsageWithin} from './workbench.mjs';

export function createOperationsAutonomyWorker({autonomy,jobs=autonomy.jobs,logger=()=>{}}){
 const owner=randomUUID();let started=false;
 async function tick(){
  const now=autonomy.at();
  await transaction(autonomy.db,async db=>{
   // Independent of the overview model and of each AI's own availability.
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912482))',[autonomy.endpoint]);
   await db.query(`INSERT INTO operations_autonomy_health_v1(endpoint,started_at,checked_at,last_tick_at) VALUES($1,$2,$2,$2) ON CONFLICT(endpoint) DO UPDATE SET checked_at=EXCLUDED.checked_at,last_tick_at=EXCLUDED.last_tick_at`,[autonomy.endpoint,now]);
   await autonomy.ensureWithin(db);
   const configs=(await db.query('SELECT * FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND enabled ORDER BY domain FOR UPDATE',[autonomy.endpoint])).rows;
   await scheduleAutonomyStrategiesWithin(autonomy,db,configs);
   for(const cfg of configs){
    const busy=(await db.query("SELECT id FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND domain=$2 AND source<>'workbench' AND state IN ('queued','running','unknown') LIMIT 1",[autonomy.endpoint,cfg.domain])).rows[0];
    if(cfg.next_due_at&&new Date(cfg.next_due_at)<=now&&!busy){
     // One catch-up for a missed interval, never one run per old heartbeat.
     await autonomy.createTaskWithin(db,cfg,{key:'routine:'+cfg.id+':'+iso(cfg.next_due_at),due:new Date(cfg.next_due_at)});
     await db.query('UPDATE operations_autonomy_configs_v1 SET next_due_at=$3 WHERE endpoint=$1 AND id=$2',[autonomy.endpoint,cfg.id,nextDue(cfg.configuration.schedule,now)]);
    }
    const events=(await db.query('SELECT * FROM operations_autonomy_events_v1 WHERE endpoint=$1 AND domain=$2 AND processed_at IS NULL AND available_at<=$3 ORDER BY created_at,id LIMIT 100 FOR UPDATE',[autonomy.endpoint,cfg.domain,now])).rows;
    if(events.length&&!busy){
     const eligible=events.filter(e=>cfg.configuration.plan.eventTypes.includes(e.event_type));
     if(eligible.length){const sameTarget=eligible.every(e=>e.target_type===eligible[0].target_type&&e.target_id===eligible[0].target_id),task=await autonomy.createTaskWithin(db,cfg,{source:'event',key:'event:'+eligible[0].id,eventIds:eligible.map(e=>e.id),targetType:sameTarget?eligible[0].target_type:null,targetId:sameTarget?eligible[0].target_id:null});
      if(task)await db.query('UPDATE operations_autonomy_events_v1 SET task_id=$3,processed_at=$4 WHERE endpoint=$1 AND id=ANY($2::uuid[])',[autonomy.endpoint,eligible.map(e=>e.id),task.id,now]);}
    }
   }
   const recover=(await db.query(`SELECT * FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND source<>'workbench' AND (state='unknown' OR state='running' AND lease_until<=$2 OR state='queued' AND due_at<=$2) ORDER BY due_at LIMIT 30 FOR UPDATE`,[autonomy.endpoint,now])).rows;
   for(const row of recover){
    if(row.state==='running')await db.query(`UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='unknown',code='lease-expired',lease_owner=NULL,lease_until=NULL,revision=revision+1,updated_at=$3 WHERE endpoint=$1 AND id=$2`,[autonomy.endpoint,row.id,now]);
    await jobs.enqueue('autonomy-task',{taskId:row.id,reconcile:!!row.dispatch_started_at},{key:row.id+':health:'+Math.floor(autonomy.now()/30),db});
   }
   await jobs.enqueue('autonomy-tick',{}, {key:autonomy.endpoint+':'+Math.floor(autonomy.now()/30+1),startAfter:new Date(now.getTime()+autonomy.defaults.healthSeconds*1000),db});
  });
  await reconcileWorkbench();
  const pending=(await autonomy.db.query("SELECT * FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND source<>'workbench' AND state IN ('waiting-human','paused') AND native_run_id IS NOT NULL ORDER BY updated_at LIMIT 10",[autonomy.endpoint])).rows;
  for(const row of pending)await reconcile(row);
  return{state:'checked'};
 }
 async function reconcileWorkbench(){
  if(typeof autonomy.client?.runDetail!=='function')return;
  const rows=(await autonomy.db.query(`SELECT t.id,t.domain,r.native_run_id,r.turn_operation_id FROM operations_autonomy_workbench_runs_v1 r
   JOIN operations_autonomy_tasks_v1 t ON t.endpoint=r.endpoint AND t.id=r.task_id
   WHERE r.endpoint=$1 AND r.native_run_id IS NOT NULL AND r.state IN ('running','unknown','waiting-human') AND t.state NOT IN ('stopped','blocked') ORDER BY r.updated_at LIMIT 10`,[autonomy.endpoint])).rows;
  for(const row of rows){try{
   const value=await autonomy.client.runDetail(row.native_run_id),run=value?.run;if(run?.runId!==row.native_run_id||run.domain&&run.domain!==row.domain)continue;
   const modelState={PENDING:'accepted',RUNNING:'running',COMPLETED:'completed',PAUSED:'running',CANCELLED:'cancelled',ERROR:'failed'}[run.state]??'unknown';
   const status=run.state==='COMPLETED'?'completed':run.state==='PAUSED'?'waiting-human':['CANCELLED','ERROR'].includes(run.state)?'failed':run.state==='RUNNING'||run.state==='PENDING'?'running':'unknown';
   const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null,usage={calls:number(run.calls),inputTokens:number(run.tokens?.input),outputTokens:number(run.tokens?.output),totalTokens:number(run.tokens?.total),durationMs:number(run.durationMs)};
   await transaction(autonomy.db,async db=>{
    await autonomy.updateWorkbenchWithin(db,{operationId:row.id,turnOperationId:row.turn_operation_id,nativeRunId:row.native_run_id,modelState,status,usage});
    const receipts=(await db.query('SELECT * FROM public.galaxy_autonomy_workbench_receipts_v1($1,$2)',[autonomy.endpoint,row.id])).rows;
    for(const receipt of receipts)await autonomy.updateWorkbenchWithin(db,{operationId:row.id,turnOperationId:row.turn_operation_id,status:receipt.state==='completed'?'completed':'waiting-human',businessReceipt:{operationId:receipt.operation_id,action:receipt.action,targetType:receipt.target_type,targetId:receipt.target_id,state:receipt.state,details:receipt.details,basis:'workbench-original-domain-receipt'}});
   });
  }catch(error){logger({event:'autonomy_workbench_reconcile_deferred',taskId:row.id,code:error.code});}}
 }
 async function reconcile(row){
  let value;try{value=await autonomy.native.read(row);}catch(error){logger({event:'autonomy_reconcile_deferred',taskId:row.id,code:error.code});return{state:'unknown'};}
  const runId=value.nativeRunId??value.runId??null;
  // NOT_RECORDED is evidence about this exact native operation, but never an
  // instruction to replay it under another ID or to declare business failure.
  if(value.status==='NOT_RECORDED')return{state:'unknown'};
  if(row.native_run_id&&runId&&row.native_run_id!==runId)return{state:'unknown'};
  await autonomy.db.query('UPDATE operations_autonomy_tasks_v1 SET native_continuable=$3,native_run_id=COALESCE(native_run_id,$4) WHERE endpoint=$1 AND id=$2',[autonomy.endpoint,row.id,value.continuable===true,runId]);
  const status=value.awaitingHuman||value.status==='PAUSED'?'waiting-human':value.status==='COMPLETED'?'completed':value.status==='ERROR'?'failed':value.status==='CANCELLED'?'failed':row.lease_until&&new Date(row.lease_until)<=autonomy.at()?'unknown':'running';
  if(value.run&&runId){const tokens=value.run.tokens??{},number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
   const usage={calls:number(value.run.calls),inputTokens:number(tokens.input),outputTokens:number(tokens.output),totalTokens:number(tokens.total),durationMs:number(value.run.durationMs)};
   await transaction(autonomy.db,async db=>{await db.query('UPDATE operations_autonomy_tasks_v1 SET primary_model_usage=$3 WHERE endpoint=$1 AND id=$2',[autonomy.endpoint,row.id,JSON.stringify(usage)]);await refreshTaskModelUsageWithin(autonomy,db,row.id);});
  }
  return autonomy.report({taskId:row.id,...(runId?{nativeRunId:runId}:{}),modelState:value.modelState??'unknown',status});
 }
 async function execute(data){
  if(!data?.taskId)return{state:'invalid'};
  const saved=await transaction(autonomy.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912483))',[autonomy.endpoint]);
   const reference=await autonomy.taskWithin(db,data.taskId);await autonomy.configWithin(db,reference.domain,{share:true});
   const row=await autonomy.taskWithin(db,data.taskId,{lock:true});if(row.source==='workbench'||terminalStates.has(row.state)||['paused','waiting-human'].includes(row.state))return{skip:true,row};
   if(row.dispatch_started_at)return{reconcile:true,row};
   const cfg=await autonomy.configWithin(db,row.domain);if(!cfg.enabled){await db.query("UPDATE operations_autonomy_tasks_v1 SET state='paused',code='plan-disabled',revision=revision+1,updated_at=$3 WHERE endpoint=$1 AND id=$2",[autonomy.endpoint,row.id,autonomy.at()]);return{skip:true,row};}
   await autonomy.refreshSettingsWithin(db);
   const concurrent=(await db.query("SELECT count(*)::int AS count FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND state IN ('running','unknown') AND source<>'workbench' AND dispatch_started_at IS NOT NULL AND id<>$2",[autonomy.endpoint,row.id])).rows[0].count;
   const same=(await db.query("SELECT id FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND domain=$2 AND state IN ('running','unknown') AND id<>$3 AND source<>'workbench' AND dispatch_started_at IS NOT NULL LIMIT 1",[autonomy.endpoint,row.domain,row.id])).rows[0];
   if(concurrent>=autonomy.defaults.concurrency||same)return{skip:true,row};
   const state=row.mode==='human-ai'?'waiting-human':'running',at=autonomy.at(),lease=new Date(at.getTime()+(row.configuration.runtime?.roundSeconds??autonomy.defaults.roundSeconds)*1000);
   const current=(await db.query(`UPDATE operations_autonomy_tasks_v1 SET state=$3,started_at=$4,lease_owner=$5,lease_until=$6,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING *`,[autonomy.endpoint,row.id,state,at,owner,lease])).rows[0];
   if(state==='waiting-human')return{skip:true,row:current};
   try{await autonomy.authorizeTaskWithin(db,current);}catch(error){await db.query("UPDATE operations_autonomy_tasks_v1 SET state='blocked',code=$3,lease_until=NULL,updated_at=$4 WHERE endpoint=$1 AND id=$2",[autonomy.endpoint,row.id,error.code??'authority-unavailable',at]);return{skip:true,row:current};}
   // Persist the only dispatch before leaving the transaction. A lost ACK is
   // reconciled by GET and can never reach this POST branch again.
   await db.query("UPDATE operations_autonomy_tasks_v1 SET dispatch_started_at=$3,model_state=CASE WHEN mode='code' THEN 'not-required' ELSE 'dispatching' END WHERE endpoint=$1 AND id=$2",[autonomy.endpoint,row.id,at]);
   return{row:{...current,dispatch_started_at:at}};
  });
  if(saved.skip)return{state:saved.row.state};if(saved.reconcile)return reconcile(saved.row);
  const row=saved.row;
  if(row.mode==='code'){
   // This path uses fixed code rules, never a fallback model request.
   try{if(!autonomy.codeRunner)throw Object.assign(Error(),{code:'operations_autonomy_rule_not_configured'});const result=await autonomy.codeRunner(row);return{state:result.state};}
   catch(error){await autonomy.db.query("UPDATE operations_autonomy_tasks_v1 SET state='unknown',code=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2",[autonomy.endpoint,row.id,error.code,autonomy.at()]);return{state:'unknown'};}
  }
  try{const value=await autonomy.native.run(row);return await autonomy.report({taskId:row.id,...(value.nativeRunId??value.runId?{nativeRunId:value.nativeRunId??value.runId}:{}),modelState:value.modelState??'accepted',status:value.awaitingHuman?'waiting-human':'running'});}
  catch(error){await autonomy.db.query("UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='unknown',code=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 AND state='running'",[autonomy.endpoint,row.id,error.code??'native-unavailable',autonomy.at()]);return{state:'unknown'};}
 }
 return{tick,execute,reconcile,reconcileWorkbench,async start(){if(started)return;started=true;await jobs.work('autonomy-task',execute);await jobs.work('autonomy-tick',tick);await tick();},async stop(){await jobs.stopWork('autonomy-tick');await jobs.stopWork('autonomy-task');started=false;}};
}
