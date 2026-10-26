import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,transaction} from '../src/database.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsAiWorkAccountsService} from '../src/operations/accounts/ai-work-service.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';
import {createOperationsAgentOsDutyTools} from '../src/operations-agentos-duty-tools.mjs';
import {OperationsAutonomy} from '../src/operations-autonomy.mjs';
import {OperationsMessagingService} from '../src/operations-messaging.mjs';
import {P13StrategiesService} from '../src/operations/strategies/service.mjs';
import {p13EmptyConfiguration} from '../src/shared/p13-strategies-schema.mjs';
import {aiActionDefinition,aiActionProjection} from '../src/shared/operations-ai-action-registry.mjs';

// Real PostgreSQL engine, complete current migrations, galaxy_api grants,
// current business permissions, AI authority, task ledger, strategy and message
// commands. Only the queue, native status/cancel and unused mail transport are
// explicit local doubles. No model, delivery worker or external service runs.
test('ordinary verified messaging connects through the real duty tool and original receipt chain',{timeout:120000},async t=>{
 const db=new PGlite();t.after(()=>db.close());assert.equal(await migrate(db,{roles:['api']}),131);
 const now=()=>2000000000,endpoint='https://messaging-duty.synthetic.invalid',at=new Date(now()*1000),admin={kind:'business-operator',operatorId:'messaging-duty-owner',role:'administrator',endpoint},auth={authorize:async()=>admin};
 await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.synthetic.invalid',$1,'消息值守合成管理员',$3,$3)",[admin.operatorId,endpoint,at]);
 const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async actor=>actor.operatorId===admin.operatorId?'administrator':null,now}),
  businessAdmin=new BusinessAdminService({db,endpoint,permissions,now}),accounts=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,now}),aiId=randomUUID(),domain='messaging';permissions.aiWorkAccounts=accounts;
 await db.query("INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,$3,'合成消息岗位','',true,1,1,$4,$4)",[aiId,endpoint,domain,at]);
 const codes=['notices.read','notices.create','notices.update','notices.publish','notices.withdraw'],role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'明确消息用途',description:'仅本地行为验证',enabled:true,permissions:codes},auth)).role;
 let assignment=(await accounts.assignment(admin,domain,{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},auth)).result.assignment;
 const authority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts:accounts,now});businessAdmin.executorAuthority=authority;
 const queued=[],mailCalls=[],jobs={onCancel(){},enqueue:async(name,data,options={})=>{const id=randomUUID();queued.push({id,name,data,options});return id;},schedule:async()=>{throw Error('No recurring job expected');},unschedule:async()=>{throw Error('No recurring job expected');}},
  messaging=new OperationsMessagingService({db,endpoint,businessAdmin,jobs,mailProvider:{status:async()=>({state:'configured',enabled:true,configVersion:'synthetic',receipts:'not-connected'}),submit:async()=>{mailCalls.push(true);throw Error('No SMTP invocation is allowed');}},now}),
  actions=new OperationsAgentOsActionTools({authority,services:{messaging},now}),
  autonomy=new OperationsAutonomy({db,endpoint,businessAdmin,authority,aiWorkAccounts:accounts,actionTools:actions,client:{status:async()=>({state:'connected',modelState:'configured',configuredDomains:[domain]})},now});
 messaging.autonomy=autonomy;authority.durableOperationAuthorizationWithin=(tx,context)=>messaging.validatePersistedApprovalWithin(tx,context);
 autonomy.dutyTools=createOperationsAgentOsDutyTools({authority,actions,permissions,authorizeOperation:autonomy.authorizeOperationWithin.bind(autonomy)});
 const grantInput={expectedVersion:0,name:'已批准普通消息',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId:aiId,permissions:codes,resourceIds:[],resourceScope:{kind:'eligible'}};
 let grant=(await permissions.saveAutomation(admin,{...grantInput,operationId:randomUUID()},auth)).automation;
 const strategies=new P13StrategiesService({db,endpoint,businessAdmin,authority,effects:{},native:{status:async()=>({state:'unavailable'})},now}),strategyId=randomUUID(),configuration=structuredClone(p13EmptyConfiguration);strategies.autonomy=autonomy;
 configuration.common={objective:'普通且事实已核实的既有消息用途',automationEnabled:true};Object.assign(configuration.domains.find(item=>item.key===domain),{objective:'保持既有计划内容、受众及渠道',executionEnabled:true});
 configuration.strategies=[{id:strategyId,name:'普通消息状态处理',domain,objective:'仅处理当前合格计划，人工决定优先',enabled:true,mode:'ai-autonomous',template:'business-action',judgment:'prepared-command',instructions:null,condition:null,ordinaryBounds:null,recovery:{versionId:null,conditions:[]},execution:{aiDomain:domain,trigger:{kind:'manual',eventTypes:[]},mode:'ai',grantIds:[grant.id],resourceScope:{kind:'eligible'},requiredRehearsal:false,actions:codes.filter(code=>code!=='notices.read')}}];
 const draft=await strategies.saveDraft(admin,{operationId:randomUUID(),expectedRevision:(await strategies.head(db)).revision,configuration,reason:'明确普通消息的本地合成批准'},auth),preview=await strategies.rehearsal(admin,{operationId:randomUUID(),versionId:draft.versionId,executionIds:[]});assert.equal(preview.valid,true,JSON.stringify(preview));
 await strategies.publish(admin,{operationId:randomUUID(),expectedRevision:draft.revision,versionId:draft.versionId,rehearsalId:preview.rehearsalId,reason:'当前真实消费者预演通过'},auth);
 const current=(await autonomy.getConfig(admin,domain)).config;
 await autonomy.saveConfig(admin,domain,{operationId:randomUUID(),expectedRevision:current.revision,enabled:true,mode:'ai',schedule:current.schedule,purpose:current.purpose,goal:'仅已核实普通消息状态',prompt:'只使用当前工具和原操作回执',plan:{strategyIds:[strategyId],grantIds:[grant.id],actions:codes.filter(code=>code!=='notices.read'),resourceIds:[],eventTypes:[]}},auth);
 await db.query('SET ROLE galaxy_api');
 const config=(changes={})=>({channels:['announcement','inapp','email'],content:{purpose:'service-update',title:'本地合成已核实消息',body:'此消息只用于隔离行为测试。',href:'/guide/',expiresAt:new Date((now()+3600)*1000).toISOString()},audience:{kind:'all-accounts'},senderKey:'notice',automation:{kind:'ordinary',factsConfirmed:true},schedule:{kind:'immediate'},...changes}),
  create=async changes=>(await messaging.create(admin,{operationId:randomUUID(),config:config(changes)},auth)).plan,
  newTask=async()=>{const cfg=await autonomy.configWithin(db,domain),task=await transaction(db,tx=>autonomy.createTaskWithin(tx,cfg,{key:'synthetic:'+randomUUID()})),nativeRunId='synthetic_'+task.id;await db.query("UPDATE operations_autonomy_tasks_v1 SET state='running',model_state='running',native_run_id=$3,lease_until=$4 WHERE endpoint=$1 AND id=$2",[endpoint,task.id,nativeRunId,new Date((now()+600)*1000)]);return{taskId:task.id,nativeRunId};},
  call=async(task,args,callId=randomUUID())=>autonomy.tool({...task,callId,tool:'execute-operation',arguments:args}),
  messageCommand=async id=>(await db.query('SELECT * FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[endpoint,id])).rows[0],
  counts=async()=>({commands:Number((await db.query('SELECT count(*) AS n FROM operations_messaging_commands_v1')).rows[0].n),events:Number((await db.query('SELECT count(*) AS n FROM operations_messaging_events_v1')).rows[0].n),queued:queued.length}),
  saveGrant=async enabled=>{grant=(await permissions.saveAutomation(admin,{...grantInput,id:grant.id,expectedVersion:grant.version,enabled,operationId:randomUUID()},auth)).automation;},
  assign=async enabled=>{assignment=(await accounts.assignment(admin,domain,{id:assignment.id,operationId:randomUUID(),expectedVersion:assignment.version,roleId:role.id,enabled},auth)).result.assignment;};
 const phases={prepare:0,qualify:0,execute:0,recover:0};for(const[name,method]of Object.entries({prepare:'prepareFor',qualify:'qualifyDutyTargetWithin',execute:'executePrepared',recover:'recoverPrepared'})){const original=actions[method].bind(actions);actions[method]=async(...args)=>{phases[name]++;return original(...args);};}

 await t.test('discovery and actual injected services advertise only the connected ordinary handlers',async()=>{
  for(const code of ['notices.publish','notices.withdraw']){assert.equal(aiActionDefinition(code).handlerImplemented,true);assert.equal(actions.dutyActionReady(code),true);assert.equal(aiActionProjection(code,{permissions:codes,services:{messaging}}).ready,true);}
  const unavailable=new OperationsAgentOsActionTools({authority,services:{messaging:{get:messaging.get.bind(messaging)}}});assert.equal(unavailable.dutyActionReady('notices.publish'),false);authority.dutyActionReady=code=>actions.dutyActionReady(code);
  for(const code of ['jobs.retry','jobs.cancel','search.retry']){assert.equal(aiActionDefinition(code).handlerImplemented,false);assert.equal(actions.dutyActionReady(code),false);}
  const task=await newTask(),authorized=await autonomy.authorize({taskId:task.taskId,operation:'tool'});assert.ok(authorized.task.tools.includes('execute-operation'));
 });
 await t.test('verified ordinary plans publish and withdraw through prepare, live qualification, business SQL and immutable recovery',async()=>{
  const plan=await create(),task=await newTask(),callId=randomUUID(),input={kind:'messaging-state',targetId:plan.id,action:'activate'},before=await counts(),result=await call(task,input,callId);
  assert.equal(result.effectState,'completed');assert.equal(result.basis,'persisted-domain-operation-receipt');assert.equal(result.businessReceipt.targetType,'messaging-plan');assert.equal(result.businessReceipt.targetId,plan.id);
  const stored=await messageCommand(result.operationId);assert.equal(stored.kind,'activate');assert.equal(stored.input.expectedVersion,1);assert.equal(stored.input.expectedRevision,1);assert.equal(stored.result.plan.state,'active');
  const row=await messaging.planWithin(db,plan.id);assert.equal(row.approved_by,'ai:'+aiId);assert.equal(row.approved_role,null);assert.equal(row.approved_ai.taskId,task.taskId);assert.equal(row.approved_ai.operation.operationId,result.operationId);assert.equal(row.approved_ai.operation.grantId,grant.id);assert.equal(row.approved_ai.operation.strategyVersionId,draft.versionId);
  assert.equal(queued.length,before.queued+1);assert.equal(queued.at(-1).name,'messaging-run');assert.deepEqual(queued.at(-1).data,{planId:plan.id,planVersion:1});assert.equal(mailCalls.length,0);
  const frozen=await counts(),original=await call(task,input,callId);assert.equal(original.operationId,result.operationId);assert.equal(original.receipt.replayed,false);assert.deepEqual(await counts(),frozen,'Reconciliation only reads the exact committed command');
  const withdrawn=await call(task,{kind:'messaging-state',targetId:plan.id,action:'withdraw'});assert.equal(withdrawn.effectState,'completed');assert.equal((await messaging.planWithin(db,plan.id)).state,'stopped');assert.equal((await messageCommand(withdrawn.operationId)).result.effects.alreadySubmittedEmailRetracted,false);
  assert.ok(Object.values(phases).every(value=>value>0),JSON.stringify(phases));
  const audit=(await db.query('SELECT actor_kind,operator_role,operator_id,grant_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[endpoint,result.operationId])).rows[0];assert.deepEqual(audit,{actor_kind:'operations-ai-service',operator_role:null,operator_id:'ai:'+aiId,grant_id:grant.id});
 });
 await t.test('AI-created unverified drafts and human-required important plans cannot publish',async()=>{
  const task=await newTask(),{automation:_automation,...draftConfig}=config(),created=await call(task,{kind:'message-draft-create',config:draftConfig});assert.equal(created.effectState,'completed');
  const aiDraft=await messaging.planWithin(db,created.receipt.planId);assert.equal(aiDraft.created_by,'ai:'+aiId);assert.deepEqual(aiDraft.config.automation,{kind:'human-required',factsConfirmed:false});
  for(const plan of [aiDraft,await create({automation:{kind:'human-required',factsConfirmed:true}}),await create({automation:undefined})]){
   const candidate=await newTask(),before=await counts(),result=await call(candidate,{kind:'messaging-state',targetId:plan.id,action:'activate'});assert.equal(result.state,'waiting-human');assert.equal(result.businessReceipt,undefined);assert.equal((await messaging.planWithin(db,plan.id)).state,'draft');assert.deepEqual(await counts(),before);
  }
  const candidate=await newTask();await assert.rejects(call(candidate,{kind:'messaging-state',targetId:aiDraft.id,action:'activate',automation:{kind:'ordinary',factsConfirmed:true}}),{code:'invalid_operations_agentos_action'});assert.equal(mailCalls.length,0);
 });
 await t.test('a later human publication decision prevents an autonomous withdrawal',async()=>{
  const plan=await create();await messaging.action(admin,plan.id,'activate',{operationId:randomUUID(),expectedVersion:1,expectedRevision:1},auth);
  const task=await newTask(),before=await counts(),result=await call(task,{kind:'messaging-state',targetId:plan.id,action:'withdraw'});assert.equal(result.state,'waiting-human');assert.equal((await messaging.planWithin(db,plan.id)).state,'active');assert.deepEqual(await counts(),before);
 });
 await t.test('current AI role revocation rejects a previously prepared intent before the effect',async()=>{
  const plan=await create(),task=await newTask(),original=actions.prepareFor.bind(actions);let changed=false;
  actions.prepareFor=async(...args)=>{const proposal=await original(...args);if(!changed){changed=true;await assign(false);}return proposal;};
  try{const before=await counts();await assert.rejects(call(task,{kind:'messaging-state',targetId:plan.id,action:'activate'}),{code:'operations_permission_denied'});assert.equal((await messaging.planWithin(db,plan.id)).state,'draft');assert.deepEqual(await counts(),before);}finally{actions.prepareFor=original;await assign(true);}
 });
 await t.test('current grant revocation after preparation is checked by the real task authorizer',async()=>{
  const plan=await create(),task=await newTask(),original=actions.prepareFor.bind(actions);let changed=false;
  actions.prepareFor=async(...args)=>{const proposal=await original(...args);if(!changed){changed=true;await saveGrant(false);}return proposal;};
  try{const before=await counts();await assert.rejects(call(task,{kind:'messaging-state',targetId:plan.id,action:'activate'}),{code:'operations_autonomy_authorization_changed'});assert.equal((await messaging.planWithin(db,plan.id)).state,'draft');assert.deepEqual(await counts(),before);}finally{actions.prepareFor=original;await saveGrant(true);}
 });
 await t.test('a current plan CAS change rejects the frozen command and reconciliation does not re-prepare it',async()=>{
  const plan=await create(),task=await newTask(),original=actions.prepareFor.bind(actions),callId=randomUUID(),input={kind:'messaging-state',targetId:plan.id,action:'activate'};let changed=false;
  actions.prepareFor=async(...args)=>{const proposal=await original(...args);if(!changed){changed=true;await messaging.save(admin,plan.id,{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,config:config({content:{...plan.config.content,title:'人工保存的第二版'}})},auth);}return proposal;};
  try{await assert.rejects(call(task,input,callId),{code:'operations_messaging_version_changed'});}finally{actions.prepareFor=original;}
  const before=await counts(),prepares=phases.prepare,result=await call(task,input,callId);assert.equal(result.effectState,'unknown');assert.equal(result.basis,'original-operation-query');assert.equal(phases.prepare,prepares);assert.deepEqual(await counts(),before);assert.equal((await messaging.planWithin(db,plan.id)).version,2);assert.equal((await messaging.planWithin(db,plan.id)).state,'draft');
 });
 await t.test('a committed publication with a lost ACK recovers its original command without another publish or queue item',async()=>{
  const plan=await create(),task=await newTask(),callId=randomUUID(),input={kind:'messaging-state',targetId:plan.id,action:'activate'},original=messaging.action.bind(messaging);let publishes=0;
  messaging.action=async(...args)=>{publishes++;await original(...args);throw Object.assign(Error('synthetic lost ACK'),{code:'synthetic_ack_lost'});};
  try{await assert.rejects(call(task,input,callId),{code:'synthetic_ack_lost'});}finally{messaging.action=original;}
  const ledger=(await db.query('SELECT operation_id,state FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3',[endpoint,task.taskId,callId])).rows[0];assert.equal(ledger.state,'unknown');assert.equal((await messaging.planWithin(db,plan.id)).state,'active');
  const before=await counts(),prepares=phases.prepare,result=await call(task,input,callId);assert.equal(result.operationId,ledger.operation_id);assert.equal(result.effectState,'completed');assert.equal(result.basis,'persisted-domain-operation-receipt');assert.equal(publishes,1);assert.equal(phases.prepare,prepares);assert.deepEqual(await counts(),before);assert.equal(mailCalls.length,0);
 });
 await t.test('an absent original receipt remains unknown and never reissues a possibly dispatched publication',async()=>{
  const plan=await create(),task=await newTask(),callId=randomUUID(),input={kind:'messaging-state',targetId:plan.id,action:'activate'},original=messaging.action.bind(messaging);let publishes=0;
  messaging.action=async()=>{publishes++;throw Object.assign(Error('synthetic ambiguous dispatch'),{code:'synthetic_dispatch_unknown'});};
  try{await assert.rejects(call(task,input,callId),{code:'synthetic_dispatch_unknown'});}finally{messaging.action=original;}
  const before=await counts(),prepares=phases.prepare,result=await call(task,input,callId);assert.equal(result.effectState,'unknown');assert.equal(result.basis,'original-operation-query');assert.equal(publishes,1);assert.equal(phases.prepare,prepares);assert.deepEqual(await counts(),before);assert.equal((await messaging.planWithin(db,plan.id)).state,'draft');assert.equal(mailCalls.length,0);
 });
 await db.query('RESET ROLE');
});
