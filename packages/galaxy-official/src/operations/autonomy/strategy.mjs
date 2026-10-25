import {transaction} from '../../database.mjs';
import {z} from 'zod';
import {parse,fail,nextDue,iso} from './contract.mjs';
export function strategyTaskConfig(cfg,strategy,version){
 const execution=strategy.execution;
 if(!execution||!execution.resourceScope||execution.resourceScope.kind==='unresolved'||execution.resourceScope.kind==='selected'&&!execution.resourceScope.resourceIds.length)fail('operations_autonomy_strategy_not_ready');
 return{...cfg,plan_version:version.version,configuration:{...cfg.configuration,mode:execution.mode,purpose:'operations-'+strategy.domain,goal:strategy.objective??cfg.configuration.goal,plan:{strategyIds:[strategy.id],grantIds:execution.grantIds,actions:execution.actions,resourceIds:execution.resourceScope.kind==='selected'?execution.resourceScope.resourceIds:[],eventTypes:execution.trigger.eventTypes??[]},strategyExecution:execution}};
}
export async function createAutonomyStrategyTask(service,operator,input,{authorize}={}){
 const x=parse(z.strictObject({operationId:z.uuid(),strategyId:z.uuid(),expectedStrategyVersion:z.number().int().min(1)}),input);
 return transaction(service.db,async db=>{const actor=await service.actor(operator,'autonomy.control',{db,authorize});await service.businessAdmin.authorizeAction(actor,'strategies.run',{db});const prior=await service.previousWithin(db,actor,x.operationId,'strategy-task',x);if(prior)return prior;await service.ensureWithin(db);
  const head=(await db.query('SELECT * FROM operations_p13_strategy_heads_v1 WHERE endpoint=$1 FOR SHARE',[service.endpoint])).rows[0],version=head?.active_id?(await db.query('SELECT * FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',[service.endpoint,head.active_id])).rows[0]:null;
  const strategy=version?.configuration.strategies.find(s=>s.id===x.strategyId);
  if(!strategy||!strategy.enabled||version.version!==x.expectedStrategyVersion||head.paused)fail('operations_autonomy_strategy_changed');
  const base=await service.configWithin(db,strategy.execution?.aiDomain??strategy.domain),cfg=strategyTaskConfig(base,strategy,version),task=await service.createTaskWithin(db,cfg,{id:x.operationId,source:'workbench',key:'strategy:'+x.operationId,title:strategy.name});
  // A manual strategy request joins the current person's operation-card flow.
  // It never becomes a standing service identity merely by being persisted.
  const snapshot={...task.configuration,externalWorkbench:{operatorId:actor.operatorId,strategyId:strategy.id}};
  const saved=(await db.query("UPDATE operations_autonomy_tasks_v1 SET mode='human-ai',configuration=$3,state='waiting-human',human_decision=$4,code='specific-human-action-required' WHERE endpoint=$1 AND id=$2 RETURNING *",[service.endpoint,task.id,JSON.stringify(snapshot),JSON.stringify({kind:'specific-action',operatorId:actor.operatorId,at:iso(service.at())})])).rows[0];
  return service.recordWithin(db,actor,x.operationId,'strategy-task',x,{operationId:x.operationId,task:await service.taskView(db,saved,actor),replayed:false});
 });
}
export async function scheduleAutonomyStrategiesWithin(service,db,configs){
 const head=(await db.query('SELECT * FROM operations_p13_strategy_heads_v1 WHERE endpoint=$1',[service.endpoint])).rows[0];if(!head?.active_id||head.paused)return;
 const version=(await db.query('SELECT * FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',[service.endpoint,head.active_id])).rows[0],configuration=version?.configuration;
 if(!configuration?.common.automationEnabled)return;
 for(const strategy of configuration.strategies){
  const x=strategy.execution;if(!strategy.enabled||!x||!x.resourceScope||x.resourceScope.kind==='unresolved'||x.resourceScope.kind==='selected'&&!x.resourceScope.resourceIds.length||x.trigger.kind==='manual'||!configuration.domains.some(d=>d.key===strategy.domain&&d.executionEnabled))continue;
  const base=configs.find(c=>c.domain===x.aiDomain);if(!base?.enabled)continue;
  const busy=(await db.query("SELECT id FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND domain=$2 AND source<>'workbench' AND state IN ('queued','running','unknown') LIMIT 1",[service.endpoint,base.domain])).rows[0];if(busy)continue;
  const cfg=strategyTaskConfig(base,strategy,version),now=service.at();
  if(x.trigger.kind==='event'){
   const events=(await db.query(`SELECT e.* FROM operations_autonomy_events_v1 e WHERE e.endpoint=$1 AND e.available_at<=$2 AND e.event_type=ANY($3::text[])
    AND NOT EXISTS(SELECT 1 FROM operations_autonomy_event_consumers_v1 c WHERE c.endpoint=e.endpoint AND c.event_id=e.id AND c.strategy_id=$4) ORDER BY e.created_at,e.id LIMIT 100 FOR UPDATE OF e`,[service.endpoint,now,x.trigger.eventTypes??[],strategy.id])).rows;
   if(!events.length)continue;const target=events.every(e=>e.target_type===events[0].target_type&&e.target_id===events[0].target_id)?events[0]:null;
   const task=await service.createTaskWithin(db,cfg,{source:'event',key:'strategy-event:'+strategy.id+':'+events[0].id,title:strategy.name,eventIds:events.map(e=>e.id),targetType:target?.target_type??null,targetId:target?.target_id??null});
   if(task)for(const event of events)await db.query('INSERT INTO operations_autonomy_event_consumers_v1(endpoint,event_id,strategy_id,task_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[service.endpoint,event.id,strategy.id,task.id]);
  }else{
   const schedule=x.trigger.kind==='interval'?{kind:'interval',minutes:x.trigger.minutes,timezone:'Asia/Shanghai'}:{kind:'daily',at:x.trigger.at,timezone:'Asia/Shanghai'};
   if(schedule.kind==='interval'&&!schedule.minutes||schedule.kind==='daily'&&!schedule.at)continue;
   let clock=(await db.query('SELECT * FROM operations_autonomy_strategy_schedules_v1 WHERE endpoint=$1 AND strategy_id=$2 FOR UPDATE',[service.endpoint,strategy.id])).rows[0];
   if(!clock||clock.version_id!==version.id){clock=(await db.query(`INSERT INTO operations_autonomy_strategy_schedules_v1(endpoint,strategy_id,version_id,next_due_at) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint,strategy_id) DO UPDATE SET version_id=EXCLUDED.version_id,next_due_at=EXCLUDED.next_due_at RETURNING *`,[service.endpoint,strategy.id,version.id,nextDue(schedule,now)])).rows[0];}
   if(new Date(clock.next_due_at)>now)continue;
   await service.createTaskWithin(db,cfg,{source:'routine',key:'strategy-due:'+strategy.id+':'+iso(clock.next_due_at),title:strategy.name,due:new Date(clock.next_due_at)});
   await db.query('UPDATE operations_autonomy_strategy_schedules_v1 SET next_due_at=$3 WHERE endpoint=$1 AND strategy_id=$2',[service.endpoint,strategy.id,nextDue(schedule,now)]);
  }
 }
}
