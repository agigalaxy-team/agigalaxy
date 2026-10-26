import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,transaction} from "../src/infrastructure/database.mjs";
import {migrations} from '../src/infrastructure/migrations.mjs';
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsAiWorkAccountsService} from '../src/operations/accounts/ai-work-service.mjs';
import {OperationsAgentOsAuthority} from "../src/operations/agentos/authority.mjs";
import {OperationsAutonomy} from "../src/operations/autonomy/index.mjs";
import {OperationsAgentOsActionTools} from "../src/operations/agentos/action-tools.mjs";
import {OperationsAgentOsQueryTools} from "../src/operations/agentos/query-tools.mjs";
import {workbenchPrepareSchemas} from "../src/operations/agentos/action-catalog.mjs";
import {defaultConfiguration} from '../src/operations/autonomy/contract.mjs';

// Real130 ->131 DDL, galaxy_api, current human/AI roles, delegation, durable
// tasks, prompt versions, immutable receipts and business audit. Only external
// management authentication is the named synthetic upstream contract. No model
// call, real credential, production write or management browser is involved.
test('explicit prompt delegation and concrete management cards retain real authority and versions',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());const endpoint='https://prompt-management.synthetic.invalid',now=()=>2000000000,at=new Date(now()*1000),admin={kind:'business-operator',operatorId:'a'.repeat(64),role:'administrator',endpoint},reader={...admin,operatorId:'b'.repeat(64),role:'reader'},authorize=async()=>({...admin});
 // Install the real previous schema first, with real existing data. Migration131
 // must not assign new rights or append new actions to that existing delegation.
 await transaction(db,async tx=>{await tx.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');for(const m of migrations.filter(m=>m.version<=130)){await tx.exec(m.sql);await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[m.version]);}});
 for(const actor of [admin,reader])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.synthetic.invalid',$1,'合成管理人',$3,$3)",[actor.operatorId,endpoint,at]);
 const ids={overview:randomUUID(),governance:randomUUID(),messaging:randomUUID(),discovery:randomUUID(),maintenance:randomUUID()};
 for(const [domain,id]of Object.entries(ids))await db.query('INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,$3,$3,\'\',true,1,1,$4,$4)',[id,endpoint,domain,at]);
 const delegationId=randomUUID();await db.query("INSERT INTO operations_ai_role_delegations_v1(id,endpoint,source_ai_account_id,version,enabled,target_ai_account_ids,grantable_permissions,allowed_management_actions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,1,true,$4,ARRAY['feedback.read'],ARRAY['read','create','update','assign','revoke'],$5,$5,$6,$6)",[delegationId,endpoint,ids.overview,[ids.maintenance],admin.operatorId,at]);
 assert.equal(await migrate(db,{roles:['api']}),131);
 const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async actor=>actor.operatorId===admin.operatorId?'administrator':actor.operatorId===reader.operatorId?'reader':null,now}),businessAdmin=new BusinessAdminService({db,endpoint,permissions,now}),accounts=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,now});permissions.aiWorkAccounts=accounts;t.after(()=>businessAdmin.auditPages.close());
 const authority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts:accounts,now});businessAdmin.executorAuthority=authority;
 const autonomy=new OperationsAutonomy({db,endpoint,businessAdmin,authority,aiWorkAccounts:accounts,now}),tools=new OperationsAgentOsActionTools({authority,services:{permissions},now}),queries=new OperationsAgentOsQueryTools({authority,services:{permissions},now});
 await transaction(db,tx=>autonomy.ensureWithin(tx));
 const roleInput={operationId:randomUUID(),expectedVersion:0,name:'受限总控',description:'合成当前角色',enabled:true,permissions:['ai.roles.read','ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke']},role=(await permissions.saveRole(admin,roleInput,{authorize})).role;
 await accounts.assignment(admin,'overview',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize});
 const cfg=await autonomy.configWithin(db,'overview'),taskId=randomUUID(),taskConfig={...defaultConfiguration('overview'),enabled:true,mode:'ai',plan:{strategyIds:[],grantIds:[],actions:['ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke','ai.prompts.update'],resourceIds:[],eventTypes:[]}},context={domain:'overview',aiAccountId:ids.overview,taskId,purpose:taskConfig.purpose,planId:cfg.id,planVersion:1};
 await db.query('UPDATE operations_autonomy_configs_v1 SET enabled=true,configuration=$3 WHERE endpoint=$1 AND id=$2',[endpoint,cfg.id,JSON.stringify(taskConfig)]);
 await db.query("INSERT INTO operations_autonomy_tasks_v1(id,endpoint,config_id,config_revision,ai_account_id,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,lease_owner,lease_until,due_at,created_at,updated_at) VALUES($1,$2,$3,1,$4,'overview','routine',$5,'合成真实任务资格','ai','running','running','not-started',$6,1,1,$7,$8,$9,$10,$10,$10)",[taskId,endpoint,cfg.id,ids.overview,'synthetic-prompt:'+taskId,JSON.stringify(taskConfig),randomUUID(),randomUUID(),new Date((now()+300)*1000),at]);
 const mint=()=>transaction(db,tx=>authority.dutyActorWithin(tx,context)),work=()=>authority.human(admin,{domain:'overview',purpose:'prepare'}),target=ids.maintenance;
 await db.exec('SET ROLE galaxy_api');let savedDelegation,supervisor;

 await t.test('an existing delegation and role gain no prompt authority during the real upgrade',async()=>{
  const existing=(await permissions.delegation(admin)).delegation;assert.deepEqual(existing.allowedManagementActions,['read','create','update','assign','revoke']);assert.equal(existing.version,1);assert.equal((await accounts.authorizationWithin(db,'overview')).permissions.includes('ai.prompts.update'),false);
  supervisor=await mint();await assert.rejects(permissions.delegatedPrompt(supervisor,{aiAccountId:target}),{code:'operations_permission_denied'});
  await assert.rejects(tools.prepareFor(admin,'overview',{kind:'ai-work-prompt-save',aiAccountId:target,prompt:'根管理员同样取人和AI交集'},{operationId:randomUUID()}),{code:'operations_permission_denied'});
  let availability=await transaction(db,tx=>permissions.delegationAvailabilityWithin(tx,{actor:supervisor}));assert.equal(availability.canReadRoles,true,'read rights use the current query purpose');assert.equal(availability.canReadPrompts,false);assert.deepEqual(availability.promptActions,[]);
  await permissions.saveRole(admin,{...roleInput,id:role.id,operationId:randomUUID(),expectedVersion:role.version,permissions:[...role.permissions,'ai.prompts.read','ai.prompts.update']},{authorize});
  supervisor=await mint();await assert.rejects(permissions.delegatedPrompt(supervisor,{aiAccountId:target}),{code:'operations_ai_delegation_denied'});
  const before=await transaction(db,tx=>permissions.managementCapabilitiesWithin(tx,{actor:supervisor}));assert.equal(before.prompt.update.systemSupport,'connected');assert.equal(before.prompt.update.permissionAllowed,true);assert.equal(before.prompt.update.delegated,false);assert.equal(before.prompt.update.available,false);assert.deepEqual(before.prompt.update.reasons,['delegation-missing']);assert.equal(before.modelConfiguration.systemSupport,'human-only');
  savedDelegation=(await permissions.saveDelegation(admin,{operationId:randomUUID(),expectedVersion:1,enabled:true,targetAiAccountIds:[target],grantablePermissions:['feedback.read'],allowedManagementActions:['read','create','update','assign','revoke','prompt-read','prompt-update']},{authorize})).delegation;
  availability=await transaction(db,tx=>permissions.delegationAvailabilityWithin(tx,{actor:supervisor}));assert.equal(availability.canReadPrompts,true);assert.deepEqual(availability.promptActions,['read','update']);
  await assert.rejects(permissions.delegatedPrompt(supervisor,{aiAccountId:ids.overview}),{code:'operations_ai_delegation_target_denied'});await assert.rejects(permissions.delegatedPrompt(supervisor,{aiAccountId:ids.governance}),{code:'operations_ai_delegation_target_denied'});await assert.rejects(permissions.delegatedPrompt({...supervisor},{aiAccountId:target}),{code:'business_admin_denied'});
 });

 await t.test('an authorized AI changes only prompt and recovers the exact real original receipt',async()=>{
  const old=await autonomy.configWithin(db,'maintenance'),text='ROLE_WORK_REQUIREMENTS_ONLY_\n'+('字'.repeat(12000)),input={operationId:randomUUID(),aiAccountId:target,expectedRevision:old.revision,expectedPromptVersion:old.prompt_version,prompt:text},read=await permissions.delegatedPrompt(supervisor,{aiAccountId:target});assert.equal(read.prompt.text,'');
  const result=await permissions.delegatedPromptSave(supervisor,input),row=await autonomy.configWithin(db,'maintenance');assert.equal(result.prompt.promptVersion,2);assert.equal(result.prompt.revision,2);assert.equal(row.updated_by,null);assert.equal(row.updated_by_ai_account_id,ids.overview);assert.equal(row.enabled,old.enabled);assert.equal(row.plan_version,old.plan_version);assert.deepEqual({...row.configuration,prompt:old.configuration.prompt},old.configuration);assert.equal(row.next_due_at,old.next_due_at);
  const version=(await db.query('SELECT * FROM operations_autonomy_versions_v1 WHERE config_id=$1 AND revision=2',[row.id])).rows[0];assert.equal(version.managed_by_ai_account_id,ids.overview);assert.equal(version.operator_id,null);assert.equal(version.management_operation_id,input.operationId);assert.equal(version.management_delegation_version,savedDelegation.version);
  await assert.rejects(db.query('INSERT INTO operations_autonomy_versions_v1(config_id,revision,configuration,prompt_version,plan_version,created_at,managed_by_ai_account_id,management_operation_id,management_delegation_id,management_delegation_version) VALUES($1,99,$2,2,1,$3,$4,$5,$6,NULL)',[row.id,JSON.stringify(row.configuration),at,ids.overview,randomUUID(),delegationId]),{code:'23514'});
  assert.equal((await permissions.delegatedPromptSave(supervisor,input)).replayed,true);assert.equal((await permissions.delegatedManagementOperation(supervisor,input.operationId,{kind:'prompt-save',input})).result.prompt.promptVersion,2);
  await assert.rejects(permissions.delegatedPromptSave(supervisor,{...input,operationId:randomUUID(),prompt:'stale'}),{code:'operations_ai_prompt_version_changed'});await assert.rejects(permissions.delegatedPromptSave(supervisor,{...input,operationId:randomUUID(),enabled:true}),{code:'invalid_operations_permissions_request'});
  const query=await queries.execute({actor:supervisor,domain:'overview',tool:'read-ai-delegation',arguments:{aiAccountId:target}});assert.equal(query.data.prompt.text,text,'do not silently truncate the selected role prompt');assert.equal(query.excludedFromProfile,true);assert.deepEqual(query.evidenceRefs,[]);
  const raw=(await db.query("SELECT actor_kind,operator_id,operator_role,actor_context,selection,result FROM business_admin_audit_v1 WHERE operation_id=$1 AND action='ai-prompt-save'",[input.operationId])).rows[0];assert.equal(raw.actor_kind,'operations-ai-service');assert.equal(raw.operator_id,'ai:'+ids.overview);assert.equal(raw.operator_role,null);assert.equal(raw.actor_context.taskId,taskId);assert.equal(JSON.stringify(raw).includes(text),false);
  const page=await businessAdmin.audit(admin,{action:'ai-prompt-save'}),item=page.items.find(row=>row.operationId===input.operationId);assert.equal(item.result.promptVersion,2);assert.equal(item.attribution.taskId,taskId);assert.equal(JSON.stringify(page).includes(text),false);
  assert.equal((await autonomy.taskWithin(db,taskId)).configuration.prompt,taskConfig.prompt,'an existing task keeps its pinned role prompt');assert.equal((await permissions.delegatedPrompt(supervisor,{aiAccountId:target})).prompt.promptVersion,2);
 });

 await t.test('current human and AI rights prepare concrete prompt and role cards with CAS and original GET',async()=>{
  const actor=await work(),operationId=randomUUID(),request={kind:'ai-work-prompt-save',aiAccountId:target,prompt:'下一版完整岗位工作要求'},proposal=await tools.prepareFor(actor,'overview',request,{operationId});
  assert.equal(proposal.requiredAction,'ai.prompts.update');assert.equal(proposal.review.before.length>12000,true);assert.equal(proposal.review.after,request.prompt);assert.equal(proposal.command.expectedRevision,2);assert.equal(proposal.command.expectedPromptVersion,2);assert.equal(proposal.command.delegationVersion,savedDelegation.version);assert.equal((await autonomy.configWithin(db,'maintenance')).prompt_version,2,'preparation is read-only');
  const result=await tools.executePrepared(actor,proposal,{operationId,authorize});assert.equal(result.state,'completed');assert.equal(result.receipt.promptVersion,3);assert.equal((await tools.recoverPrepared(actor,proposal,operationId)).receipt.promptVersion,3);assert.equal((await tools.executePrepared(actor,proposal,{operationId,authorize})).receipt.replayed,true);
  const actual=await autonomy.configWithin(db,'maintenance');assert.equal(actual.updated_by,admin.operatorId);assert.equal(actual.updated_by_ai_account_id,null);
  const roleRequest={kind:'ai-role-command',command:{kind:'role-create',expectedVersion:0,name:'具体卡受限角色',description:'只授予已委派的读取权限',enabled:true,permissions:['feedback.read'],targetAiAccountIds:[target]}},roleOperation=randomUUID(),roleProposal=await tools.prepareFor(actor,'overview',roleRequest,{operationId:roleOperation});
  assert.equal(roleProposal.requiredAction,'ai.roles.create');const roleResult=await tools.executePrepared(actor,roleProposal,{operationId:roleOperation,authorize});assert.equal(roleResult.state,'completed');assert.equal((await tools.recoverPrepared(actor,roleProposal,roleOperation)).receipt.roleId,roleResult.receipt.roleId);
  assert.equal(roleResult.receipt.roleId,roleOperation);assert.equal(roleProposal.target.id,roleOperation);
  const created=(await db.query('SELECT * FROM operations_business_roles_v1 WHERE id=$1',[roleResult.receipt.roleId])).rows[0];assert.equal(created.subject_scope,'ai-only');assert.equal(created.created_by,admin.operatorId);assert.equal(created.created_by_ai_account_id,null);
  const directory=await queries.execute({actor,domain:'overview',tool:'read-ai-delegation',arguments:{}});assert.equal(directory.data.roles.some(row=>row.id===created.id),true);assert.equal(JSON.stringify(directory).includes(request.prompt),false);
  const assignmentRequest={kind:'ai-role-command',command:{kind:'assignment-save',expectedVersion:0,aiAccountId:target,roleId:created.id,enabled:true}},assignOperation=randomUUID(),assignProposal=await tools.prepareFor(actor,'overview',assignmentRequest,{operationId:assignOperation});const assigned=await tools.executePrepared(actor,assignProposal,{operationId:assignOperation,authorize});assert.equal(assigned.receipt.version,1);
  const listed=await permissions.delegatedDirectory(actor);assert.equal(listed.assignments.find(row=>row.id===assigned.receipt.assignmentId).enabled,true);
  assert.equal(assigned.receipt.assignmentId,assignOperation);assert.equal(assignProposal.target.id,assignOperation);
  await assert.rejects(permissions.delegatedRoleSave(actor,{...roleRequest.command,name:'不能用原ID碰撞创建',operationId:role.id}),{code:'operations_permissions_version_changed'});assert.equal((await db.query('SELECT name FROM operations_business_roles_v1 WHERE id=$1',[role.id])).rows[0].name,role.name);
  for(const field of ['model','enabled','schedule','goal','plan','boundary'])assert.equal(workbenchPrepareSchemas['ai-work-prompt-save'].safeParse({...request,[field]:'forbidden'}).success,false);
  await assert.rejects(tools.prepareFor(admin,'overview',{...roleRequest,command:{...roleRequest.command,name:'不准管理权限',permissions:['ai.prompts.update']}},{operationId:randomUUID()}),{code:'operations_ai_delegation_ceiling_denied'});
 });

 await t.test('revocation, changed versions and stopped task cannot reuse an earlier management context',async()=>{
  const actor=await work(),proposal=await tools.prepareFor(actor,'overview',{kind:'ai-work-prompt-save',aiAccountId:target,prompt:'不可越过后续人工委派变更'},{operationId:randomUUID()});
  const updated=(await permissions.saveDelegation(admin,{operationId:randomUUID(),expectedVersion:savedDelegation.version,enabled:true,targetAiAccountIds:[target],grantablePermissions:['feedback.read'],allowedManagementActions:['read','create','update','assign','revoke','prompt-read']},{authorize})).delegation;
  await assert.rejects(tools.executePrepared(actor,proposal,{operationId:randomUUID(),authorize}),{code:'operations_ai_delegation_denied'});assert.equal((await autonomy.configWithin(db,'maintenance')).prompt_version,3);
  const facts=await transaction(db,tx=>permissions.managementCapabilitiesWithin(tx,{actor}));assert.equal(facts.prompt.read.available,true);assert.equal(facts.prompt.update.permissionAllowed,true);assert.equal(facts.prompt.update.delegated,false);assert.equal(facts.prompt.update.available,false);
  await permissions.saveDelegation(admin,{operationId:randomUUID(),expectedVersion:updated.version,enabled:true,targetAiAccountIds:[target],grantablePermissions:['feedback.read'],allowedManagementActions:['read','prompt-read','prompt-update']},{authorize});
  await db.query('UPDATE operations_autonomy_tasks_v1 SET configuration=jsonb_set(configuration,\'{plan,actions}\',\'[]\'::jsonb) WHERE endpoint=$1 AND id=$2',[endpoint,taskId]);
  await assert.rejects(permissions.delegatedPromptSave(supervisor,{operationId:randomUUID(),aiAccountId:target,expectedRevision:3,expectedPromptVersion:3,prompt:'任务未选该动作'}),{code:'operations_autonomy_scope_denied'});
  await db.query("UPDATE operations_autonomy_tasks_v1 SET state='stopped' WHERE endpoint=$1 AND id=$2",[endpoint,taskId]);await assert.rejects(permissions.delegatedPrompt(supervisor,{aiAccountId:target}),{code:'operations_autonomy_task_inactive'});
  await assert.rejects(permissions.delegatedPrompt(admin,{aiAccountId:target}),{code:'business_admin_denied'},'ordinary human configuration must not borrow the selected workbench AI context');
 });
 await db.exec('RESET ROLE');
});
