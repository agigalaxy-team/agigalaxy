import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate,transaction} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {OperationsAiWorkAccountsService} from '../src/operations/accounts/ai-work-service.mjs';
import {OperationsAgentOsAuthority} from "../src/operations/agentos/authority.mjs";
import {OperationsAgentOsActionTools} from "../src/operations/agentos/action-tools.mjs";
import {OperationsMessagingService} from "../src/operations/messaging/index.mjs";
import {businessAuditMetadata} from "../src/operations/audit/view.mjs";
import {auditItem} from "../src/operations/agentos/query-view.mjs";

// Actual current migrations, PG constraints, galaxy_api privileges, business
// services, role reload and process-attested AI identity. Only the approved
// plan/strategy boundary is the explicitly local eligibility contract.
test('real AI reads and draft receipts retain closed source/task attribution and current viewer permission',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);await migrate(f.db,{roles:['api']});
 const admin={kind:'business-operator',operatorId:'a'.repeat(64),role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'b'.repeat(64),role:'reader'},authorize=async()=>admin,
  permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>actor.operatorId===admin.operatorId?'administrator':actor.operatorId===reader.operatorId?'reader':null,now:f.now}),
  businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now}),accounts=new OperationsAiWorkAccountsService({db:f.db,endpoint:f.endpoint,businessAdmin,now:f.now});permissions.aiWorkAccounts=accounts;t.after(()=>businessAdmin.auditPages.close());
 for(const actor of [admin,reader])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.invalid',$1,'合成审计查阅人',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const aiAccountId=randomUUID(),taskId=randomUUID(),planId=randomUUID(),plan={domain:'maintenance',aiAccountId,taskId,purpose:'operations-maintenance',planId,planVersion:1};
 await f.db.query("INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'maintenance','合成运维执行账户','',true,1,1,$3,$3)",[aiAccountId,f.endpoint,new Date(f.now()*1000)]);
 await f.db.query("INSERT INTO operations_autonomy_tasks_v1(id,endpoint,ai_account_id,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,$3,'maintenance','routine',$4,'合成审计任务','ai','running','running','not-started',$5,1,1,$6,$7,$7,$7)",[taskId,f.endpoint,aiAccountId,'local-audit:'+taskId,JSON.stringify({planId,purpose:plan.purpose}),randomUUID(),new Date(f.now()*1000)]);
 const authority=new OperationsAgentOsAuthority({db:f.db,endpoint:f.endpoint,permissions,aiWorkAccounts:accounts,now:f.now,dutyAuthorizationWithin:async(db,context)=>{
  const row=(await db.query('SELECT ai_account_id,domain,state,configuration,plan_version FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2',[f.endpoint,context.taskId])).rows[0];
  return{allowed:row?.state==='running'&&row.ai_account_id===context.aiAccountId&&row.domain===context.domain&&row.configuration.planId===context.planId&&row.configuration.purpose===context.purpose&&row.plan_version===context.planVersion};
 }});businessAdmin.executorAuthority=authority;
 const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'合成草稿权限',description:'',enabled:true,permissions:['accounts.read','notices.read','notices.create','notices.update']},{authorize})).role;
 await accounts.assignment(admin,'maintenance',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize});
 const auditRole=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'仅审计查阅',description:'',enabled:true,permissions:['audit.read']},{authorize})).role,
  assigned=(await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:auditRole.id,enabled:true},{authorize})).assignment;
 await f.db.exec('SET ROLE galaxy_api');
 const actor=await transaction(f.db,db=>authority.dutyActorWithin(db,plan));assert.equal(actor.role,null);assert.equal(authority.acceptsDuty(actor),true);
 await businessAdmin.get(actor,f.people[0].accountId);
 await assert.rejects(businessAdmin.get({...actor},f.people[0].accountId),{code:'business_admin_denied'});
 const grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'合成草稿自主范围',executorKind:'ai',mode:'automatic',enabled:true,aiAccountId,permissions:['notices.read','notices.create','notices.update'],resourceIds:[],resourceScope:{kind:'eligible'}},{authorize})).automation,
  strategyId=randomUUID(),strategyVersionId=randomUUID(),operationId=randomUUID(),body='PRIVATE_DRAFT_CONTENT_NOT_AUDIT',
  messaging=new OperationsMessagingService({db:f.db,endpoint:f.endpoint,businessAdmin,accounts:f.accounts,jobs:{enqueue:()=>{throw new Error('Draft cannot deliver');}},now:f.now}),tools=new OperationsAgentOsActionTools({authority,services:{messaging},now:f.now}),
  request={kind:'message-draft-create',config:{channels:['inapp'],content:{purpose:'community-update',title:'待核实草稿',body,href:null,expiresAt:new Date((f.now()+3600)*1000).toISOString()},audience:{kind:'accounts',accountIds:[f.people[0].accountId]},senderKey:'community',schedule:{kind:'immediate'}}},
  authorizeOperation=async(_db,operation)=>({allowed:operation.actor.aiAccountId===aiAccountId&&['notices.create','notices.update'].includes(operation.permission)&&operation.targetId===operationId,grantId:grant.id,grantVersion:grant.version,strategyId,strategyVersionId}),
  result=await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation});assert.equal(result.effectState,'completed');
 const raw=(await f.db.query('SELECT * FROM business_admin_audit_v1 WHERE operation_id=$1',[operationId])).rows[0];
 assert.equal(raw.actor_kind,'operations-ai-service');assert.equal(raw.operator_id,'ai:'+aiAccountId);assert.equal(raw.operator_role,null);assert.equal(raw.actor_context.taskId,taskId);assert.equal(raw.actor_context.grantId,grant.id);assert.equal(raw.actor_context.strategyVersionId,strategyVersionId);
 assert.equal(Object.hasOwn(raw.selection,'actorContext'),false);assert.equal(Object.hasOwn(raw.result,'actorContext'),false);
 for(const extra of [{body},{grantId:body},{judgmentKind:body}])await assert.rejects(f.db.query("INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,selection,result,created_at,actor_kind,actor_context) VALUES($1,$2,$3,NULL,'user-read','{}','{}',$4,'operations-ai-service',$5)",[randomUUID(),f.endpoint,actor.operatorId,new Date(f.now()*1000),JSON.stringify({...raw.actor_context,...extra})]),{code:'23514'});
 const page=await businessAdmin.audit(admin,{page:1,pageSize:30,action:'notice-create'}),item=page.items.find(x=>x.operationId===operationId);
 assert.equal(item.actorKind,'operations-ai-service');assert.equal(item.operatorRole,null);assert.equal(item.operatorDisplayName,null);assert.equal(item.grantId,grant.id);
 assert.equal(item.attribution.aiAccountId,aiAccountId);assert.equal(item.attribution.aiAccountName,'合成运维执行账户');assert.equal(item.attribution.taskId,taskId);assert.equal(item.attribution.taskReadable,true);assert.equal(item.attribution.initiatorKind,'schedule');assert.equal(item.attribution.decisionSource,'unknown','mode=ai is not evidence of an actual model judgment');assert.equal(item.result.state,'draft');
 assert.equal(auditItem(item).actorKind,'operations-ai-service');assert.equal(auditItem(item).attribution.taskId,taskId);assert.equal(JSON.stringify(page).includes(body),false);
 // This is a synthetic Native-call contract, not a model invocation: only a
 // persisted original call plus its actual matching run can establish source.
 const callId=randomUUID(),saveId=randomUUID(),nativeRunId='synthetic-native-audit-run';
 await f.db.query('UPDATE operations_autonomy_tasks_v1 SET native_run_id=$3 WHERE endpoint=$1 AND id=$2',[f.endpoint,taskId,nativeRunId]);
 await f.db.query("INSERT INTO operations_autonomy_tool_calls_v1(endpoint,task_id,call_id,tool,arguments,operation_id,state,created_at,updated_at) VALUES($1,$2,$3,'execute-operation','{}',$4,'started',$5,$5)",[f.endpoint,taskId,callId,saveId,new Date(f.now()*1000)]);
 const unattributed=await transaction(f.db,db=>authority.bindDutyAuditSourceWithin(db,actor,{callId,operationId:saveId,nativeRunId:'other-run'}));assert.equal(authority.dutyContext(unattributed).auditSource,undefined);
 const nativeActor=await transaction(f.db,db=>authority.bindDutyAuditSourceWithin(db,actor,{callId,operationId:saveId,nativeRunId}));assert.equal(authority.dutyContext(nativeActor).auditSource.kind,'ai');
 await assert.rejects(transaction(f.db,db=>authority.bindDutyAuditSourceWithin(db,{...actor},{callId,operationId:saveId,nativeRunId})),{code:'business_admin_denied'});
 assert.equal((await tools.executeDutyOperation({actor:nativeActor,operationId:saveId,arguments:{kind:'message-draft-save',targetId:operationId,config:request.config},authorizeOperation})).effectState,'completed');
 const nativeAudit=(await businessAdmin.audit(admin,{action:'notice-save'})).items.find(x=>x.operationId===saveId);assert.equal(nativeAudit.attribution.decisionSource,'ai');assert.equal(nativeAudit.attribution.decisionBasis,'verified-native-tool');assert.equal(nativeAudit.result.version,2);
 await f.db.query("UPDATE operations_autonomy_tasks_v1 SET native_run_id=NULL,mode='code' WHERE endpoint=$1 AND id=$2",[f.endpoint,taskId]);
 const noProof=await transaction(f.db,db=>authority.bindDutyAuditSourceWithin(db,actor,{callId,operationId:saveId}));assert.equal(authority.dutyContext(noProof).auditSource,undefined,'mode=code is not evidence of a rule evaluation');
 const ruleActor=await transaction(f.db,db=>authority.bindDutyAuditSourceWithin(db,actor,{callId,operationId:saveId,ruleSource:true}));assert.equal(authority.dutyContext(ruleActor).auditSource.kind,'code');
 // The human domain service write is real. Conversation/card confirmation
 // facts are explicit SQL fixtures; full management-session confirmation is
 // outside this serialized PGlite source-link test.
 const conversationId=randomUUID(),sessionId=randomUUID(),turnId=randomUUID(),prepareCall=randomUUID(),cardId=randomUUID(),humanOperationId=randomUUID(),at=new Date(f.now()*1000),nativeTurn='synthetic-human-preparation';
 await f.db.query("INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,created_at,ai_account_id) VALUES($1,$2,$3,'maintenance','synthetic-permission',$4,$5,$6)",[conversationId,f.endpoint,admin.operatorId,sessionId,at,aiAccountId]);
 await f.db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at,native_run_id) VALUES($1,$2,$3,$4,'synthetic-turn','accepted','{}',$5,$6)",[turnId,f.endpoint,conversationId,admin.operatorId,at,nativeTurn]);
 await f.db.query("INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'synthetic-prepare','prepare-operation','synthetic-digest','completed','{}',$6,$6)",[prepareCall,f.endpoint,conversationId,turnId,nativeTurn,at]);
 await f.db.query("INSERT INTO operations_autonomy_tasks_v1(id,endpoint,ai_account_id,domain,source,source_key,title,mode,state,model_state,business_state,configuration,prompt_version,plan_version,session_id,due_at,created_at,updated_at) VALUES($1,$2,$3,'maintenance','workbench',$4,'具体人工卡的原任务','human-ai','running','completed','not-started',$5,1,1,$6,$7,$7,$7)",[turnId,f.endpoint,aiAccountId,'workbench:'+turnId,JSON.stringify({externalWorkbench:{operatorId:admin.operatorId,turnOperationId:turnId}}),sessionId,at]);
 const humanResult=await messaging.save(admin,operationId,{operationId:humanOperationId,expectedVersion:2,expectedRevision:2,config:{...request.config,automation:{kind:'human-required',factsConfirmed:false}}},{authorize});assert.equal(humanResult.plan.state,'draft');
 await f.db.query("INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'maintenance',$7,'synthetic-card',$8,'completed',$9,$10,$10)",[cardId,f.endpoint,conversationId,turnId,prepareCall,admin.operatorId,humanOperationId,JSON.stringify({kind:'message-draft-save',target:{kind:'message-plan',id:operationId}}),JSON.stringify({operationId:humanOperationId,state:'completed',confirmationAttemptedAt:at.toISOString(),receipt:{planId:operationId,state:'draft',version:humanResult.plan.version,revision:humanResult.plan.revision}}),at]);
 const humanAudit=(await businessAdmin.audit(admin,{action:'notice-save'})).items.find(x=>x.operationId===humanOperationId);assert.equal(humanAudit.actorKind,'business-operator');assert.equal(humanAudit.attribution.cardId,cardId);assert.equal(humanAudit.attribution.taskId,turnId);assert.equal(humanAudit.attribution.decisionSource,'human-confirmed');assert.equal(humanAudit.attribution.initiatorOperatorId,admin.operatorId);assert.equal(humanAudit.result.version,3);
 const read=await businessAdmin.audit(admin,{action:'user-read'});assert.equal(read.items.find(x=>x.actorKind==='operations-ai-service').attribution.taskId,taskId,'a query with no operation ID keeps the same task');
 const scoped=await businessAdmin.audit(reader,{resourceId:taskId});assert.equal(scoped.items.some(x=>x.operationId===operationId),true);assert.equal(scoped.items.find(x=>x.operationId===operationId).attribution.taskReadable,false);await assert.rejects(businessAdmin.get(reader,f.people[0].accountId),{code:'operations_permission_denied'});
 const hidden=businessAuditMetadata({...raw,actor_context:{...raw.actor_context,body},audit_attribution:{...item.attribution,body},selection:{...raw.selection,body},result:{...raw.result,body}});assert.equal(JSON.stringify(hidden).includes(body),false);assert.equal(hidden.attribution.taskId,null,'unrecognized source fields do not establish a relationship');
 const before=Number((await f.db.query('SELECT count(*) AS n FROM business_admin_audit_v1 WHERE operation_id=$1',[operationId])).rows[0].n);assert.equal((await tools.executeDutyOperation({actor,operationId,arguments:request,authorizeOperation,reconcile:true})).effectState,'completed');assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM business_admin_audit_v1 WHERE operation_id=$1',[operationId])).rows[0].n),before);
 await permissions.saveAssignment(admin,{operationId:randomUUID(),id:assigned.id,expectedVersion:assigned.version,operatorId:reader.operatorId,roleId:auditRole.id,enabled:false},{authorize});await assert.rejects(businessAdmin.audit(reader),{code:'operations_permission_denied'});
 await f.db.exec('RESET ROLE');
});
