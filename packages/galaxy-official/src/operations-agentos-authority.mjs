import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {operationsPermissionCatalog} from './operations-permission-catalog.mjs';
import {agentOsDomains,agentOsCreateSchema,agentOsStateSchema,agentOsNativeAuthoritySchema,agentOsOperationIdSchema} from './shared/operations-agentos-schema.mjs';
import {automationResourceScope,automationScopeCapability} from './shared/operations-automation-scope.mjs';
import {OperationsAgentOsScope} from './operations-agentos-scope.mjs';
import {operationsAiUseAllowed,operationsAiUsePermission,operationsAiUseDomain,operationsAiWorkScope,withOperationsAiWork,bindOperationsAiUse,inheritOperationsAiUse} from './shared/operations-ai-use.mjs';
import {aiWorkCapabilities,aiWorkPreparation} from './operations/accounts/ai-work-schema.mjs';
import {aiActionDefinition} from './shared/operations-ai-action-registry.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const parse=(schema,value)=>{const p=schema.safeParse(value);if(!p.success)fail('invalid_operations_agentos_request',400);return p.data;};
const iso=seconds=>new Date(seconds*1000).toISOString();
const supported=new Set(['content.read','content.hide','content.restore']);
const humanOnly=new Set(operationsPermissionCatalog.filter(row=>row.humanOnly).map(row=>row.code));
const subset=(values,allowed)=>values.every(value=>allowed.includes(value));

// These actors are process-local attestations, not serializable bearer grants.
// JSON containing the same fields is never accepted by a business service.
export class OperationsAgentOsAuthority {
 #actors=new WeakSet();
 #callers=new WeakMap();
 #dutyActors=new WeakMap();
 #resolveWork=async(db,domain,{accountId,purpose})=>{
  if(!this.aiWorkAccounts)fail('operations_ai_work_unavailable',503);
  const current=await this.aiWorkAccounts.authorizationWithin(db,domain,{accountId});
  if(!current.enabled)fail('operations_ai_work_disabled');
  const cap=aiWorkCapabilities(domain,current.permissions),permissions=purpose==='conversation'?[]:purpose==='query'?cap.queryPermissions:purpose==='execution'?cap.autonomousPermissions:
   [...new Set(cap.queryPermissions.concat('chat-reports.materials.read',aiWorkPreparation.filter(entry=>cap.preparableKinds.includes(entry.kind)).flatMap(entry=>[entry.read].concat(entry.actions))).filter(code=>current.permissions.includes(code)))];
  return {...current,permissions,purpose};
 };
 constructor({db,endpoint,permissions,aiWorkAccounts=null,content=null,supportedActions=[],dutyAuthorizationWithin=null,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,permissions,aiWorkAccounts,content,dutyAuthorizationWithin,now});this.supported=new Set([...supported,...supportedActions]);this.scopes=new OperationsAgentOsScope({authority:this});if(permissions)permissions.aiServiceAuthority=this;}
 accepts(actor){return !!actor&&this.#actors.has(actor);}
 acceptsDuty(actor){return !!actor&&this.#dutyActors.has(actor);}
 dutyContext(actor){const context=this.#dutyActors.get(actor);if(!context)fail('business_admin_denied');return context;}
 dutyMetadata(actor){const context=this.dutyContext(actor);return{...structuredClone(Object.fromEntries(Object.entries(context).filter(([key])=>!['authorizeOperation','continuation'].includes(key)))),contextSchemaVersion:1,endpoint:this.endpoint};}
 async bindDutyAuditSourceWithin(db,actor,{callId,operationId,nativeRunId=null,ruleSource=false}={}){
  const context=this.dutyContext(actor),row=(await db.query(`SELECT t.native_run_id,t.mode FROM operations_autonomy_tasks_v1 t
   JOIN operations_autonomy_tool_calls_v1 c ON c.endpoint=t.endpoint AND c.task_id=t.id
   WHERE t.endpoint=$1 AND t.id=$2 AND t.ai_account_id=$3 AND c.call_id=$4 AND c.operation_id=$5`,
   [this.endpoint,context.taskId,context.aiAccountId,callId,operationId])).rows[0];
  // ruleSource is an internal call option, absent from the closed HTTP body.
  // The code consumer supplies it only after its actual rule evaluation.
  const kind=row&&typeof nativeRunId==='string'&&nativeRunId&&row.native_run_id===nativeRunId?'ai':
   row&&ruleSource===true&&!nativeRunId&&!row.native_run_id&&row.mode==='code'?'code':null;
  if(!kind)return this.dutyCurrentWithin(db,Object.freeze(Object.fromEntries(Object.entries(context).filter(([key])=>key!=='auditSource'))));
  return this.dutyCurrentWithin(db,Object.freeze({...context,auditSource:Object.freeze({kind,callId,operationId})}));
 }
 async continuationActorWithin(db,input){
  if(input?.contextSchemaVersion!==1||input.endpoint!==this.endpoint||!input?.operation?.operationId||!input.operation.permission||input.accessPurpose!=='execution'||typeof this.durableOperationAuthorizationWithin!=='function')fail('operations_ai_duty_operation_denied');
  const context=Object.freeze({...structuredClone(input),resourceIds:Object.freeze([...(input.resourceIds??[])]),operation:Object.freeze({...input.operation}),continuation:true});
  // Persisted metadata is not a credential. The server resolver must match
  // the exact approved record before any identity is minted or used again.
  const approved=await this.durableOperationAuthorizationWithin(db,context);if(approved?.allowed!==true)fail('operations_ai_duty_operation_denied');
  return this.dutyCurrentWithin(db,context);
 }
 async dutyActorWithin(db,{domain,aiAccountId,taskId,purpose,accessPurpose='query',planId,planVersion,delegationVersion=null,resourceIds=[]}={}){
  const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if(!agentOsDomains.includes(domain)||![aiAccountId,taskId,planId].every(uuid)||typeof purpose!=='string'||!purpose.trim()||purpose.length>120||!['query','prepare','execution'].includes(accessPurpose)||!Number.isSafeInteger(planVersion)||planVersion<1||!Array.isArray(resourceIds)||resourceIds.length>200||!resourceIds.every(uuid))fail('operations_agentos_scope_denied');
  const context=Object.freeze({domain,aiAccountId,taskId,purpose,accessPurpose,planId,planVersion,delegationVersion,resourceIds:Object.freeze([...resourceIds])});
  return this.dutyCurrentWithin(db,context);
 }
 async dutyCurrentWithin(db,context){
  if(db===this.db)return transaction(db,tx=>this.dutyCurrentWithin(tx,context));
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))',[this.endpoint]);
  const resolver=context.continuation?this.durableOperationAuthorizationWithin:this.dutyAuthorizationWithin;
  if(typeof resolver!=='function')fail('operations_ai_duty_unavailable',503);
  const task=await resolver(db,context);if(task?.allowed!==true)fail('operations_ai_duty_inactive',409);
  if(!this.aiWorkAccounts)fail('operations_ai_work_unavailable',503);
  const current=await this.aiWorkAccounts.authorizationWithin(db,context.domain,{accountId:context.aiAccountId});
  if(!current.enabled)fail('operations_ai_work_disabled');
  const capabilities=aiWorkCapabilities(context.domain,current.permissions),permissions=context.accessPurpose==='query'?capabilities.queryPermissions:context.accessPurpose==='execution'?capabilities.autonomousPermissions:
   [...new Set(capabilities.queryPermissions.concat('chat-reports.materials.read',aiWorkPreparation.filter(entry=>capabilities.preparableKinds.includes(entry.kind)).flatMap(entry=>[entry.read].concat(entry.actions))).filter(code=>current.permissions.includes(code)))];
  const actor={kind:'operations-ai-service',operatorId:'ai:'+current.accountId,role:null,endpoint:this.endpoint,aiAccountId:current.accountId,domain:context.domain,taskId:context.taskId,
   planId:context.planId,planVersion:context.planVersion,purpose:context.purpose,accessPurpose:context.accessPurpose,resourceIds:[...context.resourceIds],grantId:context.operation?.grantId??null,businessAuthorization:{version:'ai-service:'+current.accountId+':'+current.authorizationVersion+':'+context.planVersion,permissions}};
  this.#dutyActors.set(actor,context);return actor;
 }
 async requireDutyAction(actor,action,{db=this.db,purpose=null}={}){
  if(!this.acceptsDuty(actor))fail('business_admin_denied');
  let context=this.dutyContext(actor);if(purpose!==null){if(!['query','prepare','execution'].includes(purpose))fail('operations_agentos_scope_denied');context=Object.freeze({...context,accessPurpose:purpose});}
  const fresh=await this.dutyCurrentWithin(db,context);
  if(action!=='workbench.read'&&!fresh.businessAuthorization.permissions.includes(action))fail('operations_permission_denied');
  return fresh;
 }
 async bindDutyOperation(actor,operation,{db=this.db,authorizeOperation}={}){
  if(!this.acceptsDuty(actor)||typeof authorizeOperation!=='function'||!operation?.permission||!operation?.operationId)fail('operations_ai_duty_operation_denied');
  const current=await this.requireDutyAction(actor,operation.permission,{db,purpose:'execution'}),definition=aiActionDefinition(operation.permission);
  if(!definition?.autonomous||definition.humanOnly)fail('operations_agentos_human_review_required',409);
  const authorization=await authorizeOperation(db,{actor:current,...operation});if(authorization?.allowed!==true)fail('operations_ai_duty_operation_denied');
  const context=Object.freeze({...this.dutyContext(current),operation:Object.freeze({...operation,...Object.fromEntries(['grantId','grantVersion','strategyId','strategyVersionId'].filter(key=>authorization[key]!==undefined).map(key=>[key,authorization[key]]))}),authorizeOperation});
  return this.dutyCurrentWithin(db,context);
 }
 async requireDutyOperation(actor,required,selection,{db=this.db,action=null}={}){
  const context=this.dutyContext(actor),bound=context.operation;if(!bound||context.accessPurpose!=='execution'||required.some(code=>code!==bound.permission))fail('operations_ai_duty_operation_denied');
  const batch=bound.request?.kind==='public-content-batch',id=selection?.id??selection?.resourceId??selection?.accountId??selection?.planId??(batch?selection?.items?.[0]?.id:null)??null;
  if(bound.targetId&&id!==bound.targetId||selection?.operationId&&selection.operationId!==bound.operationId)fail('operations_ai_duty_operation_denied');
  const command=selection?.command??selection??{};
  for(const [key,value] of Object.entries(bound.command??{}))if(Object.hasOwn(command,key)&&!isDeepStrictEqual(command[key],value))fail('operations_ai_duty_operation_denied');
  if(bound.permission==='feedback.update'&&Object.hasOwn(selection??{},'noteHash')&&selection.noteHash!==(bound.command?.note?createHash('sha256').update(bound.command.note).digest('hex'):null))fail('operations_ai_duty_operation_denied');
  if(batch&&!isDeepStrictEqual(selection?.items,bound.command?.items))fail('operations_ai_duty_operation_denied');
  const current=await this.requireDutyAction(actor,bound.permission,{db}),authorization=context.continuation?
   await this.durableOperationAuthorizationWithin(db,{...context,businessAction:action,selection}):
   await context.authorizeOperation(db,{actor:current,...bound,businessAction:action,selection});
  if(authorization?.allowed!==true)fail('operations_ai_duty_operation_denied');return current;
 }
 mint(row,permissions,resourceIds=row.resource_ids,caller=null){const actor={kind:'operations-executor',operatorId:'executor:'+row.id,role:null,endpoint:this.endpoint,
  executionId:row.id,grantId:row.grant_id,executorKind:row.executor_kind,mode:row.mode,onBehalfOf:row.operator_id,
  resourceIds:[...resourceIds],businessAuthorization:{version:String(row.grant_version),permissions:[...permissions]}};this.#actors.add(actor);if(caller)this.#callers.set(actor,caller);return actor;}
 callerFor(id,{from=null,caller=null}={}){
  if(from){if(!this.accepts(from)||from.executionId!==id)fail('business_admin_denied');const inherited=this.#callers.get(from)??null;if(caller&&caller!==inherited)fail('business_admin_denied');caller=inherited;}
  if(caller&&!operationsAiWorkScope(caller))fail('business_admin_denied');return caller;
 }
 async currentWithin(db,id,{active=true,from=null,caller=null}={}){
  caller=this.callerFor(id,{from,caller});
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))',[this.endpoint]);
  const row=(await db.query('SELECT * FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE',[this.endpoint,id])).rows[0];
  if(!row||row.state==='stopped'||active&&row.state!=='active')fail('operations_agentos_execution_inactive',409);
  const grant=(await db.query('SELECT * FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,row.grant_id])).rows[0];
  if(!grant?.enabled||grant.version!==row.grant_version||grant.mode!==row.mode||grant.executor_kind!==row.executor_kind)fail('operations_agentos_authority_changed');
  const scope=automationResourceScope(grant);
  if(scope.kind==='unresolved'&&row.actions.length)fail('operations_agentos_scope_unresolved');
  if(scope.kind==='selected'&&!subset(row.resource_ids,scope.resourceIds))fail('operations_agentos_scope_denied');
  if(row.actions.some(code=>humanOnly.has(code)||!this.supported.has(code)))fail('operations_agentos_action_unavailable');
  let allowed=grant.permissions.filter(code=>row.actions.includes(code));
  if(row.executor_kind==='ai'){
   if(!this.aiWorkAccounts)fail('operations_ai_work_unavailable',503);
   if(!row.ai_account_id||grant.ai_account_id!==row.ai_account_id)fail('operations_ai_work_unassigned');
   const current=await this.aiWorkAccounts.executionRoleWithin(db,{domain:row.domain,aiAccountId:row.ai_account_id,actions:row.actions});
   allowed=allowed.filter(code=>current.permissions.includes(code));
  }
  if(row.mode==='assisted'){
   const person={kind:'business-operator',operatorId:row.operator_id,endpoint:this.endpoint};
   const effective=await this.permissions.effective(person,{db});allowed=allowed.filter(code=>effective.permissions.includes(code));
   if(!effective.permissions.includes('workbench.read'))fail('operations_permission_denied');
   if(row.executor_kind==='ai'&&!operationsAiUseAllowed(effective.permissions,row.domain))fail('operations_agentos_ai_use_denied');
  }
  if(caller){
   if(row.executor_kind!=='ai'||operationsAiWorkScope(caller).accountId!==row.ai_account_id)fail('operations_ai_work_unassigned');
   const current=await this.human(caller,{db,domain:row.domain,purpose:'execution'});
   allowed=allowed.filter(code=>current.businessAuthorization.permissions.includes(code));
  }
  if(!subset(row.actions,allowed))fail('operations_agentos_authority_changed');
  if(scope.kind==='eligible'&&row.actions.length){
   const qualified=await this.scopes.qualify(db,{domain:row.domain,actions:row.actions,resourceIds:row.resource_ids});
   const refs=(await db.query('SELECT target_kind,target_id,source_version FROM operations_agentos_source_refs_v1 WHERE execution_id=$1',[row.id])).rows;
   if(qualified.sourceRefs.some(ref=>!refs.some(stored=>stored.target_kind===ref.kind&&stored.target_id===ref.id&&stored.source_version===ref.version)))fail('operations_agentos_source_changed',409);
  }
  return {row,permissions:allowed};
 }
 async actor(id,{db=this.db,resourceIds=null,active=true,from=null,caller=null}={}){
  caller=this.callerFor(id,{from,caller});
  if(db===this.db)return transaction(db,tx=>this.actor(id,{db:tx,resourceIds,active,caller}));
  const current=await this.currentWithin(db,id,{active,caller});
  if(resourceIds&&(!resourceIds.length||!subset(resourceIds,current.row.resource_ids)))fail('operations_agentos_scope_denied');
  return this.mint(current.row,current.permissions,resourceIds??current.row.resource_ids,caller);
 }
 async requireAction(actor,action,{db=this.db}={}){
  if(!this.accepts(actor)||!this.supported.has(action)||humanOnly.has(action))fail('business_admin_denied');
  const fresh=await this.actor(actor.executionId,{db,resourceIds:actor.resourceIds,active:action!=='content.read',from:actor});
  if(!fresh.businessAuthorization.permissions.includes(action))fail('operations_permission_denied');return fresh;
 }
 async requireOperation(actor,required,selection,{db=this.db}={}){
  const ids=[selection?.id,selection?.resourceId,selection?.accountId].filter(Boolean);
  if(!ids.length||!subset(ids,actor.resourceIds))fail('operations_agentos_scope_denied');
  let fresh=actor;for(const action of required)fresh=await this.requireAction(fresh,action,{db});return fresh;
 }
 view(row){return {id:row.id,domain:row.domain,grantId:row.grant_id,grantVersion:row.grant_version,executorKind:row.executor_kind,mode:row.mode,
  operatorId:row.operator_id,createdBy:row.created_by,actions:row.actions,resourceIds:row.resource_ids,state:row.state,revision:row.revision,sessionId:row.session_id,
  hasPreparedCommand:!!row.prepared_command,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};}
 async human(operator,{db=this.db,action='workbench.read',authorize=null,domain=null,purpose=null}={}){
  if(this.acceptsDuty(operator)){
   const context=this.dutyContext(operator);if(domain!==null&&domain!==context.domain)fail('operations_agentos_domain_mismatch');
   if(authorize){const fresh=await authorize();if(!this.acceptsDuty(fresh)||fresh.taskId!==operator.taskId||fresh.aiAccountId!==operator.aiAccountId)fail('business_admin_denied');operator=fresh;}
   return this.requireDutyAction(operator,action,{db,purpose});
  }
  const original=operator;
  if(authorize){operator=await authorize();if(operator?.kind!=='business-operator'||operator.operatorId!==original.operatorId||operator.endpoint!==this.endpoint)fail('business_admin_denied');operator=inheritOperationsAiUse(original,operator);}
  // Identity/context callbacks may themselves read current conversations. Do
  // not hold a connection while asking them for a fresh identity. The actual
  // human/AI role intersection below still uses one transaction and lock.
  if(db===this.db)return transaction(db,tx=>this.human(operator,{db:tx,action,domain,purpose}));
  const bound=operationsAiUseDomain(operator);if(bound&&domain!==null&&bound!==domain)fail('operations_agentos_domain_mismatch');
  domain=domain??bound;
  if(purpose&&domain===null)fail('operations_agentos_scope_denied');
  if(purpose&&operationsAiWorkScope(operator))operator=withOperationsAiWork(operator,{purpose});
  let actor=await this.permissions.requireAction(operator,domain===null?action:'workbench.read',{db});
  if(domain!==null){
   const permission=operationsAiUsePermission(domain);if(!permission)fail('invalid_operations_agentos_request',400);
   try{actor=await this.permissions.requireAction(actor,permission,{db});}
   catch(error){if(error.code==='operations_permission_denied')fail('operations_agentos_ai_use_denied');throw error;}
   actor=bindOperationsAiUse(actor,domain);
   if(!this.aiWorkAccounts)fail('operations_ai_work_unavailable',503);
   const existing=operationsAiWorkScope(actor),current=existing?await this.aiWorkAccounts.authorizationWithin(db,domain,{accountId:existing.accountId}):await this.aiWorkAccounts.assertEnabledWithin(db,domain);
   if(!current.enabled)fail('operations_ai_work_disabled');
   actor=withOperationsAiWork(actor,{accountId:current.accountId,purpose:purpose??existing?.purpose??'conversation',resolve:this.#resolveWork});
   actor=await this.permissions.requireAction(actor,action,{db});
  }
  return actor;
 }
 async create(operator,input,{authorize}={}){
  const x=parse(agentOsCreateSchema,input);if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  return transaction(this.db,async db=>{
   let actor=await this.human(operator,{db,authorize});
   await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))',[this.endpoint]);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))',[this.endpoint+':'+x.operationId]);
   const old=(await db.query('SELECT * FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId])).rows[0];
   if(old){if(old.operator_id!==actor.operatorId||old.kind!=='create'||!isDeepStrictEqual(old.input,x))fail('operations_agentos_operation_conflict',409);await this.ownedWithin(db,actor,old.execution_id);return {...old.result,operationId:x.operationId,kind:'create',executionId:old.execution_id,preparedAction:old.input.preparedCommand??null,replayed:true};}
   const grant=(await db.query('SELECT * FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.grantId])).rows[0];
   if(!grant?.enabled||grant.version!==x.expectedGrantVersion)fail('operations_agentos_authority_changed',409);
   if(grant.executor_kind==='ai'){
    actor=await this.human(actor,{db,domain:x.domain,purpose:'execution'});
    if(!grant.ai_account_id||operationsAiWorkScope(actor).accountId!==grant.ai_account_id)fail('operations_ai_work_unassigned');
    await this.aiWorkAccounts.executionRoleWithin(db,{domain:x.domain,aiAccountId:grant.ai_account_id,actions:x.actions});
   }
   if(grant.mode==='automatic')await this.human(operator,{db,action:'permissions.automation.write'});
   const scope=automationResourceScope(grant);
   if(scope.kind==='unresolved'&&x.actions.length)fail('operations_agentos_scope_unresolved');
   if(scope.kind==='selected'&&!subset(x.resourceIds,scope.resourceIds)||x.actions.some(code=>!this.supported.has(code)||humanOnly.has(code))||!subset(x.actions,grant.permissions))fail('operations_agentos_scope_denied');
   for(const code of x.actions)await this.permissions.requireAction(actor,code,{db});
   if(x.actions.length&&!x.resourceIds.length)fail('operations_agentos_scope_required',400);
   if(x.actions.length&&x.domain!=='governance')fail('operations_agentos_domain_mismatch',400);
   if(x.preparedCommand){const command=x.preparedCommand;
    if(!x.resourceIds.includes(command.targetId)||!x.actions.includes('content.read')||!x.actions.includes(command.input.kind==='hide'?'content.hide':'content.restore'))fail('operations_agentos_scope_denied');
   }
   const qualified=scope.kind==='eligible'&&x.actions.length?await this.scopes.qualify(db,{domain:x.domain,actions:x.actions,resourceIds:x.resourceIds}):{sourceRefs:[]};
   const id=randomUUID(),at=iso(this.now()),row=(await db.query(`INSERT INTO operations_agentos_executions_v1
    (id,endpoint,grant_id,grant_version,domain,executor_kind,mode,operator_id,created_by,actions,resource_ids,state,revision,session_id,prepared_command,created_at,updated_at,ai_account_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',1,$12,$13,$14,$14,$15) RETURNING *`,
    [id,this.endpoint,grant.id,grant.version,x.domain,grant.executor_kind,grant.mode,grant.mode==='assisted'?actor.operatorId:null,actor.operatorId,x.actions,x.resourceIds,randomUUID(),x.preparedCommand?JSON.stringify(x.preparedCommand):null,at,grant.executor_kind==='ai'?grant.ai_account_id:null])).rows[0];
   for(const ref of qualified.sourceRefs)await db.query('INSERT INTO operations_agentos_source_refs_v1(execution_id,target_kind,target_id,source_version) VALUES($1,$2,$3,$4)',[id,ref.kind,ref.id,ref.version]);
   const result={operationId:x.operationId,kind:'create',executionId:id,execution:this.view(row),preparedAction:x.preparedCommand??null,replayed:false};
   await db.query(`INSERT INTO operations_agentos_commands_v1(id,endpoint,execution_id,kind,operator_id,input,result,created_at) VALUES($1,$2,$3,'create',$4,$5,$6,$7)`,[x.operationId,this.endpoint,id,actor.operatorId,JSON.stringify(x),JSON.stringify(result),at]);
   return result;
  });
 }
 async ownedWithin(db,operator,id){let actor=await this.human(operator,{db});
  const row=(await db.query('SELECT * FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,id])).rows[0];
  if(!row||row.created_by!==actor.operatorId)fail('operations_agentos_execution_not_found',404);
  if(row.executor_kind==='ai'){
   actor=await this.human(actor,{db,domain:row.domain,purpose:'execution'});
   if(!row.ai_account_id||operationsAiWorkScope(actor).accountId!==row.ai_account_id)fail('operations_ai_work_unassigned');
   await this.aiWorkAccounts.executionRoleWithin(db,{domain:row.domain,aiAccountId:row.ai_account_id,actions:row.actions});
   if(!subset(row.actions,actor.businessAuthorization.permissions))fail('operations_permission_denied');
  }
  return {row,actor};
 }
 async list(operator){return transaction(this.db,async db=>{const actor=await this.human(operator,{db});const rows=(await db.query('SELECT * FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND created_by=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[this.endpoint,actor.operatorId])).rows;
  const items=[];for(const row of rows){try{await this.ownedWithin(db,actor,row.id);items.push(this.view(row));}catch(error){if(![403,409].includes(error.status))throw error;}}
  return {items,checkedAt:this.now(),readExpiresAt:this.now()+30};});}
 async options(operator){return transaction(this.db,async db=>{const actor=await this.human(operator,{db});
  if(!agentOsDomains.some(domain=>operationsAiUseAllowed(actor.businessAuthorization.permissions,domain)))return {items:[],checkedAt:this.now(),readExpiresAt:this.now()+30};
  const positions=[];for(const domain of agentOsDomains){if(!operationsAiUseAllowed(actor.businessAuthorization.permissions,domain))continue;try{positions.push(await this.human(actor,{db,domain,purpose:'execution'}));}catch(error){if(![403,409].includes(error.status))throw error;}}
  if(!positions.some(person=>person.businessAuthorization.permissions.some(code=>this.supported.has(code))))return{items:[],checkedAt:this.now(),readExpiresAt:this.now()+30};
  const rows=(await db.query("SELECT * FROM operations_automation_grants_v1 WHERE endpoint=$1 AND enabled AND mode='assisted' AND executor_kind='ai' ORDER BY created_at,id",[this.endpoint])).rows;
  const items=rows.flatMap(row=>{const person=positions.find(value=>operationsAiWorkScope(value).accountId===row.ai_account_id);if(!person)return[];
   const actions=row.permissions.filter(code=>this.supported.has(code)&&person.businessAuthorization.permissions.includes(code));
   return actions.length?[{id:row.id,name:row.name,version:row.version,domain:operationsAiUseDomain(person),mode:row.mode,resourceIds:row.resource_ids,resourceScope:automationResourceScope(row),scopeCapability:automationScopeCapability(row),actions}]:[];});
  return {items,checkedAt:this.now(),readExpiresAt:this.now()+30};
 });}
 async get(operator,id){return transaction(this.db,async db=>{const {row}=await this.ownedWithin(db,operator,id);return {execution:this.view(row),preparedAction:row.prepared_command??null,checkedAt:this.now(),readExpiresAt:this.now()+30};});}
 async operation(operator,operationId){
  const id=parse(agentOsOperationIdSchema,operationId);
  return transaction(this.db,async db=>{
   const actor=await this.human(operator,{db}),command=(await db.query('SELECT * FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,id])).rows[0];
   if(!command)return{operationId:id,state:'not-recorded',kind:null,checkedAt:this.now(),readExpiresAt:this.now()+30};
   if(command.operator_id!==actor.operatorId)fail('operations_agentos_operation_not_found',404);
   const {row}=await this.ownedWithin(db,actor,command.execution_id);
   await this.human(operator,{db});
   return{operationId:id,state:'recorded',kind:command.kind,executionId:row.id,execution:this.view(row),preparedAction:row.prepared_command??null,
    runId:typeof command.result?.runId==='string'?command.result.runId:null,
    commandState:['dispatching','accepted','unknown','not-started'].includes(command.result?.state)?command.result.state:null,
    checkedAt:this.now(),readExpiresAt:this.now()+30};
  });
 }
 async change(operator,id,input,{authorize}={}){const x=parse(agentOsStateSchema,input);if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  return transaction(this.db,async db=>{await this.human(operator,{db,authorize});const {actor}=await this.ownedWithin(db,operator,id);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))',[this.endpoint+':'+x.operationId]);
   const old=(await db.query('SELECT * FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId])).rows[0];
   if(old){if(old.operator_id!==actor.operatorId||old.execution_id!==id||!isDeepStrictEqual(old.input,x))fail('operations_agentos_operation_conflict',409);return {...old.result,operationId:x.operationId,kind:x.kind,executionId:id,replayed:true};}
   const row=(await db.query('SELECT * FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE',[this.endpoint,id])).rows[0];
   if(row.revision!==x.expectedRevision||row.state==='stopped')fail('operations_agentos_execution_changed',409);
   if(x.kind==='resume')await this.currentWithin(db,id,{active:false});
   const state=x.kind==='pause'?'paused':x.kind==='stop'?'stopped':'active';
   const saved=(await db.query('UPDATE operations_agentos_executions_v1 SET state=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING *',[this.endpoint,id,state,iso(this.now())])).rows[0];
   const result={operationId:x.operationId,kind:x.kind,executionId:id,execution:this.view(saved),replayed:false};await db.query('INSERT INTO operations_agentos_commands_v1(id,endpoint,execution_id,kind,operator_id,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[x.operationId,this.endpoint,id,x.kind,actor.operatorId,JSON.stringify(x),JSON.stringify(result),iso(this.now())]);return result;
  });
 }
 async nativeAuthorization(input){const x=parse(agentOsNativeAuthoritySchema,input);return transaction(this.db,async db=>{
  const {row}=await this.currentWithin(db,x.executionId,{active:x.operation==='run'}),resources=['galaxy-'+row.domain,'galaxy-prepared-review'];
  if(x.resourceType&&x.resourceType!=='agents'&&x.resourceType!=='workflows'||x.resourceId&&!resources.includes(x.resourceId))fail('operations_agentos_domain_mismatch');
  return {allowed:true,resourceIds:resources,execution:this.view(row)};
 });}
}
