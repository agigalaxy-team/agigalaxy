import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transaction} from '../../database.mjs';
import {OperationsAutonomyNativeClient} from './native-client.mjs';
import {AutonomyReadModel} from './views.mjs';
import {automationResourceScope} from '../../shared/operations-automation-scope.mjs';
import {aiActionDefinition} from '../../shared/operations-ai-action-registry.mjs';
import {p14Evaluate} from '../rules/evaluator.mjs';
import {p14EmptyControls} from '../../shared/p14-rules-schema.mjs';
import {runAutonomyCode} from './code.mjs';
import {createAutonomyStrategyTask} from './strategy.mjs';
import {runtimeSettingsWithin,readAutonomySettings,saveAutonomySettings} from './settings.mjs';
import {operationsPermissionCatalog} from '../../operations-permission-catalog.mjs';
import {aiWorkCapabilities} from '../accounts/ai-work-schema.mjs';
import {taskContinuationWithin,recordTaskDecision,bindWorkbenchTaskWithin,workbenchHrefWithin} from './continuation.mjs';
import {updateWorkbenchTaskWithin} from './workbench.mjs';
import {autonomyDomains,autonomyDefaults,terminalStates,domainNames,defaultConfiguration,nextDue,parse,fail,iso,configSchema,controlSchema,enableSchema,authorizeSchema,reportSchema,toolSchema,boundaryPrompt,targetTypes} from './contract.mjs';

const errorCode=error=>/^[a-z][a-z0-9_.:-]{0,119}$/.test(error?.code??'')?error.code:'operations_autonomy_unavailable';
const present=row=>({id:row.id,domain:row.domain,revision:row.revision,...row.configuration,enabled:row.enabled,promptVersion:row.prompt_version,planVersion:row.plan_version,delegationVersion:row.delegation_version,nextDueAt:iso(row.next_due_at),lastValidAt:iso(row.last_valid_at),updatedAt:iso(row.updated_at)});
const sameActor=(a,b)=>a?.kind==='business-operator'&&b?.kind==='business-operator'&&a.operatorId===b.operatorId&&a.endpoint===b.endpoint;

/** One durable task per accepted intent. Neither dispatch retries nor model
 * completion can manufacture another business intent or a business receipt. */
export class OperationsAutonomy extends AutonomyReadModel{
 constructor({db,endpoint,businessAdmin,jobs=null,authority=null,client=null,aiWorkAccounts=null,queryTools=null,actionTools=null,gateway=null,summaryForTask=null,dutyTools=null,codeRunner=null,now=()=>Math.floor(Date.now()/1000),defaults={}}){
  super();Object.assign(this,{db,endpoint,businessAdmin,jobs,authority,client,aiWorkAccounts,queryTools,actionTools,gateway,summaryForTask,dutyTools,codeRunner,now});
  this.defaults={...autonomyDefaults,...defaults};this.native=new OperationsAutonomyNativeClient(client);
  this.codeRunner??=task=>this.runCodeTask({taskId:task.id});
  if(authority)authority.dutyAuthorizationWithin=(tx,context)=>this.dutyAuthorizationWithin(tx,context);
 }
 stamp(){return{checkedAt:this.now(),readExpiresAt:this.now()+30};}
 runCodeTask(input){return runAutonomyCode(this,input);}
 codeActionReady(permission){return['files.scan.retry','content.restore'].includes(permission);}
 continuationWithin(db,row){return taskContinuationWithin(this,db,row);}
 decide(operator,id,input,options){return recordTaskDecision(this,operator,id,input,options);}
 bindWorkbenchTaskWithin(db,input){return bindWorkbenchTaskWithin(this,db,input);}
 workbenchHrefWithin(db,row,actor){return workbenchHrefWithin(this,db,row,actor);}
 createStrategyTask(operator,input,options){return createAutonomyStrategyTask(this,operator,input,options);}
 settings(operator){return readAutonomySettings(this,operator);}
 saveSettings(operator,input,options){return saveAutonomySettings(this,operator,input,options);}
 async refreshSettingsWithin(db){const settings=await runtimeSettingsWithin(this,db);this.defaults={...this.defaults,...settings};return settings;}
 async options(operator){const actor=await this.actor(operator),allowed=actor.businessAuthorization.permissions;
  const accounts=[];let grants=[];const availability={accounts:allowed.includes('ai.accounts.read')?'available':'not-authorized',grants:allowed.includes('permissions.read')?'available':'not-authorized'};
  if(availability.accounts==='available'){for(const row of(await this.db.query('SELECT id,domain,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 ORDER BY domain',[this.endpoint])).rows){const current=await transaction(this.db,db=>this.aiWorkAccounts.authorizationWithin(db,row.domain,{accountId:row.id}));accounts.push({id:row.id,domain:row.domain,name:row.name,enabled:row.enabled,permissions:current.permissions});}}
  if(availability.grants==='available')grants=(await this.db.query('SELECT id,name,enabled,ai_account_id,permissions,executor_kind,mode,resource_ids,resource_scope_kind FROM operations_automation_grants_v1 WHERE endpoint=$1 ORDER BY name,id',[this.endpoint])).rows.map(r=>({id:r.id,name:r.name,enabled:r.enabled,aiAccountId:r.ai_account_id,permissions:r.permissions,executorKind:r.executor_kind,mode:r.mode,resourceScope:automationResourceScope(r)}));
  await this.actor(operator);return{accounts,grants,actions:operationsPermissionCatalog.map(({code,label,group,groupLabel,humanOnly,sensitive})=>({code,label,group,groupLabel,humanOnly,sensitive})),eventTypes:[{id:'feedback.changed',label:'使用反馈变化'},{id:'chat-report.changed',label:'私聊案件变化'},{id:'community-report.changed',label:'公开举报申诉变化'},{id:'operations.changed',label:'运营业务已提交变化'}],availability,...this.stamp()};
 }
 at(){return new Date(this.now()*1000);}
 async actor(operator,action='autonomy.read',{db=this.db,authorize=null}={}){
  if(authorize){const fresh=await authorize();if(!sameActor(operator,fresh))fail('business_admin_denied',403);operator=fresh;}
  if(operator?.kind!=='business-operator')fail('business_admin_denied',403);
  return this.businessAdmin.authorizeAction(operator,action,{db});
 }
 async ensureWithin(db){
  await this.refreshSettingsWithin(db);
  for(const domain of autonomyDomains){const cfg=defaultConfiguration(domain),at=this.at();
   const row=(await db.query(`INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,enabled,configuration,prompt_version,plan_version,created_at,updated_at)
    VALUES($1,$2,$3,1,false,$4,1,1,$5,$5) ON CONFLICT(endpoint,domain) DO NOTHING RETURNING *`,[randomUUID(),this.endpoint,domain,JSON.stringify(cfg),at])).rows[0];
   if(row)await this.versionWithin(db,row,null);
  }
 }
 async versionWithin(db,row,operatorId){await db.query(`INSERT INTO operations_autonomy_versions_v1(config_id,revision,configuration,prompt_version,plan_version,delegation_version,operator_id,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.id,row.revision,JSON.stringify(row.configuration),row.prompt_version,row.plan_version,row.delegation_version,operatorId,this.at()]);}
 async configWithin(db,domain,{lock=false,share=false}={}){parse(z.enum(autonomyDomains),domain);const row=(await db.query('SELECT * FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND domain=$2'+(lock?' FOR UPDATE':share?' FOR SHARE':''),[this.endpoint,domain])).rows[0];if(!row)fail('operations_autonomy_config_not_found',404);return row;}
 async readinessWithin(db,row,runtime){
  const reasons=[],add=(code,message)=>reasons.push({code,message});let account=null,role=null;
  try{role=await this.aiWorkAccounts.authorizationWithin(db,row.domain);account=(await db.query('SELECT id,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain=$2',[this.endpoint,row.domain])).rows[0];if(!role.enabled)add('ai-disabled','AI 工作账户已停用');if(!role.permissions.length)add('no-role','尚未分配业务权限');}
  catch{add('ai-unavailable','AI 工作账户暂不可用');}
  const cfg=row.configuration;
  const ordinaryActions=cfg.plan.actions.filter(code=>!aiActionDefinition(code)?.query&&aiActionDefinition(code)?.kind!=='ai-role-delegation');
  if(cfg.schedule.kind==='daily'&&!cfg.schedule.at)add('daily-time-required','请先选择每日运行时刻');
  if(cfg.schedule.kind==='interval'&&!Number.isInteger(cfg.schedule.minutes))add('interval-required','请选择巡检频率');
  if(cfg.mode!=='code'){
   if(runtime?.state!=='connected')add(runtime?.state==='not-configured'?'runtime-not-configured':'runtime-unavailable','运行服务暂不可用');
   if(runtime?.modelState!=='configured'||Array.isArray(runtime?.configuredDomains)&&!runtime.configuredDomains.includes(row.domain))add('model-not-configured','当前岗位尚无可用的人工模型配置');
  }
  if(cfg.mode==='code'&&!this.codeRunner)add('rule-not-configured','尚无接通的程序规则处理器');
  if(cfg.mode==='code'){
   const active=(await db.query('SELECT v.configuration FROM operations_p13_strategy_heads_v1 h JOIN operations_p13_strategy_versions_v1 v ON v.id=h.active_id WHERE h.endpoint=$1 AND NOT h.paused',[this.endpoint])).rows[0]?.configuration;
   const rules=active?.strategies.filter(s=>cfg.plan.strategyIds.includes(s.id)&&s.enabled&&s.mode==='code-automatic')??[];
   if(!rules.length||rules.some(s=>s.template!=='selected-public-content-visibility'&&!(s.execution?.actions.length===1&&['files.scan.retry','content.restore'].includes(s.execution.actions[0]))))add('rule-not-configured','请选择已发布且有确定处理参数的程序规则');
  }
  if(cfg.mode==='ai'&&ordinaryActions.length&&!cfg.plan.grantIds.length)add('authorization-required','自主动作尚未选择自动执行授权');
  if(cfg.plan.actions.some(action=>!role?.permissions.includes(action)))add('role-scope-missing','当前角色未包含计划中的业务动作');
  if(cfg.mode==='ai'&&ordinaryActions.length){
   const grants=(await db.query('SELECT * FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])',[this.endpoint,cfg.plan.grantIds])).rows;
   if(ordinaryActions.some(action=>!grants.some(g=>g.enabled&&g.executor_kind==='ai'&&g.mode==='automatic'&&g.ai_account_id===role?.accountId&&g.permissions.includes(action)&&automationResourceScope(g).kind!=='unresolved')))add('authorization-inactive','所选自动授权尚未覆盖当前岗位与动作');
  }
  return{ready:reasons.length===0,reasons,account,role};
 }
 async runtime(){try{return await this.client?.status()??{state:'not-configured',modelState:'not-configured'};}catch{return{state:'unavailable',modelState:'unknown'};}}
 async getConfig(operator,domain){await this.actor(operator);const runtime=await this.runtime();return transaction(this.db,async db=>{
  await this.actor(operator,'autonomy.read',{db});await this.ensureWithin(db);const row=await this.configWithin(db,domain),ready=await this.readinessWithin(db,row,runtime);
  const history=(await db.query('SELECT revision,prompt_version,plan_version,delegation_version,created_at FROM operations_autonomy_versions_v1 WHERE config_id=$1 ORDER BY revision DESC LIMIT 30',[row.id])).rows.map(r=>({revision:r.revision,promptVersion:r.prompt_version,planVersion:r.plan_version,delegationVersion:r.delegation_version,createdAt:iso(r.created_at)}));
  return{config:present(row),readiness:{ready:ready.ready,reasons:ready.reasons},history,...this.stamp()};
 });}
 async previousWithin(db,actor,id,kind,input){
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912480))',[this.endpoint+':'+id]);
  const old=(await db.query('SELECT * FROM operations_autonomy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id])).rows[0];if(!old)return null;
  if(old.operator_id!==actor.operatorId||old.kind!==kind||!isDeepStrictEqual(old.input,input))fail('operations_autonomy_operation_conflict');if(old.result.task?.id)await this.checkTarget(actor,await this.taskWithin(db,old.result.task.id),{db});return{...old.result,replayed:true,...this.stamp()};
 }
 async recordWithin(db,actor,id,kind,input,result){
  await db.query('INSERT INTO operations_autonomy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.endpoint,id,actor.operatorId,kind,JSON.stringify(input),JSON.stringify(result),this.at()]);
  await this.businessAdmin.recordWithin(db,actor,'autonomy-'+kind,{operationId:id,selection:{id:result.task?.id??result.config?.id??null},result:{kind,revision:result.task?.revision??result.config?.revision??null}});
  return{...result,...this.stamp()};
 }
 async operation(operator,id){parse(z.uuid(),id);return transaction(this.db,async db=>{const actor=await this.actor(operator,'autonomy.read',{db}),row=(await db.query('SELECT * FROM operations_autonomy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id])).rows[0];
  if(!row)return{state:'not-recorded',operationId:id,...this.stamp()};if(row.operator_id!==actor.operatorId)fail('operations_autonomy_operation_not_found',404);
  if(row.result.task?.id)await this.checkTarget(actor,await this.taskWithin(db,row.result.task.id),{db});return{state:'recorded',operationId:id,kind:row.kind,result:row.result,...this.stamp()};});}
 async saveConfig(operator,domain,input,{authorize}={}){
  const x=parse(configSchema,input);await this.actor(operator,'autonomy.configure',{authorize});const runtime=await this.runtime();
  return transaction(this.db,async db=>{const actor=await this.actor(operator,'autonomy.configure',{db,authorize});const previous=await this.previousWithin(db,actor,x.operationId,'config',{domain,...x});if(previous)return previous;
   await this.ensureWithin(db);const old=await this.configWithin(db,domain,{lock:true});if(old.revision!==x.expectedRevision)fail('operations_autonomy_revision_changed');
   const {operationId,expectedRevision:_expectedRevision,...cfg}=x,candidate={...old,configuration:cfg,enabled:x.enabled};
   if(x.enabled){const ready=await this.readinessWithin(db,candidate,runtime);if(!ready.ready)fail('operations_autonomy_not_ready');}
   const at=this.at(),next=x.enabled?(old.enabled&&isDeepStrictEqual(old.configuration.schedule,cfg.schedule)?old.next_due_at:nextDue(cfg.schedule,at)):null;
   const row=(await db.query(`UPDATE operations_autonomy_configs_v1 SET revision=revision+1,enabled=$3,configuration=$4,prompt_version=prompt_version+$5,plan_version=plan_version+$6,next_due_at=$7,
    enabled_at=CASE WHEN $3 AND NOT enabled THEN $8 ELSE enabled_at END,updated_by=$9,updated_at=$8 WHERE endpoint=$1 AND id=$2 RETURNING *`,[this.endpoint,old.id,x.enabled,JSON.stringify(cfg),old.configuration.prompt===cfg.prompt?0:1,isDeepStrictEqual(old.configuration.plan,cfg.plan)&&old.configuration.purpose===cfg.purpose&&old.configuration.mode===cfg.mode&&old.configuration.goal===cfg.goal?0:1,next,at,actor.operatorId])).rows[0];
   await this.versionWithin(db,row,actor.operatorId);if(!x.enabled)await this.pauseForConfigWithin(db,row.id);
   return this.recordWithin(db,actor,operationId,'config',{domain,...x},{operationId,config:present(row),replayed:false});
  });
 }
 async pauseForConfigWithin(db,id){await db.query(`UPDATE operations_autonomy_tasks_v1 SET state='paused',native_continuable=false,lease_until=NULL,revision=revision+1,code='plan-disabled',updated_at=$3
  WHERE endpoint=$1 AND config_id=$2 AND source<>'workbench' AND state IN ('queued','running')`,[this.endpoint,id,this.at()]);}
 async enable(operator,input,{authorize}={}){
  const x=parse(enableSchema,input);if(new Set(x.accounts.map(a=>a.domain)).size!==x.accounts.length)fail('invalid_operations_autonomy_request',400);
  await this.actor(operator,'autonomy.configure',{authorize});const runtime=await this.runtime();
  return transaction(this.db,async db=>{const actor=await this.actor(operator,'autonomy.configure',{db,authorize}),prior=await this.previousWithin(db,actor,x.operationId,'enable',x);if(prior)return prior;await this.ensureWithin(db);const rows=[];
   for(const item of [...x.accounts].sort((a,b)=>a.domain.localeCompare(b.domain))){const row=await this.configWithin(db,item.domain,{lock:true});if(row.revision!==item.expectedRevision)fail('operations_autonomy_revision_changed');const ready=await this.readinessWithin(db,row,runtime);if(!ready.ready)fail('operations_autonomy_not_ready');rows.push(row);}
   const accounts=[];for(const old of rows){if(old.enabled){accounts.push(present(old));continue;}const cfg={...old.configuration,enabled:true},row=(await db.query(`UPDATE operations_autonomy_configs_v1 SET revision=revision+1,enabled=true,configuration=$3,enabled_at=$4,next_due_at=$5,updated_by=$6,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING *`,[this.endpoint,old.id,JSON.stringify(cfg),this.at(),nextDue(cfg.schedule,this.at()),actor.operatorId])).rows[0];await this.versionWithin(db,row,actor.operatorId);accounts.push(present(row));}
   return this.recordWithin(db,actor,x.operationId,'enable',x,{operationId:x.operationId,accounts,replayed:false});
  });
 }
 async createTaskWithin(db,cfg,{id=randomUUID(),source='routine',key,title=null,due=this.at(),eventIds=[],targetType=null,targetId=null}){
  const account=(await db.query('SELECT id FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain=$2',[this.endpoint,cfg.domain])).rows[0];
  const grants=(await db.query('SELECT id,version FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])',[this.endpoint,cfg.configuration.plan.grantIds])).rows;
  const head=cfg.configuration.plan.strategyIds.length?(await db.query('SELECT active_id FROM operations_p13_strategy_heads_v1 WHERE endpoint=$1',[this.endpoint])).rows[0]:null;
  const delegation=account?(await db.query('SELECT version FROM operations_ai_role_delegations_v1 WHERE endpoint=$1 AND source_ai_account_id=$2',[this.endpoint,account.id])).rows[0]:null;
  const runtime=await this.refreshSettingsWithin(db),snapshot={...cfg.configuration,runtime,versionBindings:{grants,strategyVersionId:head?.active_id??null}};
  if(source!=='workbench'&&!snapshot.strategyExecution&&head?.active_id){
   const published=(await db.query('SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,head.active_id])).rows[0]?.configuration;
   const strategies=published?.strategies.filter(s=>snapshot.plan.strategyIds.includes(s.id))??[];
   snapshot.inspectionStrategyIds=strategies.filter(s=>s.execution&&s.execution.trigger.kind!=='manual').map(s=>s.id);
   if(snapshot.inspectionStrategyIds.length){const direct=strategies.filter(s=>!snapshot.inspectionStrategyIds.includes(s.id));snapshot.plan={...snapshot.plan,actions:snapshot.plan.actions.filter(code=>direct.some(s=>s.execution?.actions.includes(code)||s.template==='selected-public-content-visibility'&&['content.hide','content.restore'].includes(code)))};}
  }
  const row=(await db.query(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,config_id,config_revision,ai_account_id,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,delegation_version,session_id,event_ids,target_type,target_id,due_at,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,'not-started',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21) ON CONFLICT(endpoint,source_key) DO NOTHING RETURNING *`,
   [id,this.endpoint,cfg.id,cfg.revision,account?.id??null,cfg.domain,source,key,title??domainNames[cfg.domain]+(source==='event'?'事项处理':'例行巡检'),cfg.configuration.mode,cfg.configuration.mode==='code'?'not-required':'not-started',JSON.stringify(snapshot),cfg.prompt_version,cfg.plan_version,delegation?.version??null,randomUUID(),eventIds,targetType,targetId,due,this.at()])).rows[0];
  if(row&&source!=='workbench'&&this.jobs)await this.jobs.enqueue('autonomy-task',{taskId:row.id},{key:row.id,startAfter:due,db});return row;
 }
 async run(operator,domain,input,{authorize}={}){const x=parse(z.strictObject({operationId:z.uuid()}),input);await this.actor(operator,'autonomy.control',{authorize});return transaction(this.db,async db=>{
  const actor=await this.actor(operator,'autonomy.control',{db,authorize}),prior=await this.previousWithin(db,actor,x.operationId,'run',{domain,...x});if(prior)return prior;
  await this.ensureWithin(db);const cfg=await this.configWithin(db,domain);if(!cfg.enabled)fail('operations_autonomy_plan_disabled');
  const task=await this.createTaskWithin(db,cfg,{id:x.operationId,source:'routine',key:'manual:'+x.operationId});return this.recordWithin(db,actor,x.operationId,'run',{domain,...x},{operationId:x.operationId,task:await this.taskView(db,task,actor),replayed:false});
 });}
 async control(operator,id,input,{authorize}={}){
  parse(z.uuid(),id);const x=parse(controlSchema,input);await this.actor(operator,'autonomy.control',{authorize});
  let nativeBefore=null,continueTask=null;
  if(x.kind==='resume'){const candidate=await this.taskWithin(this.db,id);if(candidate.source!=='workbench'&&candidate.native_run_id&&candidate.state==='waiting-human'&&candidate.human_decision?.kind!=='takeover')nativeBefore=await this.native.read(candidate);}
  const result=await transaction(this.db,async db=>{const actor=await this.actor(operator,'autonomy.control',{db,authorize}),prior=await this.previousWithin(db,actor,x.operationId,'control',{id,...x});if(prior)return prior;
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912483))',[this.endpoint]);
   const reference=await this.taskWithin(db,id);const cfg=await this.configWithin(db,reference.domain,{share:true});
   const row=await this.taskWithin(db,id,{lock:true});await this.checkTarget(actor,row,{db});if(row.revision!==x.expectedRevision)fail('operations_autonomy_revision_changed');
   if(x.kind==='reconcile'){await this.enqueueReconcileWithin(db,row);return this.recordWithin(db,actor,x.operationId,'control',{id,...x},{operationId:x.operationId,task:await this.taskView(db,row,actor),replayed:false});}
   if(terminalStates.has(row.state))fail('operations_autonomy_task_terminal');
   let state=x.kind==='stop'?'stopped':x.kind==='takeover'?'waiting-human':x.kind==='pause'?'paused':'queued';
   if(x.kind==='resume'){
    if(!['paused','waiting-human','unknown'].includes(row.state))fail('operations_autonomy_not_paused');
    if(row.source==='workbench')fail('operations_autonomy_workbench_continuation_required');
    if(!cfg.enabled)fail('operations_autonomy_plan_disabled');
    if(row.dispatch_started_at){
     const continuation=await this.continuationWithin(db,row);
     if(nativeBefore?.status!=='PAUSED'||nativeBefore?.continuable!==true||nativeBefore.nativeRunId!==row.native_run_id||!continuation.allowed)fail('operations_autonomy_original_run_not_resumable');
     await this.refreshSettingsWithin(db);
     const busy=(await db.query("SELECT domain FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND state IN ('running','unknown') AND dispatch_started_at IS NOT NULL AND source<>'workbench' AND id<>$2",[this.endpoint,row.id])).rows;
     if(busy.length>=this.defaults.concurrency||busy.some(r=>r.domain===row.domain))fail('operations_autonomy_concurrency_busy');
     state='running';
    }
   }
   const decision=x.kind==='takeover'?{kind:'takeover',operatorId:actor.operatorId,at:iso(this.at())}:x.kind==='resume'?null:row.human_decision;
   const lease=state==='running'?new Date(this.at().getTime()+(row.configuration.runtime?.roundSeconds??this.defaults.roundSeconds)*1000):null;
   const saved=(await db.query(`UPDATE operations_autonomy_tasks_v1 SET state=$3,human_decision=$4,native_continuable=false,lease_owner=NULL,lease_until=$6,revision=revision+1,updated_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING *`,[this.endpoint,id,state,decision?JSON.stringify(decision):null,this.at(),lease])).rows[0];
   if(state==='running'&&x.kind==='resume'){await this.authorizeTaskWithin(db,saved);continueTask=saved;}
   if(state==='queued'&&this.jobs)await this.jobs.enqueue('autonomy-task',{taskId:id},{key:id+':resume:'+saved.revision,db});
   return this.recordWithin(db,actor,x.operationId,'control',{id,...x},{operationId:x.operationId,task:await this.taskView(db,saved,actor),replayed:false});
  });
  if(['stop','pause','takeover'].includes(x.kind)&&result.task?.nativeRunId){try{await this.native.cancel(await this.taskWithin(this.db,id));}catch{/* State fence is already durable; health reconciles this exact native run. */}}
  if(continueTask){try{const value=await this.native.continue(continueTask);await this.report({taskId:id,nativeRunId:continueTask.native_run_id,modelState:value.modelState??'accepted',status:'running'});}catch(error){await this.db.query("UPDATE operations_autonomy_tasks_v1 SET state='unknown',model_state='unknown',code=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 AND state='running'",[this.endpoint,id,errorCode(error),this.at()]);}}
  return result;
 }
 async taskWithin(db,id,{lock=false}={}){const row=(await db.query('SELECT * FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2'+(lock?' FOR UPDATE':''),[this.endpoint,id])).rows[0];if(!row)fail('operations_autonomy_task_not_found',404);return row;}
 async enqueueReconcileWithin(db,row){if(this.jobs)await this.jobs.enqueue('autonomy-task',{taskId:row.id,reconcile:true},{key:row.id+':reconcile:'+Math.floor(this.now()/30),db});}
 async dutyAuthorizationWithin(db,context,{persisted=false}={}){
  const reference=await this.taskWithin(db,context.taskId),cfg=await this.configWithin(db,reference.domain,{share:true});
  const row=(await db.query('SELECT * FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE',[this.endpoint,context.taskId])).rows[0];if(row.domain!==context.domain||row.ai_account_id!==context.aiAccountId||row.config_id!==context.planId||row.plan_version!==context.planVersion||context.purpose!==row.configuration.purpose)fail('operations_autonomy_scope_denied',403);
  if(row.source==='workbench'||!cfg.enabled||row.human_decision||(persisted?!['running','completed'].includes(row.state):row.state!=='running'||!row.lease_until||new Date(row.lease_until)<=this.at()))fail('operations_autonomy_task_inactive',409);
  return{allowed:true};
 }
 async validatePersistedOperationWithin(db,context,{sourceMatched=false}={}){
  if(!sourceMatched||!context?.operation)fail('operations_autonomy_scope_denied',403);
  return this.authorizeOperationWithin(db,{...context.operation,businessAction:context.businessAction,selection:context.selection},{persistedContext:context,sourceMatched:true});
 }
 async authorizeOperationWithin(db,{actor,permission,targetId,operationId,request,command,businessAction,grantId,grantVersion,strategyId,strategyVersionId:pinnedStrategyVersionId},{persistedContext=null,sourceMatched=false}={}){
  const context=persistedContext??this.authority.dutyContext(actor);await this.dutyAuthorizationWithin(db,context,{persisted:!!persistedContext});const row=await this.taskWithin(db,context.taskId),cfg=row.configuration;
  if(persistedContext)await db.query('SELECT public.galaxy_autonomy_lock_persisted_authority_v1($1,$2)',[this.endpoint,row.id]);
  if(persistedContext){const role=await this.aiWorkAccounts.authorizationWithin(db,row.domain,{accountId:row.ai_account_id});if(!role.enabled||!role.permissions.includes(permission))fail('operations_autonomy_authorization_changed',403);}
  if(!['ai','code'].includes(row.mode)||!cfg.plan.actions.includes(permission)||!targetId||!operationId)fail('operations_autonomy_scope_denied',403);
  if(request?.kind&&(await db.query(`SELECT 1 FROM operations_autonomy_decisions_v1 d JOIN operations_autonomy_tool_calls_v1 c ON c.endpoint=d.endpoint AND c.task_id=d.task_id AND c.call_id=d.call_id
   WHERE d.endpoint=$1 AND d.task_id=$2 AND c.arguments->>'kind'=$3 AND COALESCE(c.arguments->>'targetId',c.arguments->>'reportId',c.arguments->>'aiAccountId',c.arguments->>'id')=$4 LIMIT 1`,[this.endpoint,row.id,request.kind,targetId])).rows.length)fail('operations_autonomy_human_required');
  const definition=aiActionDefinition(permission);if(!definition?.autonomous||definition.humanOnly)fail('operations_autonomy_human_required');
  if(cfg.plan.resourceIds.length&&!cfg.plan.resourceIds.includes(targetId))fail('operations_autonomy_scope_denied',403);
  const grants=(await db.query('SELECT id,version,enabled,executor_kind,mode,ai_account_id,permissions,resource_ids,resource_scope_kind FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])'+(persistedContext?'':' FOR SHARE'),[this.endpoint,cfg.plan.grantIds])).rows;
  let accepted=null;for(const grant of grants){
   const frozen=cfg.versionBindings?.grants?.find(g=>g.id===grant.id),scope=automationResourceScope(grant);
   if(!frozen||frozen.version!==grant.version||!grant.enabled||grant.executor_kind!==(row.mode==='code'?'program':'ai')||grant.mode!=='automatic'||row.mode!=='code'&&grant.ai_account_id!==row.ai_account_id||!grant.permissions.includes(permission))continue;
   if(scope.kind==='selected'&&scope.resourceIds.includes(targetId)){accepted=grant;break;}
   if(scope.kind==='eligible'&&persistedContext&&sourceMatched&&context.operation.targetId===targetId){accepted=grant;break;}
   if(scope.kind==='eligible'&&typeof this.actionTools?.qualifyDutyTargetWithin==='function'&&request&&command){await this.actionTools.qualifyDutyTargetWithin(db,{actor,permission,targetId,request,command,grantId:grant.id});accepted=grant;break;}
  }
  if(!accepted)fail('operations_autonomy_authorization_changed',403);
  if(persistedContext&&(grantId!==accepted.id||grantVersion!==accepted.version))fail('operations_autonomy_authorization_changed',403);
  if(!cfg.plan.strategyIds.length)fail('operations_autonomy_human_required');
  let selectedStrategy,strategyVersionId;
  {
   const head=(await db.query('SELECT * FROM operations_p13_strategy_heads_v1 WHERE endpoint=$1'+(persistedContext?'':' FOR SHARE'),[this.endpoint])).rows[0],pinned=cfg.versionBindings?.strategyVersionId;
   if(!head||head.paused||!pinned||head.blocked_version_ids.includes(pinned))fail('operations_autonomy_strategy_stopped');
   const current=(await db.query('SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,head.active_id])).rows[0]?.configuration;
   if(!current?.common?.automationEnabled)fail('operations_autonomy_strategy_stopped');
   const original=(await db.query('SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,pinned])).rows[0]?.configuration;
   selectedStrategy=original?.strategies.find(s=>cfg.plan.strategyIds.includes(s.id)&&s.enabled&&current.strategies.some(c=>c.id===s.id&&c.enabled&&c.mode!=='human-led')&&
    (s.template==='selected-public-content-visibility'&&['content.hide','content.restore'].includes(permission)||s.template==='business-action'&&s.execution?.actions?.includes(permission)));
   if(!selectedStrategy||!['ai-autonomous','code-automatic'].includes(selectedStrategy.mode))fail('operations_autonomy_human_required');
   if(!current.domains.some(d=>d.key===selectedStrategy.domain&&d.executionEnabled))fail('operations_autonomy_strategy_stopped');
   const scope=selectedStrategy.execution?.resourceScope;
   if(scope?.kind==='unresolved'||scope?.kind==='selected'&&!scope.resourceIds.includes(targetId)||selectedStrategy.execution?.requiredRehearsal&&!((await db.query("SELECT 1 FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND version_id=$2 AND result->>'valid'='true' AND NOT (COALESCE(result->'uncoveredStrategyIds','[]'::jsonb) ? $3) LIMIT 1",[this.endpoint,pinned,selectedStrategy.id])).rows.length))fail('operations_autonomy_human_required');
   if(selectedStrategy.condition){
    if(!command){if(businessAction)fail('operations_autonomy_human_required');}
    else if(selectedStrategy.template==='selected-public-content-visibility'&&request?.targetKind&&this.authority.content){
     const content=this.authority.content,raw=await content.rawWithin(db,request.targetKind,targetId),source=await content.publicSourceWithin(db,request.targetKind,raw.head,raw.source);
     if(!source.available)fail('operations_autonomy_source_unavailable');const payload=source.payload;
     const result=p14Evaluate({...p14EmptyControls,rules:[{id:selectedStrategy.id,name:'当前策略条件',enabled:true,targets:[request.targetKind==='post'?'forum-post':'forum-reply'],conditions:selectedStrategy.condition,action:'reject',exceptions:[]}]},{target:request.targetKind==='post'?'forum-post':'forum-reply',text:payload.body??payload.text??'',links:payload.links??[],attachmentCount:(payload.attachments??[]).length});
     if(result.rules[0]?.state!=='hit')fail('operations_autonomy_condition_not_met');
    }else fail('operations_autonomy_human_required');
   }
   strategyVersionId=pinned;
  }
  if(persistedContext&&(strategyId!==selectedStrategy.id||pinnedStrategyVersionId!==strategyVersionId))fail('operations_autonomy_strategy_stopped');
  return{allowed:true,grantId:accepted.id,grantVersion:accepted.version,strategyId:selectedStrategy.id,strategyVersionId};
 }
 async authorizeTaskWithin(db,row,{active=true}={}){
  if(active&&!['running'].includes(row.state))fail('operations_autonomy_task_inactive');
  if(!this.authority?.dutyActorWithin)fail('operations_autonomy_authority_unavailable',503);
  return this.authority.dutyActorWithin(db,{domain:row.domain,aiAccountId:row.ai_account_id,taskId:row.id,purpose:row.configuration.purpose,planId:row.config_id,planVersion:row.plan_version,delegationVersion:row.delegation_version,resourceIds:row.configuration.plan.resourceIds});
 }
 async toolsWithin(db,row,actor){
  const role=await this.aiWorkAccounts.authorizationWithin(db,row.domain,{accountId:row.ai_account_id}),capabilities=aiWorkCapabilities(row.domain,role.permissions),tools=[];
  if(capabilities.queryPermissions.length){if(this.summaryForTask)tools.push('current-summary');if(this.queryTools)tools.push('query-operations','read-operation-object');}
  if(this.dutyTools&&['ai','code'].includes(row.mode)&&row.configuration.plan.actions.some(code=>role.permissions.includes(code)&&aiActionDefinition(code)?.autonomous&&!aiActionDefinition(code)?.query&&this.actionTools?.dutyActionReady?.(code)===true))tools.push('execute-operation');
  if(this.dutyTools&&typeof this.authority.permissions?.delegationAvailabilityWithin==='function'){const delegation=await this.authority.permissions.delegationAvailabilityWithin(db,{actor});if(delegation.canRead)tools.push('read-ai-delegation');if(['ai','code'].includes(row.mode)&&delegation.managementActions.some(action=>row.configuration.plan.actions.includes('ai.roles.'+action)))tools.push('manage-ai-role');}
  return tools;
 }
 async authorize(input){const x=parse(authorizeSchema,input);return transaction(this.db,async db=>{
  const row=await this.taskWithin(db,x.taskId);const actor=x.operation!=='read'?await this.authorizeTaskWithin(db,row):null;
  if(x.operation==='read'&&!row.dispatch_started_at)fail('operations_autonomy_task_inactive');
  const cfg=row.configuration;
  const tools=actor?await this.toolsWithin(db,row,actor):[];
  const continuation=await this.continuationWithin(db,row);
  return{allowed:true,task:{taskId:row.id,operationId:row.id,planId:row.config_id,planVersion:row.plan_version,promptVersion:row.prompt_version,delegationVersion:row.delegation_version,domain:row.domain,aiAccountId:row.ai_account_id,mode:row.mode,source:row.source,purpose:cfg.purpose,sessionId:row.session_id,roleVersion:actor?.businessAuthorization?.version??null,scopeVersion:row.plan_version,
   state:row.state,businessState:row.business_state,effectiveCheck:row.effective_check,runtime:cfg.runtime,roundSeconds:cfg.runtime?.roundSeconds??this.defaults.roundSeconds,continuation,prompt:{boundary:boundaryPrompt,role:cfg.prompt,context:{title:row.title,source:row.source,eventIds:row.event_ids,goal:cfg.goal}},plan:cfg.plan,scope:{actions:cfg.plan.actions,resourceIds:cfg.plan.resourceIds},modelBinding:{domain:row.domain,source:'current-manual-model-settings'},tools},readExpiresAt:this.now()+30};
 });}
 async report(input){const x=parse(reportSchema,input);return transaction(this.db,async db=>{const row=await this.taskWithin(db,x.taskId,{lock:true});
  if(!row.dispatch_started_at)fail('operations_autonomy_task_inactive');if(row.native_run_id&&x.nativeRunId&&row.native_run_id!==x.nativeRunId)fail('operations_autonomy_operation_conflict');
  if(terminalStates.has(row.state)||['paused','waiting-human'].includes(row.state)&&row.human_decision){await db.query('UPDATE operations_autonomy_tasks_v1 SET native_run_id=COALESCE(native_run_id,$3),model_state=$4 WHERE endpoint=$1 AND id=$2',[this.endpoint,row.id,x.nativeRunId??null,x.modelState]);return{taskId:row.id,state:row.state,...this.stamp()};}
  const receipt=(await db.query('SELECT state FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2',[this.endpoint,row.id])).rows;
  const business=receipt.some(r=>r.state==='unknown')?'unknown':receipt.some(r=>r.state==='failed')?'failed':receipt.some(r=>r.state==='completed')?'completed':receipt.some(r=>r.state==='no-action')?'no-action':row.business_state;
  // A model's completed status closes generation only. Without an actual read
  // or business receipt there is no evidence of a completed inspection.
  const state=x.status==='completed'?(row.effective_check||business==='completed'||business==='no-action'?'completed':'waiting-human'):x.status;
  const done=['completed','failed'].includes(state),at=this.at();
  await db.query(`UPDATE operations_autonomy_tasks_v1 SET state=$3,model_state=$4,business_state=$5,native_run_id=COALESCE(native_run_id,$6),code=$7,
   lease_until=CASE WHEN $8 OR $3='waiting-human' THEN NULL ELSE lease_until END,completed_at=CASE WHEN $8 THEN $9 ELSE completed_at END,revision=revision+1,updated_at=$9 WHERE endpoint=$1 AND id=$2`,[this.endpoint,row.id,state,x.modelState,business,x.nativeRunId??null,x.code??(state==='waiting-human'&&x.status==='completed'?'effective-check-required':null),done,at]);
  if(state==='completed'&&row.effective_check)await db.query('UPDATE operations_autonomy_configs_v1 SET last_valid_at=$3 WHERE endpoint=$1 AND id=$2',[this.endpoint,row.config_id,at]);
  return{taskId:row.id,state,modelState:x.modelState,businessState:business,...this.stamp()};
 });}
 async waitForHumanWithin(db,{taskId,operationId,code='operations_autonomy_human_required'}){
  const row=await this.taskWithin(db,taskId,{lock:true});if(terminalStates.has(row.state))return;
  await db.query(`UPDATE operations_autonomy_tasks_v1 SET state='waiting-human',human_decision=$3,lease_until=NULL,revision=revision+1,code=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2`,[this.endpoint,taskId,JSON.stringify({kind:'decision-required',operationId,code,at:iso(this.at())}),code,this.at()]);
 }
 async tool(input,{ruleSource=false}={}){const x=parse(toolSchema,input);const binding=await transaction(this.db,async db=>{const row=await this.taskWithin(db,x.taskId);let actor=await this.authorizeTaskWithin(db,row);if(row.native_run_id&&x.nativeRunId!==row.native_run_id)fail('operations_autonomy_scope_denied',403);
  if(!(await this.toolsWithin(db,row,actor)).includes(x.tool))fail('operations_permission_denied',403);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912481))',[row.id+':'+x.callId]);const prior=(await db.query('SELECT * FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3',[this.endpoint,row.id,x.callId])).rows[0];
  if(prior&&(prior.tool!==x.tool||!isDeepStrictEqual(prior.arguments,x.arguments)))fail('operations_autonomy_operation_conflict');
  const operationId=prior?.operation_id??randomUUID();if(!prior)await db.query(`INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'started',$7,$7)`,[this.endpoint,row.id,x.callId,x.tool,JSON.stringify(x.arguments),operationId,this.at()]);
  if(typeof this.authority.bindDutyAuditSourceWithin==='function')actor=await this.authority.bindDutyAuditSourceWithin(db,actor,{callId:x.callId,operationId,nativeRunId:x.nativeRunId??null,ruleSource});
  return{row,actor,operationId,prior};});
  try{
   let result;const {row,actor,operationId}=binding;
   if(['query-operations','read-operation-object'].includes(x.tool)){
    if(!this.queryTools)fail('operations_autonomy_tool_not_configured',503);
    result=await this.queryTools.execute({actor,domain:row.domain,tool:x.tool,arguments:x.arguments});
   }else if(x.tool==='current-summary'){
    if(Object.keys(x.arguments).length)fail('invalid_operations_autonomy_request',400);
    if(!this.summaryForTask)fail('operations_autonomy_tool_not_configured',503);result=await this.summaryForTask(actor,row);
   }else{
    if(!['ai','code'].includes(row.mode)&&['execute-operation','manage-ai-role'].includes(x.tool))fail('operations_autonomy_human_required');
    if(x.tool==='manage-ai-role'){const action=x.arguments.kind==='role-create'?'create':x.arguments.kind==='role-update'?'update':x.arguments.enabled===true?'assign':'revoke';if(!row.configuration.plan.actions.includes('ai.roles.'+action))fail('operations_autonomy_scope_denied',403);}
    if(!this.dutyTools)fail('operations_autonomy_tool_not_configured',503);
    // Repeated writes must be resolved by the original domain operation. The
    // callback is never allowed to replace this server-owned operationId.
    result=await this.dutyTools({task:row,actor,operationId,callId:x.callId,tool:x.tool,arguments:x.arguments,reconcile:!!binding.prior});
   }
   await transaction(this.db,async db=>{const current=await this.taskWithin(db,x.taskId);
    if(['current-summary','query-operations','read-operation-object'].includes(x.tool))await this.authorizeTaskWithin(db,current);
    await db.query(`UPDATE operations_autonomy_tool_calls_v1 SET state=$5,code=$6,updated_at=$4 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`,[this.endpoint,x.taskId,x.callId,this.at(),result?.state==='waiting-human'?'waiting-human':'completed',result?.state==='waiting-human'?result.reason??result.code??'operations_autonomy_human_required':null]);
    if(['current-summary','query-operations','read-operation-object'].includes(x.tool)&&result?.availability==='available')await db.query('UPDATE operations_autonomy_tasks_v1 SET effective_check=true,updated_at=$3 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.taskId,this.at()]);
    if(result?.businessReceipt){if(result.operationId!==operationId)fail('operations_autonomy_operation_conflict');await this.recordBusinessReceiptWithin(db,{taskId:x.taskId,operationId,...result.businessReceipt});}
    if(result?.state==='waiting-human')await this.waitForHumanWithin(db,{taskId:x.taskId,operationId,code:result.reason??'operations_autonomy_human_required'});
   });return result;
  }catch(error){await this.db.query(`UPDATE operations_autonomy_tool_calls_v1 SET state='unknown',code=$4,updated_at=$5 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`,[this.endpoint,x.taskId,x.callId,errorCode(error),this.at()]);throw error;}
 }
 /** Only trusted domain adapters call this after a persisted domain receipt;
  * the native reporting HTTP route cannot create business success facts. */
 async recordBusinessReceiptWithin(db,{taskId,operationId,action,targetType=null,targetId=null,state,basis,details=null}){
  parse(z.uuid(),taskId);parse(z.uuid(),operationId);if(!['completed','failed','unknown','no-action'].includes(state)||typeof basis!=='string'||!basis)fail('operations_autonomy_receipt_invalid',400);
  if(details)details=parse(z.strictObject({counts:z.strictObject({applied:z.number().int().nonnegative(),rejected:z.number().int().nonnegative()}),items:z.array(z.strictObject({kind:z.enum(['post','reply']),id:z.uuid(),status:z.enum(['applied','rejected']),code:z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/).nullable(),revision:z.number().int().nonnegative().nullable()})).max(100)}),details);
  await this.taskWithin(db,taskId);const old=(await db.query('SELECT action,target_type,target_id FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3',[this.endpoint,taskId,operationId])).rows[0];
  if(old&&(old.action!==action||old.target_type!==targetType||old.target_id!==targetId))fail('operations_autonomy_operation_conflict');
  await db.query(`INSERT INTO operations_autonomy_receipts_v1(id,endpoint,task_id,operation_id,action,target_type,target_id,state,basis,created_at,details)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(endpoint,task_id,operation_id) DO UPDATE SET state=EXCLUDED.state,basis=EXCLUDED.basis,details=COALESCE(EXCLUDED.details,operations_autonomy_receipts_v1.details)
   WHERE operations_autonomy_receipts_v1.state='unknown' OR operations_autonomy_receipts_v1.state=EXCLUDED.state`,[randomUUID(),this.endpoint,taskId,operationId,action,targetType,targetId,state,basis,this.at(),details?JSON.stringify(details):null]);
  const receipts=(await db.query('SELECT state FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2',[this.endpoint,taskId])).rows;
  const business=receipts.some(r=>r.state==='unknown')?'unknown':receipts.some(r=>r.state==='failed')?'failed':receipts.some(r=>r.state==='completed')?'completed':'no-action';
  await db.query('UPDATE operations_autonomy_tasks_v1 SET business_state=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2',[this.endpoint,taskId,business,this.at()]);
 }
 /** An outbox write belongs to the same transaction as the business commit.
  * No body, reason, prompt or arbitrary event payload is copied. */
 async emitWithin(db,{id=randomUUID(),domain,eventKey,type,targetType=null,targetId=null,sourceVersion=null}){
  parse(z.enum(autonomyDomains),domain);if(!/^[a-z][a-z0-9_.:-]{0,119}$/.test(type)||typeof eventKey!=='string'||!eventKey||eventKey.length>300||targetType&&!targetTypes.includes(targetType)||!!targetType!==!!targetId)fail('operations_autonomy_event_invalid',400);
  return (await db.query(`INSERT INTO operations_autonomy_events_v1(id,endpoint,domain,event_key,event_type,target_type,target_id,source_version,created_at,available_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(endpoint,event_key) DO NOTHING RETURNING id`,[id,this.endpoint,domain,eventKey,type,targetType,targetId,sourceVersion===null?null:String(sourceVersion),this.at(),new Date((this.now()+this.defaults.eventCoalesceSeconds)*1000)])).rows[0]?.id??null;
 }
 /** New workbench turns join this ledger without replaying old conversations. */
 async linkWorkbenchWithin(db,{operationId,domain,aiAccountId,nativeRunId=null,modelState='accepted',targetType=null,targetId=null,conversationId=null,sessionId=null,operatorId=null}){
  parse(z.uuid(),operationId);await this.ensureWithin(db);const cfg=await this.configWithin(db,domain),row=await this.createTaskWithin(db,cfg,{id:operationId,source:'workbench',key:'workbench:'+operationId,title:domainNames[domain]+'工作台事项',targetType,targetId});
  if(!row)return this.taskWithin(db,operationId);
  const cfgSnapshot={...row.configuration,externalWorkbench:{conversationId,sessionId,operatorId,turnOperationId:operationId}};
  await db.query(`UPDATE operations_autonomy_tasks_v1 SET ai_account_id=$3,state='running',mode='human-ai',configuration=$7,model_state=$4,native_run_id=$5,dispatch_started_at=$6 WHERE endpoint=$1 AND id=$2`,[this.endpoint,operationId,aiAccountId,modelState,nativeRunId,this.at(),JSON.stringify(cfgSnapshot)]);
  return this.updateWorkbenchWithin(db,{operationId,turnOperationId:operationId,nativeRunId,modelState,status:'running'});
 }
 updateWorkbenchWithin(db,input){return updateWorkbenchTaskWithin(this,db,input);}
}
