import {fail,terminalStates} from './contract.mjs';
const usageKeys=['calls','inputTokens','outputTokens','totalTokens','durationMs'];
export async function refreshTaskModelUsageWithin(service,db,taskId){
 const row=await service.taskWithin(db,taskId),runs=(await db.query('SELECT usage FROM operations_autonomy_workbench_runs_v1 WHERE endpoint=$1 AND task_id=$2',[service.endpoint,taskId])).rows;
 if(row.source!=='workbench')runs.unshift({usage:row.primary_model_usage});
 const combined=Object.fromEntries(usageKeys.map(key=>[key,runs.length&&runs.every(r=>Number.isFinite(r.usage?.[key])&&r.usage[key]>=0)?runs.reduce((sum,r)=>sum+r.usage[key],0):null]));
 await db.query('UPDATE operations_autonomy_tasks_v1 SET model_usage=$3 WHERE endpoint=$1 AND id=$2',[service.endpoint,taskId,JSON.stringify(combined)]);return combined;
}

/** A task may contain several human-led turns. Each run's native aggregate is
 * replaced on observation; task totals sum those snapshots exactly once. */
export async function updateWorkbenchTaskWithin(service,db,{operationId,turnOperationId=null,nativeRunId=null,modelState=null,status=null,businessReceipt=null,usage=null}){
 const row=(await db.query("SELECT * FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2 AND (source='workbench' OR human_decision->>'kind'='takeover') FOR UPDATE",[service.endpoint,operationId])).rows[0];if(!row)return null;
 const turnId=turnOperationId??row.configuration.externalWorkbench?.turnOperationId??row.id;
 const old=(await db.query('SELECT native_run_id FROM operations_autonomy_workbench_runs_v1 WHERE endpoint=$1 AND task_id=$2 AND turn_operation_id=$3',[service.endpoint,row.id,turnId])).rows[0];
 if(old?.native_run_id&&nativeRunId&&old.native_run_id!==nativeRunId)fail('operations_autonomy_operation_conflict');
 const runState=status??row.state;
 if(!['running','waiting-human','completed','failed','stopped','unknown'].includes(runState))fail('invalid_operations_autonomy_request',400);
 await db.query(`INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,native_run_id,model_state,state,usage,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(endpoint,task_id,turn_operation_id) DO UPDATE
  SET native_run_id=COALESCE(operations_autonomy_workbench_runs_v1.native_run_id,EXCLUDED.native_run_id),model_state=COALESCE($9,operations_autonomy_workbench_runs_v1.model_state),
  state=CASE WHEN $10 THEN EXCLUDED.state ELSE operations_autonomy_workbench_runs_v1.state END,usage=COALESCE(EXCLUDED.usage,operations_autonomy_workbench_runs_v1.usage),updated_at=EXCLUDED.updated_at`,
 [service.endpoint,row.id,turnId,nativeRunId,modelState??row.model_state,runState,usage?JSON.stringify(usage):null,service.at(),modelState,status!==null]);
 if(businessReceipt)await service.recordBusinessReceiptWithin(db,{taskId:row.id,...businessReceipt});
 const pending=(await db.query('SELECT public.galaxy_autonomy_workbench_pending_v1($1,$2) AS pending',[service.endpoint,row.id])).rows[0].pending;
 let state=status??row.state;
 if(state==='completed'&&(pending||row.state==='waiting-human'&&!businessReceipt))state='waiting-human';
 if(terminalStates.has(row.state))state=row.state;
 const combined=await refreshTaskModelUsageWithin(service,db,row.id);
 const latest=row.source==='workbench'&&turnId===(row.configuration.externalWorkbench?.turnOperationId??row.id);
 await db.query(`UPDATE operations_autonomy_tasks_v1 SET state=$3,model_state=CASE WHEN $9 THEN COALESCE($4,model_state) ELSE model_state END,
  native_run_id=CASE WHEN $9 THEN COALESCE($5,native_run_id) ELSE native_run_id END,model_usage=$6,
  completed_at=CASE WHEN $7 THEN COALESCE(completed_at,$8) ELSE completed_at END,revision=revision+1,updated_at=$8 WHERE endpoint=$1 AND id=$2`,
 [service.endpoint,row.id,state,modelState,nativeRunId,JSON.stringify(combined),['completed','failed','stopped'].includes(state),service.at(),latest]);
 return service.taskWithin(db,row.id);
}
