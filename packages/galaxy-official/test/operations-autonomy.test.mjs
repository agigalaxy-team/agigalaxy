import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,transaction} from '../src/database.mjs';
import {OperationsAutonomy,createOperationsAutonomyWorker} from '../src/operations-autonomy.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {AiWorkAccountsReadModel} from '../src/operations/accounts/ai-work-read-model.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {queueFixture} from './operations-jobs-fixture.mjs';
import {dispatchOperationsAutonomy} from '../src/adapters/http/operations-autonomy-http.mjs';
import {createAutonomyMetrics} from '../src/operations/autonomy/metrics.mjs';

test('durable autonomy plans, original operations, authority fences and receipt-based counts',{timeout:120000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api','worker']});
 let at=1988210000;const now=()=>at,endpoint='https://autonomy.synthetic.invalid',operator={kind:'business-operator',operatorId:'autonomy-owner',endpoint,role:'administrator'};
 await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://native.synthetic.invalid',$1,'合成管理账户',$3,$3)",[operator.operatorId,endpoint,new Date(at*1000)]);
 const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async()=> 'administrator',now});
 const businessAdmin=new BusinessAdminService({db,endpoint,permissions,now});
 const aiWorkAccounts=new AiWorkAccountsReadModel({db,endpoint,businessAdmin,now});permissions.aiWorkAccounts=aiWorkAccounts;
 const authority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts,now});businessAdmin.executorAuthority=authority;
 const role=(await permissions.saveRole(operator,{operationId:randomUUID(),expectedVersion:0,name:'当前只读岗位',description:'测试夹具',enabled:true,permissions:['content.read','analytics.read']},{authorize:async()=>operator})).role;
 const ids=new Map();for(const domain of ['overview','governance','messaging','discovery','maintenance']){const id=randomUUID();ids.set(domain,id);await db.query(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,$3,$3,'',true,1,1,$4,$4)`,[id,endpoint,domain,new Date(at*1000)]);await db.query(`INSERT INTO operations_ai_work_assignments_v1(id,endpoint,ai_account_id,role_id,enabled,version,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$5,$5)`,[randomUUID(),endpoint,id,role.id,new Date(at*1000)]);}
 const queue=queueFixture(db);await queue.jobs.start();t.after(()=>queue.jobs.stop());
 const client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['overview','governance','messaging','discovery','maintenance']};}};
 const autonomy=new OperationsAutonomy({db,endpoint,businessAdmin,jobs:queue.jobs,authority,client,aiWorkAccounts,now});
 const worker=createOperationsAutonomyWorker({autonomy,jobs:queue.jobs}),authorize=async()=>operator;
 const save=async(domain,changes={})=>{const current=(await autonomy.getConfig(operator,domain)).config;const {id:_id,revision,promptVersion:_promptVersion,planVersion:_planVersion,delegationVersion:_delegationVersion,nextDueAt:_nextDueAt,lastValidAt:_lastValidAt,updatedAt:_updatedAt,...value}=current;delete value.domain;return autonomy.saveConfig(operator,domain,{...value,...changes,operationId:randomUUID(),expectedRevision:revision},{authorize});};
 await t.test('first read has five disabled plans, no synthetic timeline and unknown uncollected usage',async()=>{
  await db.query('SET ROLE galaxy_api');const result=await autonomy.overview(operator);assert.equal(result.accounts.length,5);assert.ok(result.accounts.every(a=>a.enabled===false&&a.nextDueAt===null));assert.equal(result.summary.businessCompleted,0);assert.equal(result.summary.onTimeRate,null);assert.deepEqual(result.timeline,[]);assert.equal(result.usage.totals.totalTokens,null);assert.equal(result.accounts.find(a=>a.domain==='maintenance').readiness.ready,false);
  await db.query('RESET ROLE');
 });
 await t.test('on-time completion uses all expected routine tasks and their frozen completion deadline',async()=>{
  const cfg=await autonomy.configWithin(db,'governance'),sampleIds=Array.from({length:10},()=>randomUUID()),due=new Date((at-1000)*1000),deadline=new Date(due.getTime()+90000),configuration={...cfg.configuration,runtime:{startGraceSeconds:30,roundSeconds:60}};
  try{
   for(const[index,id]of sampleIds.entries())await db.query(`INSERT INTO operations_autonomy_tasks_v1(id,endpoint,config_id,config_revision,ai_account_id,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,effective_check,due_at,started_at,completed_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'governance','routine',$6,'合成按时率样本','code',$7,'not-required','no-action',$8,1,1,$9,$10,$11,$12,$13,$11,$13)`,[id,endpoint,cfg.id,cfg.revision,ids.get('governance'),'on-time-sample:'+id,index===0?'completed':'failed',JSON.stringify(configuration),randomUUID(),index===0,due,new Date(due.getTime()+10000),deadline]);
   const summary=(await autonomy.overview(operator)).summary;assert.equal(summary.expected,10);assert.equal(summary.completed,1);assert.equal(summary.failed,9);assert.equal(summary.onTimeRate,0.1);
   // The task began on time but finished one millisecond after its frozen
   // 30s + 60s window. The current service defaults are longer and cannot extend it.
   await db.query('UPDATE operations_autonomy_tasks_v1 SET completed_at=$2 WHERE id=$1',[sampleIds[0],new Date(deadline.getTime()+1)]);
   const late=(await autonomy.overview(operator)).summary;assert.equal(late.completed,1);assert.equal(late.onTimeRate,0);
   await db.query('UPDATE operations_autonomy_tasks_v1 SET completed_at=NULL WHERE id=$1',[sampleIds[0]]);assert.equal((await autonomy.overview(operator)).summary.onTimeRate,0);
  }finally{await db.query('DELETE FROM operations_autonomy_tasks_v1 WHERE id=ANY($1::uuid[])',[sampleIds]);}
  const empty=await autonomy.overview(operator);assert.equal(empty.summary.expected,0);assert.equal(empty.summary.onTimeRate,null);assert.equal(empty.basis.recovery,'single-coalesced-catch-up-with-original-due-no-historical-slot-count');
 });
 await t.test('daily time is an enable condition; disabled draft and same original operation replay remain valid',async()=>{
  const old=(await autonomy.getConfig(operator,'maintenance')).config;
  await assert.rejects(save('maintenance',{enabled:true}),{code:'operations_autonomy_not_ready'});
  const input={operationId:randomUUID(),expectedRevision:old.revision,enabled:false,mode:'ai-human',schedule:old.schedule,purpose:old.purpose,goal:'日巡',prompt:'只读实际运维事实',plan:old.plan};
  const first=await autonomy.saveConfig(operator,'maintenance',input,{authorize});assert.equal(first.config.enabled,false);assert.equal(first.config.promptVersion,2);assert.equal((await autonomy.saveConfig(operator,'maintenance',input,{authorize})).replayed,true);
  const receipt=await autonomy.operation(operator,input.operationId);assert.equal(receipt.state,'recorded');assert.equal(receipt.result.config.revision,first.config.revision);
  assert.equal((await autonomy.operation(operator,randomUUID())).state,'not-recorded');
 });
 await t.test('outbox and task enqueue roll back with the business transaction',async()=>{
  await assert.rejects(transaction(db,async tx=>{await autonomy.emitWithin(tx,{domain:'governance',eventKey:'rolled-back',type:'content.changed'});throw Error('rollback');}));
  assert.equal((await db.query("SELECT count(*)::int n FROM operations_autonomy_events_v1 WHERE event_key='rolled-back'")).rows[0].n,0);
  const cfg=await autonomy.configWithin(db,'governance');await assert.rejects(transaction(db,async tx=>{await autonomy.createTaskWithin(tx,cfg,{key:'rollback-task'});throw Error('rollback');}));
  assert.equal((await db.query("SELECT count(*)::int n FROM operations_autonomy_tasks_v1 WHERE source_key='rollback-task'")).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM galaxy_jobs.job WHERE name='autonomy-task'")).rows[0].n,0);
 });
 let original;
 await t.test('one recovery round coalesces missed intervals and model completion is not business completion',async()=>{
  const enabled=await save('governance',{enabled:true,plan:{strategyIds:[],grantIds:[],actions:[],resourceIds:[],eventTypes:['content.changed']}}),firstDue=enabled.config.nextDueAt;
  at+=3*3600;await db.query('SET ROLE galaxy_evidence_worker');await worker.tick();await worker.tick();await db.query('RESET ROLE');
  const rows=(await db.query("SELECT * FROM operations_autonomy_tasks_v1 WHERE domain='governance' AND source='routine'")).rows;assert.equal(rows.length,1);original=rows[0];assert.equal(new Date(original.due_at).toISOString(),firstDue);assert.ok(new Date((await autonomy.configWithin(db,'governance')).next_due_at)>autonomy.at());assert.equal((await autonomy.overview(operator)).summary.expected,1);
  let posts=0,gets=0;autonomy.native={async run(){posts++;throw Object.assign(Error(),{code:'operations_autonomy_result_unknown'});},async read(){gets++;return{nativeRunId:'original-run',status:'COMPLETED',modelState:'completed'};},async cancel(){return{};}};
  await worker.execute({taskId:original.id});await worker.execute({taskId:original.id});assert.equal(posts,1);assert.equal(gets,1);
  const row=await autonomy.taskWithin(db,original.id);assert.equal(row.state,'waiting-human');assert.equal(row.business_state,'not-started');assert.equal((await autonomy.overview(operator)).summary.businessCompleted,0);
 });
 await t.test('current role and human takeover fence every tool and late completion cannot reopen it',async()=>{
  const cfg=await autonomy.configWithin(db,'governance');const task=await transaction(db,tx=>autonomy.createTaskWithin(tx,cfg,{key:'current-role'}));
  autonomy.native={async run(){return{nativeRunId:'role-run',status:'RUNNING',modelState:'running'};},async cancel(){return{};}};
  await worker.execute({taskId:task.id});
  autonomy.queryTools={async execute({actor}){await authority.requireDutyAction(actor,'content.read');return{availability:'available',data:{items:[]}};}};
  await autonomy.tool({taskId:task.id,nativeRunId:'role-run',callId:randomUUID(),tool:'query-operations',arguments:{module:'content',view:'list'}});
  await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=false WHERE ai_account_id=$1',[ids.get('governance')]);
  await assert.rejects(autonomy.tool({taskId:task.id,nativeRunId:'role-run',callId:randomUUID(),tool:'query-operations',arguments:{module:'content',view:'list'}}),{code:'operations_permission_denied'});
  const current=await autonomy.taskWithin(db,task.id);await autonomy.control(operator,task.id,{operationId:randomUUID(),expectedRevision:current.revision,kind:'takeover'},{authorize});
  await autonomy.report({taskId:task.id,nativeRunId:'role-run',modelState:'completed',status:'completed'});
  const stopped=await autonomy.taskWithin(db,task.id);assert.equal(stopped.state,'waiting-human');assert.equal(stopped.human_decision.kind,'takeover');
  await assert.rejects(autonomy.authorize({taskId:task.id,operation:'tool'}),{code:'operations_autonomy_task_inactive'});
 });
 await t.test('business counts require actual trusted domain receipts and model reports cannot supply counts',async()=>{
  await assert.rejects(autonomy.report({taskId:original.id,status:'completed',modelState:'completed',businessCompleted:1}),{code:'invalid_operations_autonomy_request'});
  await transaction(db,tx=>autonomy.recordBusinessReceiptWithin(tx,{taskId:original.id,operationId:randomUUID(),action:'test-actual-domain-receipt',state:'completed',basis:'synthetic-domain-ack'}));
  assert.equal((await autonomy.overview(operator)).summary.businessCompleted,1);
 });
 await t.test('advanced settings hot-load for new rounds while existing task snapshots retain their limits',async()=>{
  const before=(await autonomy.settings(operator)).settings;const saved=await autonomy.saveSettings(operator,{operationId:randomUUID(),expectedRevision:before.revision,concurrency:1,healthSeconds:20,startGraceSeconds:90,roundSeconds:240,eventCoalesceSeconds:12},{authorize});
  assert.equal(saved.settings.revision,before.revision+1);const cfg=await autonomy.configWithin(db,'overview');
  const task=await transaction(db,tx=>autonomy.createTaskWithin(tx,cfg,{key:'new-settings'}));assert.equal(task.configuration.runtime.roundSeconds,240);assert.equal(task.configuration.runtime.concurrency,1);
  assert.equal((await autonomy.taskWithin(db,original.id)).configuration.runtime.roundSeconds,600);
  await assert.rejects(autonomy.saveSettings(operator,{operationId:randomUUID(),expectedRevision:saved.settings.revision,concurrency:3,healthSeconds:20,startGraceSeconds:90,roundSeconds:240,eventCoalesceSeconds:12},{authorize}),{code:'invalid_operations_autonomy_request'});
 });
 await t.test('fixed-rule miss runs through actual P14 evaluation with no model and a no-action receipt',async()=>{
  await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=true WHERE ai_account_id=$1',[ids.get('governance')]);
  const strategyId=randomUUID(),versionId=randomUUID(),targetId=randomUUID(),cfg=await autonomy.configWithin(db,'governance');
  const configuration={common:{automationEnabled:true},domains:[{key:'governance',executionEnabled:true}],strategies:[{id:strategyId,name:'固定长度规则',enabled:true,mode:'code-automatic',template:'selected-public-content-visibility',condition:{combinator:'and',rules:[{field:'textLength',operator:'gt',value:500}]}}]};
  await db.query('INSERT INTO operations_p13_strategy_versions_v1(id,endpoint,version,configuration,created_by,created_at) VALUES($1,$2,1,$3,$4,$5)',[versionId,endpoint,JSON.stringify(configuration),operator.operatorId,new Date(at*1000)]);
  await db.query('INSERT INTO operations_p13_strategy_heads_v1(endpoint,revision,active_id,paused,updated_at) VALUES($1,1,$2,false,$3)',[endpoint,versionId,new Date(at*1000)]);
  const codeCfg={...cfg,configuration:{...cfg.configuration,mode:'code',plan:{...cfg.configuration.plan,strategyIds:[strategyId],resourceIds:[targetId]}}};
  const task=await transaction(db,tx=>autonomy.createTaskWithin(tx,codeCfg,{key:'code-rule'}));
  authority.content={async rawWithin(){return{head:{},source:{}};},async publicSourceWithin(){return{available:true,payload:{attachments:[]}};}};
  autonomy.queryTools={async execute(){return{availability:'available',data:{body:'短文',links:[]}};}};
  let models=0;autonomy.native={async run(){models++;throw Error('No model allowed for code');}};
  await worker.execute({taskId:task.id});const actual=await autonomy.taskWithin(db,task.id);assert.equal(models,0);assert.equal(actual.state,'completed',actual.code);assert.equal(actual.model_state,'not-required');assert.equal(actual.business_state,'no-action');assert.equal(actual.effective_check,true);
  assert.equal((await db.query('SELECT state FROM operations_autonomy_receipts_v1 WHERE task_id=$1',[task.id])).rows[0].state,'no-action');
 });
 await t.test('workbench projection never creates old history and a model end cannot close an unresolved human card',async()=>{
  const oldId=randomUUID();assert.equal(await autonomy.updateWorkbenchWithin(db,{operationId:oldId,modelState:'completed',status:'completed'}),null);
  const turnId=randomUUID();await transaction(db,tx=>autonomy.linkWorkbenchWithin(tx,{operationId:turnId,domain:'overview',aiAccountId:ids.get('overview'),conversationId:randomUUID(),sessionId:randomUUID(),operatorId:operator.operatorId}));
  await transaction(db,tx=>autonomy.updateWorkbenchWithin(tx,{operationId:turnId,status:'waiting-human'}));
  await transaction(db,tx=>autonomy.updateWorkbenchWithin(tx,{operationId:turnId,modelState:'completed',status:'completed',usage:{calls:2,inputTokens:4,outputTokens:3,totalTokens:7,durationMs:900}}));
  assert.equal((await autonomy.taskWithin(db,turnId)).state,'waiting-human');assert.equal((await autonomy.taskWithin(db,turnId)).mode,'human-ai');
  await assert.rejects(autonomy.authorize({taskId:turnId,operation:'run'}),{code:'operations_autonomy_task_inactive'});
  const nextTurn=randomUUID(),binding=(await autonomy.taskWithin(db,turnId)).configuration.externalWorkbench;await transaction(db,tx=>autonomy.bindWorkbenchTaskWithin(tx,{taskId:turnId,turnOperationId:nextTurn,operatorId:operator.operatorId,domain:'overview',aiAccountId:ids.get('overview'),conversationId:binding.conversationId,sessionId:binding.sessionId}));
  await transaction(db,tx=>autonomy.updateWorkbenchWithin(tx,{operationId:turnId,turnOperationId:nextTurn,nativeRunId:'workbench-second-run',modelState:'running',status:'running',usage:{calls:1,inputTokens:2,outputTokens:1,totalTokens:3,durationMs:300}}));
  assert.equal((await autonomy.taskWithin(db,turnId)).model_usage.totalTokens,10);
  await transaction(db,tx=>autonomy.updateWorkbenchWithin(tx,{operationId:turnId,turnOperationId:nextTurn,nativeRunId:'workbench-second-run',usage:{calls:1,inputTokens:2,outputTokens:1,totalTokens:3,durationMs:300}}));
  assert.equal((await autonomy.taskWithin(db,turnId)).model_usage.totalTokens,10);
  const usage=(await autonomy.overview(operator)).usage;assert.equal(usage.totals.totalTokens,null);assert.ok(usage.unknownTasks>0);assert.ok(usage.observedSubtotal.totalTokens>=10);
 });
 await t.test('human decisions resume only the same paused run once and task tool rights are projected from current roles',async()=>{
  await permissions.saveRole(operator,{operationId:randomUUID(),id:role.id,expectedVersion:role.version,name:role.name,description:'明确动作的测试岗位',enabled:true,permissions:['content.read','analytics.read','content.restore']},{authorize});
  const cfg=await autonomy.configWithin(db,'governance'),task=await transaction(db,tx=>autonomy.createTaskWithin(tx,{...cfg,configuration:{...cfg.configuration,mode:'ai',plan:{...cfg.configuration.plan,actions:['content.restore']}}},{key:'human-continuation'}));
  let continued=0;autonomy.native={async run(){return{nativeRunId:'paused-original-run',status:'RUNNING',modelState:'running'};},async read(){return{nativeRunId:'paused-original-run',status:'PAUSED',modelState:'running',continuable:true};},async continue(value){assert.equal(value.id,task.id);continued++;return{nativeRunId:'paused-original-run',status:'PENDING',modelState:'accepted'};},async cancel(){return{};}};
  autonomy.actionTools={dutyActionReady:code=>code==='content.restore'};autonomy.dutyTools=async({operationId})=>({operationId,state:'waiting-human',reason:'operations_agentos_human_review_required'});
  await worker.execute({taskId:task.id});const authorized=await autonomy.authorize({taskId:task.id,operation:'tool'});assert.ok(authorized.task.tools.includes('execute-operation'));assert.ok(!authorized.task.tools.includes('manage-ai-role'));
  const callId=randomUUID();await autonomy.tool({taskId:task.id,callId,nativeRunId:'paused-original-run',tool:'execute-operation',arguments:{kind:'content-visibility'}});
  await worker.reconcile(await autonomy.taskWithin(db,task.id));let current=await autonomy.taskWithin(db,task.id);
  await assert.rejects(autonomy.control(operator,task.id,{operationId:randomUUID(),expectedRevision:current.revision,kind:'resume'},{authorize}),{code:'operations_autonomy_original_run_not_resumable'});
  const decisionInput={operationId:randomUUID(),expectedRevision:current.revision,callId,decision:'rejected'},decision=await autonomy.decide(operator,task.id,decisionInput,{authorize});
  assert.equal(decision.task.continuation.allowed,true);assert.ok(decision.task.availableControls.includes('resume'));assert.equal((await autonomy.operation(operator,decisionInput.operationId)).kind,'decision');
  assert.equal((await autonomy.decide(operator,task.id,decisionInput,{authorize})).replayed,true);
  current=await autonomy.taskWithin(db,task.id);const resumeInput={operationId:randomUUID(),expectedRevision:current.revision,kind:'resume'};await autonomy.control(operator,task.id,resumeInput,{authorize});await autonomy.control(operator,task.id,resumeInput,{authorize});assert.equal(continued,1);
  current=await autonomy.taskWithin(db,task.id);await autonomy.control(operator,task.id,{operationId:randomUUID(),expectedRevision:current.revision,kind:'stop'},{authorize});
  await assert.rejects(queue.jobs.cancel('autonomy-task',randomUUID()),{code:'operations_autonomy_task_control_required'});
  await assert.rejects(queue.jobs.retry('autonomy-task',randomUUID()),{code:'operations_autonomy_task_control_required'});
 });
 await t.test('object context finds real receipt associations and denies inaccessible receipt sources',async()=>{
  const targetId=randomUUID(),receiptId=randomUUID();await transaction(db,tx=>autonomy.recordBusinessReceiptWithin(tx,{taskId:original.id,operationId:receiptId,action:'content.restore',targetType:'content-post',targetId,state:'completed',basis:'persisted-domain-operation-receipt'}));
  autonomy.queryTools={async execute(){return{availability:'available'};}};const found=await autonomy.tasks(operator,{targetType:'content-post',targetId});assert.ok(found.items.some(item=>item.id===original.id));
  await transaction(db,tx=>autonomy.recordBusinessReceiptWithin(tx,{taskId:original.id,operationId:receiptId,action:'content.restore',targetType:'content-post',targetId,state:'unknown',basis:'original-operation-query'}));
  assert.equal((await db.query('SELECT state FROM operations_autonomy_receipts_v1 WHERE task_id=$1 AND operation_id=$2',[original.id,receiptId])).rows[0].state,'completed');
  autonomy.queryTools={async execute(){throw Object.assign(Error(),{status:403,code:'operations_permission_denied'});}};const denied=await autonomy.tasks(operator,{targetType:'content-post',targetId});assert.deepEqual(denied.items,[]);assert.equal(denied.total,null);
  let humanReads=0;autonomy.queryTools={async read(viewer){assert.equal(viewer.kind,'business-operator');humanReads++;return{availability:'available'};},async execute(){throw Error('Human task viewers must not use the task AI intersection');}};
  await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=false WHERE ai_account_id=$1',[ids.get('governance')]);assert.ok((await autonomy.tasks(operator,{targetType:'content-post',targetId})).items.some(item=>item.id===original.id));assert.ok(humanReads>0);
  await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=true WHERE ai_account_id=$1',[ids.get('governance')]);
 });
 await t.test('independent API metadata collection detects a stopped scheduler without any model call',async()=>{
  const values=new Map(),gauge=(name)=>({set(value){values.set(name,value);},remove(){values.delete(name);}}),refresh=createAutonomyMetrics({db,gauge,now:()=>at*1000});
  at+=300;await db.query('SET ROLE galaxy_api');await refresh();await db.query('RESET ROLE');assert.equal(values.get('autonomy_collection_success'),1);assert.ok(values.get('autonomy_enabled_accounts')>0);assert.ok(values.get('autonomy_worker_tick_age_seconds')>values.get('autonomy_worker_tick_limit_seconds'));
 });
 await t.test('internal HTTP authenticates exact private paths and browser paths require current capability',async()=>{
  let verified=0,authorized=0,payload;
  await dispatchOperationsAutonomy({operationsAutonomy:{async authorize(input){return{allowed:true,taskId:input.taskId};}},agentOsGateway:{verifyService(){verified++;}},request:{method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({taskId:original.id,operation:'read'}));}},response:{setHeader(){}},url:new URL(endpoint+'/v1/internal/agentos/autonomy/authorize'),send:(s,value)=>{assert.equal(s,200);payload=value;}});
  assert.equal(verified,1);assert.equal(payload.allowed,true);
  await dispatchOperationsAutonomy({operationsAutonomy:autonomy,authorizeOperator:async(req,options)=>{authorized++;assert.equal(options.action,'autonomy.read');return operator;},request:{method:'GET'},response:{setHeader(){}},url:new URL(endpoint+'/v1/operations/autonomy/tasks?page=1&limit=10'),send:(s,value)=>{assert.equal(s,200);assert.ok(value.items.length>0);}});assert.equal(authorized,1);
 });
});
