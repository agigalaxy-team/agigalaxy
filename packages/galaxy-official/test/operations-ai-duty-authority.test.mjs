import {OperationsJobActions} from '../src/operations-job-actions.mjs';
import {queueFixture} from './operations-jobs-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {migrate,transaction} from '../src/database.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsAiWorkAccountsService} from '../src/operations/accounts/ai-work-service.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';
import {OperationsFeedbackService} from '../src/operations-feedback.mjs';
import {aiWorkCapabilities} from '../src/shared/operations-ai-work-capabilities.mjs';
import {aiActionProjection} from '../src/shared/operations-ai-action-registry.mjs';
import {P13OrdinaryStrategies} from '../src/operations/strategies/ordinary.mjs';
import {P13StrategiesService} from '../src/operations/strategies/service.mjs';
import {p13EmptyConfiguration} from '../src/shared/p13-strategies-schema.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {OperationsAgentOsQueryTools} from '../src/operations-agentos-query-tools.mjs';
import {OperationsMessagingService} from '../src/operations-messaging.mjs';

// Current migrations, the real galaxy_api role, business roles, delegation,
// immutable feedback receipts and permission reloads run against real PG.
// Upstream management eligibility and task/strategy eligibility are explicit
// local boundaries. No native model, provider or production state is used.
test('stable duty identities, AI-only delegation and original automatic receipts enforce current authority',{timeout:90000},async t=>{
 const f=await accountChatFixture();t.after(f.close);await migrate(f.db,{roles:['api']});
 const admin={kind:'business-operator',operatorId:'duty-admin',role:'administrator',endpoint:f.endpoint},person={...admin,operatorId:'duty-person',role:'reader'},adminAuth={authorize:async()=>admin};
 for(const actor of [admin,person])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.invalid',$1,'合成值守身份',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>actor.operatorId===admin.operatorId?'administrator':actor.operatorId===person.operatorId?'reader':null,now:f.now}),
  businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now}),accounts=new OperationsAiWorkAccountsService({db:f.db,endpoint:f.endpoint,businessAdmin,now:f.now});permissions.aiWorkAccounts=accounts;
 const ai={},plans=new Map();
 for(const domain of ['overview','governance','messaging','discovery','maintenance']){
  ai[domain]=randomUUID();await f.db.query('INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,$3,$4,\'\',true,1,1,$5,$5)',[ai[domain],f.endpoint,domain,'合成岗位 '+domain,new Date(f.now()*1000)]);
  const plan={domain,aiAccountId:ai[domain],taskId:randomUUID(),purpose:'operations-'+domain,planId:randomUUID(),planVersion:1,enabled:true};plans.set(domain,plan);
  await f.db.query("INSERT INTO operations_autonomy_tasks_v1(id,endpoint,ai_account_id,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,$3,$4,'routine',$5,'明确的本地资格夹具','ai','running','running','not-started','{}',1,1,$6,$7,$7,$7)",[plan.taskId,f.endpoint,ai[domain],domain,'synthetic:'+domain,randomUUID(),new Date(f.now()*1000)]);
 }
 const dutyAuthorizationWithin=async(_db,context)=>{const plan=plans.get(context.domain);return{allowed:!!plan?.enabled&&['aiAccountId','taskId','purpose','planId','planVersion'].every(key=>plan[key]===context[key])};},
  authority=new OperationsAgentOsAuthority({db:f.db,endpoint:f.endpoint,permissions,aiWorkAccounts:accounts,dutyAuthorizationWithin,now:f.now});businessAdmin.executorAuthority=authority;
 const mint=domain=>transaction(f.db,db=>authority.dutyActorWithin(db,plans.get(domain))),roleInput=(name,codes)=>({operationId:randomUUID(),expectedVersion:0,name,description:'显式受限合成角色',enabled:true,permissions:codes}),
  role=(await permissions.saveRole(admin,roleInput('总控受限角色维护',['ai.roles.read','ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke']),adminAuth)).role;
 await accounts.assignment(admin,'overview',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},adminAuth);
 await f.db.exec('SET ROLE galaxy_api');

 await t.test('the current role decides capabilities across all five domains and a serialized actor has no credential',async()=>{
  const codes=['feedback.read','feedback.update','jobs.retry'];
  for(const domain of plans.keys())assert.deepEqual(aiWorkCapabilities(domain,codes),aiWorkCapabilities('overview',codes));
  const empty=await mint('governance');assert.deepEqual(empty.businessAuthorization.permissions,[]);assert.equal(empty.role,null);
  await assert.rejects(authority.requireDutyAction({...empty},'feedback.read'),{code:'business_admin_denied'});
  await assert.rejects(authority.requireDutyAction(empty,'feedback.read'),{code:'operations_permission_denied'});
  plans.get('governance').enabled=false;await assert.rejects(authority.requireDutyAction(empty,'workbench.read'),{code:'operations_ai_duty_inactive'});plans.get('governance').enabled=true;
  assert.deepEqual(aiActionProjection('jobs.retry',{permissions:codes,handlerReady:false}),{permission:'jobs.retry',permissionAllowed:true,humanRequired:false,humanConditions:[],conditions:['ordinary','bounded-retry'],handlerReady:false,ready:false,reasons:['handler-not-connected']});
 });

 await t.test('job duty uses the stable AI, exact grant target and immutable original receipt without a second cancel',async()=>{
  const role=(await permissions.saveRole(admin,roleInput('合成精确任务取消',['jobs.read','jobs.cancel']),adminAuth)).role;
  await accounts.assignment(admin,'governance',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},adminAuth);
  const queue=queueFixture(f.db);await queue.jobs.start();
  try{
   const targetId=await queue.jobs.enqueue('information-watch',{watchId:randomUUID()},{key:'explicit-duty-job'}),actor=await mint('governance'),
    grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'仅取消准确队列任务',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId:ai.governance,permissions:['jobs.cancel'],resourceIds:[targetId],resourceScope:{kind:'selected',resourceIds:[targetId]}},adminAuth)).automation,
    authorizeOperation=async(_db,operation)=>({allowed:operation.targetId===targetId,grantId:grant.id,grantVersion:grant.version,strategyId:grant.id,strategyVersionId:grant.id}),
    service=new OperationsJobActions({db:f.db,endpoint:f.endpoint,businessAdmin,jobs:queue.jobs}),tools=new OperationsAgentOsActionTools({authority,services:{jobActions:service},now:f.now}),
    request={kind:'job-cancel',queue:'information-watch',targetId,reason:'合成已获准取消任务'},operationId=randomUUID();
   const result=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation});assert.equal(result.effectState,'completed');assert.equal(result.receipt.state,'cancelled');
   const audit=(await f.db.query('SELECT actor_kind,operator_id FROM business_admin_audit_v1 WHERE operation_id=$1',[operationId])).rows[0];assert.deepEqual(audit,{actor_kind:'operations-ai-service',operator_id:'ai:'+ai.governance});
   queue.jobs.cancel=()=>{throw Error('reconciliation must not dispatch again');};
   assert.equal((await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation,reconcile:true})).effectState,'completed');
   await assert.rejects(tools.executeDutyOperation({actor,operationId,arguments:{...request,reason:'不同提交'},authorizeOperation,reconcile:true}),{code:'operations_agentos_operation_conflict'});
   const foreign=await queue.jobs.enqueue('information-watch',{watchId:randomUUID()},{key:'outside-duty-grant'});
   await assert.rejects(tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{...request,targetId:foreign},authorizeOperation}),{code:'operations_ai_duty_operation_denied'});
  }finally{await queue.jobs.stop();}
 });

 const targetPermissions=['feedback.read','feedback.update','jobs.retry','accounts.read','accounts.restriction.apply','accounts.restriction.release','strategies.read','strategies.ordinary.configure','strategies.ordinary.publish','content.read','content.batch.hide','content.batch.restore','chat-reports.read','chat-reports.materials.read','chat-messages.hide','chat-messages.restore','chat-messages.keep','notices.read','notices.create','notices.update','notices.publish','notices.withdraw'];
 let delegated,assignment,supervisor;
 await t.test('the supervisor can manage only human-delegated other AI targets and AI-only roles',async()=>{
  const config={operationId:randomUUID(),expectedVersion:0,enabled:true,targetAiAccountIds:[ai.maintenance],grantablePermissions:targetPermissions,allowedManagementActions:['read','create','update','assign','revoke']},saved=await permissions.saveDelegation(admin,config,adminAuth);
  assert.equal((await permissions.saveDelegation(admin,config,adminAuth)).replayed,true);assert.equal((await permissions.delegationOperation(admin,config.operationId)).state,'recorded');
  plans.get('overview').delegationVersion=saved.delegation.version;supervisor=await mint('overview');
  assert.equal((await permissions.delegatedDirectory(supervisor)).roles.length,0);
  delegated=(await permissions.delegatedRoleSave(supervisor,{kind:'role-create',...roleInput('受限跨领域反馈',targetPermissions),targetAiAccountIds:[ai.maintenance]})).role;
  assert.equal(delegated.subjectScope,'ai-only');assert.equal(delegated.createdByAiAccountId,ai.overview);
  await assert.rejects(permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:person.operatorId,roleId:delegated.id,enabled:true},adminAuth),{code:'operations_ai_role_human_assignment_denied'});
  await assert.rejects(permissions.delegatedRoleSave(supervisor,{kind:'role-update',...roleInput('不能修改共享角色',[]),id:role.id,expectedVersion:role.version,targetAiAccountIds:[ai.maintenance]}),{code:'operations_ai_delegation_role_denied'});
  await assert.rejects(permissions.delegatedRoleSave(supervisor,{kind:'role-create',...roleInput('不能越过上限',['files.scan.retry']),targetAiAccountIds:[ai.maintenance]}),{code:'operations_ai_delegation_ceiling_denied'});
  await assert.rejects(permissions.delegatedRoleSave(supervisor,{kind:'role-create',...roleInput('不能间接给自己赋权',['feedback.read']),targetAiAccountIds:[ai.overview]}),{code:'operations_ai_delegation_ceiling_denied'});
  assignment=(await permissions.delegatedAssignment(supervisor,{kind:'assignment-save',operationId:randomUUID(),expectedVersion:0,aiAccountId:ai.maintenance,roleId:delegated.id,enabled:true})).assignment;
  const directory=await permissions.delegatedDirectory(supervisor);assert.equal(directory.roles[0].usage.aiAssignments,1);assert.equal(directory.roles[0].impact.affectsPeople,false);
  assert.deepEqual((await transaction(f.db,db=>permissions.delegationAvailabilityWithin(db,{actor:supervisor}))).managementActions,['create','update','assign','revoke']);
  const audit=(await f.db.query("SELECT actor_kind,operator_id,operator_role FROM business_admin_audit_v1 WHERE action='ai-role-create' ORDER BY sequence DESC LIMIT 1")).rows[0];assert.deepEqual(audit,{actor_kind:'operations-ai-service',operator_id:'ai:'+ai.overview,operator_role:null});
 });

 await t.test('public batches require an explicitly bounded impact set and recover original per-object receipts',async()=>{
  const actor=await mint('maintenance'),forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),
   tools=new OperationsAgentOsActionTools({authority,services:{content:community.content},now:f.now}),items=[];
  for(let i=0;i<2;i++){const payload=await bindForumIds('create-post','account:'+f.people[0].accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:f.people[0].accountId,title:'明确批次公开对象 '+i,body:'PUBLIC_SELECTED_BATCH',links:[],topic:'technology',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});await forum.publish(f.people[0],{payloadJson:JSON.stringify(payload)});items.push({kind:'post',id:payload.postId});}
  const ids=items.map(item=>item.id),grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'明确批次影响范围',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId:ai.maintenance,permissions:['content.read','content.batch.hide','content.batch.restore'],resourceIds:ids,resourceScope:{kind:'selected',resourceIds:ids}},adminAuth)).automation,
   strategies=new P13StrategiesService({db:f.db,endpoint:f.endpoint,businessAdmin,authority,effects:{},native:{status:async()=>({state:'unavailable'})},now:f.now}),configuration=structuredClone(p13EmptyConfiguration),strategyId=randomUUID();strategies.autonomy={aiWorkAccounts:accounts,actionTools:tools};
  configuration.common={objective:'人工确认的有限批次',automationEnabled:true};Object.assign(configuration.domains.find(domain=>domain.key==='governance'),{objective:'仅处理明确选定当前对象',executionEnabled:true});configuration.strategies=[{id:strategyId,name:'已批准批次',domain:'governance',objective:'保留每对象结果',enabled:true,mode:'ai-autonomous',template:'business-action',judgment:'prepared-command',instructions:null,condition:null,ordinaryBounds:null,recovery:{versionId:null,conditions:[]},execution:{aiDomain:'maintenance',trigger:{kind:'manual',eventTypes:[]},mode:'ai',grantIds:[grant.id],resourceScope:{kind:'selected',resourceIds:ids},requiredRehearsal:true,actions:['content.batch.hide','content.batch.restore']}}];
  const draft=await strategies.saveDraft(admin,{operationId:randomUUID(),expectedRevision:(await strategies.head(f.db)).revision,configuration,reason:'人工批准这批明确对象'},adminAuth),preview=await strategies.rehearsal(admin,{operationId:randomUUID(),versionId:draft.versionId,executionIds:[]});assert.equal(preview.valid,true);await strategies.publish(admin,{operationId:randomUUID(),expectedRevision:draft.revision,versionId:draft.versionId,rehearsalId:preview.rehearsalId,reason:'当前来源资格预演通过'},adminAuth);
  const authorizeOperation=async(_db,operation)=>({allowed:ids.includes(operation.targetId)&&['content.batch.hide','content.batch.restore'].includes(operation.permission),grantId:grant.id,grantVersion:grant.version,strategyId,strategyVersionId:draft.versionId}),request={kind:'public-content-batch',items,action:'hide',until:f.now()+60,reason:'明确范围内的普通批次'};
  await assert.rejects(tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:request,authorizeOperation}),{code:'operations_agentos_human_review_required'});
  await f.db.query("UPDATE operations_autonomy_tasks_v1 SET configuration=$3 WHERE endpoint=$1 AND id=$2",[f.endpoint,actor.taskId,JSON.stringify({plan:{resourceIds:ids}})]);
  const operationId=randomUUID(),result=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation});assert.equal(result.effectState,'completed');assert.deepEqual(result.receipt.counts,{applied:2,rejected:0});assert.ok(result.receipt.items.every(item=>item.status==='applied'&&item.revision===1));
  assert.equal((await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation,reconcile:true})).effectState,'completed');
  await community.content.visibility(admin,'post',ids[0],{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,kind:'restore',reason:'人工明确恢复首个对象'});
  await assert.rejects(tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{...request,items:[items[0]]},authorizeOperation}),{code:'operations_agentos_human_review_required'});
 });

 await t.test('private case materials and message actions stay within the current task and immutable selected revisions',async()=>{
  const g=new AccountChatGovernanceService({chat:f.chat,businessAdmin}),roomId=await joinAccountConversation(f,f.people[0],f.people[1]),message=await f.chat.send(f.people[1],roomId,{clientMessageId:randomUUID(),text:'PRIVATE_CASE_NECESSARY_SOURCE'}),source=await g.source(f.people[0],{roomId,messageIds:[message.messageId]}),
   makeReport=()=>g.report(f.people[0],{operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'other',summary:'仅本次选材',materials:[{messageId:message.messageId,revision:message.revision,attachmentIds:[]}]}),first=await makeReport(),other=await makeReport();
  await f.db.query("UPDATE operations_autonomy_tasks_v1 SET target_type='chat-report',target_id=$3,configuration='{}' WHERE endpoint=$1 AND id=$2",[f.endpoint,plans.get('maintenance').taskId,first.reportId]);
  const actor=await mint('maintenance'),tools=new OperationsAgentOsActionTools({authority,services:{chatReports:g},now:f.now}),queries=new OperationsAgentOsQueryTools({authority,services:{chatReports:g},now:f.now}),
   reading=await queries.execute({actor,domain:'maintenance',tool:'read-operation-object',arguments:{kind:'chat-report',id:first.reportId,filters:{}}});
  assert.equal(reading.purpose,'private-case-review');assert.equal(reading.excludedFromProfile,true);assert.equal(reading.data.materials[0].text,'PRIVATE_CASE_NECESSARY_SOURCE');assert.equal(reading.data.roomHistoryGranted,false);
  await assert.rejects(queries.execute({actor,domain:'maintenance',tool:'read-operation-object',arguments:{kind:'chat-report',id:other.reportId,filters:{}}}),{code:'operations_ai_case_purpose_denied'});
  const directory=await queries.execute({actor,domain:'maintenance',tool:'query-operations',arguments:{module:'chat-reports',view:'list',filters:{}}});assert.equal(JSON.stringify(directory).includes('PRIVATE_CASE_NECESSARY_SOURCE'),false);
  const grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'仅此案件选入消息',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId:ai.maintenance,permissions:['chat-messages.hide','chat-messages.restore','chat-messages.keep'],resourceIds:[first.reportId],resourceScope:{kind:'selected',resourceIds:[first.reportId]}},adminAuth)).automation,strategyId=randomUUID(),strategyVersionId=randomUUID(),authorizeOperation=async(_db,operation)=>({allowed:operation.targetId===first.reportId&&operation.actor.aiAccountId===ai.maintenance,grantId:grant.id,grantVersion:grant.version,strategyId,strategyVersionId}),request={kind:'private-case-message',reportId:first.reportId,messageId:message.messageId,action:'hide',summary:'仅本案当前选材的普通处理'},operationId=randomUUID();
  const result=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation});assert.equal(result.effectState,'completed');assert.equal(result.receipt.revision,1);assert.equal((await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation,reconcile:true})).effectState,'completed');
  const event=(await f.db.query('SELECT actor_kind,operator_id FROM account_chat_governance_events_v1 WHERE id=$1',[operationId])).rows[0];assert.deepEqual(event,{actor_kind:'operations-ai-service',operator_id:'ai:'+ai.maintenance});
  assert.equal((await tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{...request,action:'keep'},authorizeOperation})).effectState,'completed');
  const human=await g.operatorGet(admin,{reportId:first.reportId});await g.operatorMessageVisibility(admin,{reportId:first.reportId,messageId:message.messageId},{operationId:randomUUID(),expectedVersion:human.version,expectedRevision:2,messageRevision:message.revision,action:'keep',summary:'人工重新确认本案处置'},adminAuth);
  await assert.rejects(tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{...request,action:'restore'},authorizeOperation}),{code:'operations_agentos_human_review_required'});
  const audit=(await f.db.query('SELECT selection,result FROM business_admin_audit_v1 WHERE operation_id=$1',[operationId])).rows[0];assert.equal(JSON.stringify(audit).includes('PRIVATE_CASE_NECESSARY_SOURCE'),false);
 });

 await t.test('bounded ordinary strategy maintenance uses the stable task identity across domains and preserves shared human decisions',async()=>{
  const actor=await mint('maintenance'),strategies=new P13StrategiesService({db:f.db,endpoint:f.endpoint,businessAdmin,authority,effects:{},native:{status:async()=>({state:'unavailable'})},now:f.now}),ordinary=new P13OrdinaryStrategies({strategies}),
   tools=new OperationsAgentOsActionTools({authority,services:{ordinaryStrategies:ordinary},now:f.now});strategies.autonomy={aiWorkAccounts:accounts,actionTools:tools};
  const strategyId=randomUUID(),configuration=structuredClone(p13EmptyConfiguration);configuration.common={objective:'人工已确认的共享目标',automationEnabled:true};
  Object.assign(configuration.domains.find(domain=>domain.key==='discovery'),{objective:'人工确认的发现领域目的',priority:'保留人工优先事项',executionEnabled:true});
  configuration.strategies=[{id:strategyId,name:'跨岗位发现分析',domain:'discovery',objective:'仅在批准边界内调整数值',enabled:true,mode:'ai-autonomous',template:'analysis-only',judgment:'prepared-command',instructions:null,
   condition:{combinator:'and',rules:[{field:'textLength',operator:'gte',value:40}]},ordinaryBounds:{parameters:[{path:[0],minimum:10,maximum:100}],modes:['ai-autonomous','ai-human-participation'],canEnable:true,canDisable:true},recovery:{versionId:null,conditions:[]},
   execution:{aiDomain:'maintenance',trigger:{kind:'manual',eventTypes:[]},mode:'ai',grantIds:[],resourceScope:{kind:'eligible'},requiredRehearsal:false,actions:[]}}];
  const initial=await strategies.saveDraft(admin,{operationId:randomUUID(),expectedRevision:(await strategies.head(f.db)).revision,configuration,reason:'人工确认普通调整边界'},adminAuth),rehearsal=await strategies.rehearsal(admin,{operationId:randomUUID(),versionId:initial.versionId,executionIds:[]});
  assert.equal(rehearsal.valid,true);await strategies.publish(admin,{operationId:randomUUID(),expectedRevision:initial.revision,versionId:initial.versionId,rehearsalId:rehearsal.rehearsalId,reason:'人工初始发布'},adminAuth);
  const grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'仅此策略的普通字段维护',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId:ai.maintenance,permissions:['strategies.read','strategies.ordinary.configure','strategies.ordinary.publish'],resourceIds:[strategyId],resourceScope:{kind:'selected',resourceIds:[strategyId]}},adminAuth)).automation,
   governingStrategyId=randomUUID(),strategyVersionId=randomUUID(),authorizeOperation=async(_db,operation)=>({allowed:operation.actor.aiAccountId===ai.maintenance&&operation.targetId===strategyId&&['strategies.ordinary.configure','strategies.ordinary.publish'].includes(operation.permission),grantId:grant.id,grantVersion:grant.version,strategyId:governingStrategyId,strategyVersionId}),
   request={kind:'ordinary-strategy-draft',strategyId,parameterEdits:[{path:[0],value:10}],mode:'ai-human-participation'},operationId=randomUUID(),saved=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation});
  assert.equal(saved.effectState,'completed');const versionId=saved.receipt.versionId,version=await strategies.version(f.db,versionId);assert.equal(version.ordinary_task_id,actor.taskId);assert.equal(version.ordinary_ai_account_id,ai.maintenance);assert.equal(version.ordinary_execution_id,null);
  assert.deepEqual(version.configuration.common,configuration.common);assert.deepEqual(version.configuration.domains,configuration.domains);assert.equal(version.configuration.strategies[0].execution.mode,'ai-human');
  assert.equal((await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation,reconcile:true})).effectState,'completed');
  await assert.rejects(tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{...request,instructions:'不得扩展到新指令字段'},authorizeOperation}),{code:'invalid_operations_agentos_action'});
  const published=await tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{kind:'ordinary-strategy-publish',strategyId,versionId},authorizeOperation});assert.equal(published.effectState,'completed');
  const active=await strategies.version(f.db,(await strategies.head(f.db)).active_id);assert.equal(active.configuration.strategies[0].condition.rules[0].value,10);assert.deepEqual(active.configuration.strategies[0].ordinaryBounds,configuration.strategies[0].ordinaryBounds);
  const result=(await f.db.query('SELECT result FROM operations_p13_strategy_rehearsals_v1 WHERE version_id=$1',[versionId])).rows[0].result;assert.equal(result.preview.sideEffects,false);assert.equal(result.preview.modelCalls,0);assert.equal(result.preview.semanticJudgment,'not-validated');
 });

 await t.test('a bounded account participation action keeps exact revisions and stops at a later human decision',async()=>{
  const targetId=f.people[1].accountId,actor=await mint('maintenance'),tools=new OperationsAgentOsActionTools({authority,services:{accounts:businessAdmin},now:f.now}),
   grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'单账户普通参与限制',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId:ai.maintenance,permissions:['accounts.read','accounts.restriction.apply','accounts.restriction.release'],resourceIds:[targetId],resourceScope:{kind:'selected',resourceIds:[targetId]}},adminAuth)).automation,
   strategyId=randomUUID(),strategyVersionId=randomUUID(),authorizeOperation=async(_db,operation)=>({allowed:operation.actor.aiAccountId===ai.maintenance&&operation.targetId===targetId&&['accounts.restriction.apply','accounts.restriction.release'].includes(operation.permission),grantId:grant.id,grantVersion:grant.version,strategyId,strategyVersionId}),
   request={kind:'account-restriction',targetId,action:'apply',until:new Date((f.now()+60)*1000).toISOString(),reason:'已明确授权的普通单账户参与限制'};
  assert.equal(tools.dutyActionReady('accounts.restriction.apply'),true);
  const operationId=randomUUID(),result=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation});assert.equal(result.effectState,'completed');
  assert.equal((await businessAdmin.get(actor,targetId)).account.restriction.revision,1);
  assert.equal((await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation,reconcile:true})).effectState,'completed');
  assert.equal((await tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{kind:'account-restriction',targetId,action:'release',reason:'解除同一授权刚建立的限制'},authorizeOperation})).effectState,'completed');
  await businessAdmin.restrict(admin,targetId,{operationId:randomUUID(),expectedRevision:2,until:new Date((f.now()+120)*1000).toISOString(),reason:'人工重新作出的具体决定'});
  await assert.rejects(tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{kind:'account-restriction',targetId,action:'release',reason:'不得改变原人工决定'},authorizeOperation}),{code:'operations_agentos_human_review_required'});
 });

 await t.test('AI message drafts keep the original operation target, human verification boundary and immutable receipt',async()=>{
  let sends=0;const messaging=new OperationsMessagingService({db:f.db,endpoint:f.endpoint,businessAdmin,accounts:f.accounts,jobs:{enqueue:async()=>{sends++;throw new Error('Drafts cannot enqueue delivery');}},now:f.now}),
   tools=new OperationsAgentOsActionTools({authority,services:{messaging},now:f.now}),queries=new OperationsAgentOsQueryTools({authority,services:{messaging},now:f.now}),actor=await mint('maintenance'),
   config={channels:['inapp'],content:{purpose:'community-update',title:'尚待人工核实的合成消息草稿',body:'草'.repeat(8000),href:null,expiresAt:new Date((f.now()+3600)*1000).toISOString()},audience:{kind:'accounts',accountIds:[f.people[0].accountId]},senderKey:'community',schedule:{kind:'immediate'}},
   grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'仅消息草稿创建与保存的受限授权',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId:ai.maintenance,permissions:['notices.read','notices.create','notices.update'],resourceIds:[],resourceScope:{kind:'eligible'}},adminAuth)).automation,
   strategyId=randomUUID(),strategyVersionId=randomUUID(),authorizeOperation=async(_db,operation)=>({allowed:operation.actor.aiAccountId===ai.maintenance&&['notices.create','notices.update'].includes(operation.permission),grantId:grant.id,grantVersion:grant.version,strategyId,strategyVersionId}),
   operationId=randomUUID(),request={kind:'message-draft-create',config};
  assert.equal(tools.dutyActionReady('notices.create'),true);assert.equal(tools.dutyActionReady('notices.update'),true);
  for(const extra of [{automation:{kind:'ordinary',factsConfirmed:true}},{planId:randomUUID()},{operationId:randomUUID()}])await assert.rejects(tools.prepareFor(actor,'maintenance',{...request,...extra},{operationId}),{code:'invalid_operations_agentos_action'});
  await assert.rejects(tools.prepareFor(actor,'maintenance',{...request,config:{...config,automation:{kind:'ordinary',factsConfirmed:true}}},{operationId}),{code:'invalid_operations_agentos_action'});
  await assert.rejects(tools.prepareFor(actor,'maintenance',request),{code:'invalid_operations_agentos_action'});
  const proposal=await tools.prepareFor(actor,'maintenance',request,{operationId});assert.equal(proposal.target.id,operationId);assert.equal(proposal.command.planId,operationId);assert.equal(proposal.impact.includes(config.content.body),true);
  await assert.rejects(tools.executePrepared(actor,proposal,{operationId:randomUUID(),authorize:()=>actor}),{code:'invalid_operations_agentos_action'});
  const result=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation});
  assert.equal(result.effectState,'completed');assert.equal(result.target.id,operationId);assert.equal(result.receipt.planId,operationId);assert.equal(result.basis,'persisted-domain-operation-receipt');
  const created=(await messaging.get(actor,operationId)).plan;assert.equal(created.state,'draft');assert.deepEqual(created.config.automation,{kind:'human-required',factsConfirmed:false});assert.equal(created.approval,null);assert.equal(created.config.content.body,config.content.body);assert.equal(sends,0);
  const selected=await queries.execute({actor,domain:'maintenance',tool:'read-operation-object',arguments:{kind:'message-plan',id:operationId,filters:{}}});
  assert.equal(selected.data.plan.config.content.body,config.content.body);assert.equal(selected.purpose,'message-draft-editing');assert.equal(selected.excludedFromProfile,true);assert.equal(selected.data.plan.instructionAuthority,'none');assert.equal(selected.evidenceRefs.find(ref=>ref.kind==='message-plan').controlledSource,true);
  const directory=await queries.execute({actor,domain:'maintenance',tool:'query-operations',arguments:{module:'messaging',view:'plans',filters:{}}});assert.equal(JSON.stringify(directory).includes(config.content.body),false);
  const saveId=randomUUID(),save={kind:'message-draft-save',targetId:operationId,config:{...config,content:{...config.content,title:'第二版待人工核实草稿'}}},saved=await tools.executeDutyOperation({actor,operationId:saveId,arguments:save,authorizeOperation});
  assert.equal(saved.effectState,'completed');assert.equal(saved.receipt.version,2);assert.equal(saved.receipt.revision,2);assert.deepEqual((await messaging.get(actor,operationId)).plan.config.automation,{kind:'human-required',factsConfirmed:false});
  assert.equal((await queries.revalidate({actor,domain:'maintenance',evidenceRefs:selected.evidenceRefs})).valid,false);
  const before=Number((await f.db.query('SELECT count(*) AS n FROM operations_messaging_commands_v1')).rows[0].n),original=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation,reconcile:true});
  assert.equal(original.effectState,'completed');assert.equal(original.receipt.version,1);assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM operations_messaging_commands_v1')).rows[0].n),before);
  tools.enableDutyKind('messaging-state');await assert.rejects(tools.qualifyDutyTargetWithin(f.db,{actor,permission:'notices.publish',targetId:operationId,request:{kind:'messaging-state',targetId:operationId,action:'activate'},command:{expectedVersion:2,expectedRevision:2}}),{code:'operations_agentos_human_review_required'});assert.equal(sends,0);
  const audit=(await f.db.query('SELECT actor_kind,operator_role,operator_id,grant_id FROM business_admin_audit_v1 WHERE operation_id=$1',[operationId])).rows[0];assert.deepEqual(audit,{actor_kind:'operations-ai-service',operator_role:null,operator_id:'ai:'+ai.maintenance,grant_id:grant.id});
 });

 await t.test('automatic feedback uses the original service and durable receipt, never a repeated write on reconciliation',async()=>{
  const feedback=new OperationsFeedbackService({businessAdmin,accounts:f.accounts,now:f.now}),submission=await feedback.submit(f.people[0],{operationId:randomUUID(),body:'仅保存在反馈领域的合成问题',category:'problem',module:'other'}),
   tools=new OperationsAgentOsActionTools({authority,services:{feedback},now:f.now}),actor=await mint('maintenance');
  assert.equal((await authority.requireDutyAction(actor,'feedback.read')).operatorId,'ai:'+ai.maintenance);assert.equal(tools.dutyActionReady('feedback.update'),true);assert.equal(tools.dutyActionReady('jobs.retry'),false);
  const grantInput={operationId:randomUUID(),expectedVersion:0,name:'受限反馈及未接消费者授权',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId:ai.maintenance,permissions:['feedback.read','feedback.update','jobs.retry'],resourceIds:[submission.feedbackId],resourceScope:{kind:'selected',resourceIds:[submission.feedbackId]}},
   grant=(await permissions.saveAutomation(admin,grantInput,adminAuth)).automation;
  assert.equal(grant.enabled,true);assert.equal(grant.authorization.saved,true);assert.equal(grant.authorization.effective,true);assert.equal(grant.readiness.ready,false);
  const strategyId=randomUUID(),strategyVersionId=randomUUID(),authorizeOperation=async(_db,operation)=>({allowed:operation.actor.aiAccountId===ai.maintenance&&operation.targetId===submission.feedbackId&&operation.permission==='feedback.update',grantId:grant.id,grantVersion:grant.version,strategyId,strategyVersionId}),
   operationId=randomUUID(),request={kind:'feedback-update',targetId:submission.feedbackId,state:'processing'},result=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation});
  assert.equal(result.effectState,'completed');assert.equal(result.basis,'persisted-domain-operation-receipt');assert.equal(result.operationId,operationId);assert.equal((await feedback.get(actor,submission.feedbackId)).feedback.revision,2);
  const count=Number((await f.db.query("SELECT count(*) AS n FROM business_admin_audit_v1 WHERE action='feedback-update'")).rows[0].n);
  assert.equal((await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation,reconcile:true})).effectState,'completed');
  assert.equal(Number((await f.db.query("SELECT count(*) AS n FROM business_admin_audit_v1 WHERE action='feedback-update'")).rows[0].n),count);
  assert.equal((await tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:request,authorizeOperation,reconcile:true})).effectState,'unknown');
  const audit=(await f.db.query('SELECT actor_kind,operator_role,operator_id,grant_id FROM business_admin_audit_v1 WHERE operation_id=$1',[operationId])).rows[0];assert.deepEqual(audit,{actor_kind:'operations-ai-service',operator_role:null,operator_id:'ai:'+ai.maintenance,grant_id:grant.id});
  const metadata=(await f.db.query('SELECT binding FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2',[f.endpoint,operationId])).rows[0].binding;assert.equal(metadata.contextSchemaVersion,1);assert.equal(metadata.endpoint,f.endpoint);
  let durableAllowed=false,durableChecks=0;authority.durableOperationAuthorizationWithin=async(db,context)=>{
   durableChecks++;const original=(await db.query('SELECT binding FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2',[f.endpoint,context.operation.operationId])).rows[0];
   return{allowed:durableAllowed&&context.endpoint===f.endpoint&&context.taskId===metadata.taskId&&context.aiAccountId===metadata.aiAccountId&&original?.binding.operation.grantId===context.operation.grantId&&original?.binding.operation.strategyVersionId===context.operation.strategyVersionId};
  };
  await assert.rejects(transaction(f.db,db=>authority.continuationActorWithin(db,{...metadata,endpoint:'https://another.invalid'})),{code:'operations_ai_duty_operation_denied'});assert.equal(durableChecks,0);
  await assert.rejects(transaction(f.db,db=>authority.continuationActorWithin(db,metadata)),{code:'operations_ai_duty_operation_denied'});
  durableAllowed=true;const continuation=await transaction(f.db,db=>authority.continuationActorWithin(db,metadata));assert.equal(authority.acceptsDuty(continuation),true);assert.ok(durableChecks>=3,'durable approval is checked before minting and again with the current role');
  await assert.rejects(authority.requireDutyOperation(continuation,['feedback.update'],{id:submission.feedbackId,operationId,command:{...metadata.operation.command,state:'closed'}}),{code:'operations_ai_duty_operation_denied'});
  durableAllowed=false;await assert.rejects(authority.requireDutyAction(continuation,'feedback.read'),{code:'operations_ai_duty_inactive'});
  await feedback.event(admin,submission.feedbackId,{operationId:randomUUID(),expectedRevision:2,state:'closed'});
  await assert.rejects(tools.executeDutyOperation({actor,operationId:randomUUID(),arguments:{...request,state:'pending'},authorizeOperation}),{code:'operations_agentos_human_review_required'});
  await accounts.command(admin,'maintenance',{operationId:randomUUID(),kind:'state-save',expectedVersion:2,enabled:false},adminAuth);
  const renamed=await permissions.saveAutomation(admin,{...grantInput,id:grant.id,expectedVersion:grant.version,operationId:randomUUID(),name:'账户暂停期间仍可保存授权意图'},adminAuth);
  assert.equal(renamed.automation.enabled,true);assert.equal(renamed.automation.authorization.effective,false);assert.equal(renamed.automation.bindingState,'disabled');
  await assert.rejects(authority.requireDutyAction(actor,'feedback.read'),{code:'operations_ai_work_disabled'});
 });

 await t.test('revocation is checked on every delegated read and cannot be bypassed with an old role snapshot',async()=>{
  await accounts.assignment(admin,'overview',{operationId:randomUUID(),id:(await accounts.assignmentsWithin(f.db,ai.overview))[0].id,expectedVersion:1,roleId:role.id,enabled:false},adminAuth);
  await assert.rejects(permissions.delegatedDirectory(supervisor),{code:'operations_ai_delegation_denied'});
  assert.equal((await f.db.query('SELECT enabled FROM operations_ai_work_assignments_v1 WHERE id=$1',[assignment.id])).rows[0].enabled,true,'revoking supervisor authority does not rewrite a different AI assignment');
 });
 await f.db.exec('RESET ROLE');
});
