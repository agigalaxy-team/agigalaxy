import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {agentOsDomains,agentOsRunSchema} from "../../shared/operations-agentos-schema.mjs";
import {operationsAiWorkScope} from "../../shared/operations-ai-use.mjs";
import {conversationPriorReadReceipt} from "./tool-evidence.mjs";
import {coalescedConversationEvents} from "./conversation-stream.mjs";
import {agentOsQueryAccess} from "../../shared/operations-agentos-query-access.mjs";
import {workbenchRunFact,workbenchCardFact} from "./duty-workbench.mjs";
import {conversationOperationReceipts} from "./operation-receipts.mjs";

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const parse=(schema,input)=>{const value=schema.safeParse(input);if(!value.success)fail('invalid_operations_agentos_request',400);return value.data;};
const hash=value=>createHash('sha256').update(value).digest('hex');
const permissionKey=actor=>hash(JSON.stringify([actor.businessAuthorization.version,[...actor.businessAuthorization.permissions].sort((a,b)=>a<b?-1:a>b?1:0)]));
const nativeSchema=z.strictObject({conversationId:z.uuid(),operation:z.enum(['read','run']),resourceType:z.enum(['agents','workflows']).nullable().optional(),resourceId:z.string().min(1).max(100).nullable().optional()});
const conversationRunSchema=agentOsRunSchema.extend({taskId:z.uuid().optional(),retryOfOperationId:z.uuid().optional()});
const turnDigest=x=>hash(x.retryOfOperationId?JSON.stringify([x.message,x.taskId??null,x.retryOfOperationId]):x.taskId?JSON.stringify([x.message,x.taskId]):x.message);
const rolePromptSchema=z.strictObject({version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),text:z.string().max(16000)});
const blocks={overview:['communityReports','chatReports','sections','resources','files','jobs','feedback','search'],governance:['communityReports','chatReports','sections','resources','files','feedback'],messaging:['jobs'],discovery:['sections','search'],maintenance:['files','jobs','search']};
const countFields={communityReports:['pending','total'],chatReports:['pending','total'],sections:['active','archived'],resources:['projects','methods'],files:['scanPending','scanFailed','cleanupPending','cleanupFailed','cleanupResultUnknown'],jobs:['failed'],feedback:['total','pending','processing','unclassified'],search:['failed']};
const numeric=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const domainAction=(domain,action)=>domain==='overview'||(domain==='governance'?/^(?:community-|feedback-|chat-report|resources-|file-)/.test(action):domain==='discovery'?/^(?:search-|recommendations\.)/.test(action):false);

// This projection intentionally cannot carry operators, grants, private prose,
// case materials, URLs or the summary's obsolete static AI connection state.
export function conversationSummary(value,domain,permissions=[]){
 const result={domain,checkedAt:Number.isSafeInteger(value?.checkedAt)?value.checkedAt:null,readExpiresAt:Number.isSafeInteger(value?.readExpiresAt)?value.readExpiresAt:null,basis:{counts:'current-permitted-workbench-snapshot',availability:'summary-block-only-not-query-capability',recentChanges:'domain-subset-of-latest-12-operations-not-full-day'},countScopes:{search:'search-index-recovery-backlog-not-search-quality-analytics'},availability:{},counts:{},recentChanges:[]};
 for(const key of blocks[domain]){
  const available=value?.availability?.[key];result.availability[key]=['available','not-authorized'].includes(available)?available:'unknown';
  result.counts[key]=result.availability[key]==='available'&&value?.[key]?Object.fromEntries(countFields[key].map(field=>[field,numeric(value[key][field])])):null;
 }
 if(['overview','governance','discovery'].includes(domain)){
  result.availability.recentOperations=value?.availability?.recentOperations==='available'?'available':value?.availability?.recentOperations==='not-authorized'?'not-authorized':'unknown';
  if(result.availability.recentOperations==='available')result.recentChanges=(value.recentOperations??[]).slice(0,12).filter(row=>typeof row.action==='string'&&/^[a-z0-9.-]{1,100}$/.test(row.action)&&domainAction(domain,row.action)&&typeof row.createdAt==='string'&&Number.isFinite(Date.parse(row.createdAt))).map(row=>({action:row.action,createdAt:row.createdAt}));
 }
 const canReadAutonomy=permissions.includes('autonomy.read');
 result.availability.autonomy=!canReadAutonomy?'not-authorized':value?.availability?.ai==='available'&&value?.autonomy?'available':'unavailable';
 if(result.availability.autonomy==='available'){
  const source=value.autonomy,knownDomains=new Set(agentOsDomains),states=new Set(['queued','running','waiting-human','paused','completed','failed','unknown','stopped']),sources=new Set(['workbench','routine','event','recovery']),uuid=id=>z.uuid().safeParse(id).success;
  const taskRows=rows=>(Array.isArray(rows)?rows:[]).slice(0,20).filter(row=>uuid(row.id)&&knownDomains.has(row.domain)&&states.has(row.state)&&sources.has(row.source)).map(row=>({id:row.id,domain:row.domain,source:row.source,state:row.state,modelState:['not-started','pending','running','completed','paused','failed','unknown','cancelled'].includes(row.modelState)?row.modelState:null,businessState:['not-started','completed','no-action','waiting-human','failed','unknown','cancelled'].includes(row.businessState)?row.businessState:null,updatedAt:typeof row.updatedAt==='string'&&Number.isFinite(Date.parse(row.updatedAt))?row.updatedAt:null,href:'/admin/operations/ai-runs?task='+encodeURIComponent(row.id)}));
  result.autonomy={basis:'current-permitted-autonomy-snapshot-recorded-tasks-only',checkedAt:numeric(source.checkedAt),readExpiresAt:numeric(source.readExpiresAt),summary:Object.fromEntries(['enabledAccounts','healthyAccounts','active','queued','waitingHuman','failed','unknown','businessCompleted','expected','completed','late','backlog'].map(key=>[key,numeric(source.summary?.[key])])),
   accounts:(Array.isArray(source.accounts)?source.accounts:[]).filter(row=>knownDomains.has(row.domain)).map(row=>({domain:row.domain,enabled:row.config?.enabled===true,health:['pending','healthy','attention','unavailable','blocked','unknown'].includes(row.health)?row.health:'unknown',lastValidAt:typeof row.lastValidAt==='string'&&Number.isFinite(Date.parse(row.lastValidAt))?row.lastValidAt:null,nextDueAt:typeof row.nextDueAt==='string'&&Number.isFinite(Date.parse(row.nextDueAt))?row.nextDueAt:null})),
   recentTasks:taskRows(source.recentTasks),humanTasks:taskRows(source.humanTasks),exceptions:taskRows(source.exceptions)};
 }
 return result;
}

export class AgentOsConversations{
 constructor({authority,client,summaryForConversation=null}){Object.assign(this,{authority,client,summaryForConversation,db:authority.db,endpoint:authority.endpoint,now:authority.now});}
 async linkWorkbenchWithin(db,row,operationId,taskId=null){
  if(taskId){
   if(typeof this.autonomy?.bindWorkbenchTaskWithin!=='function')fail('operations_autonomy_workbench_not_ready',503);
   return this.autonomy.bindWorkbenchTaskWithin(db,{taskId,operatorId:row.operator_id,conversationId:row.id,
    sessionId:row.session_id,domain:row.domain,aiAccountId:row.ai_account_id,turnOperationId:operationId});
  }
  if(typeof this.autonomy?.linkWorkbenchWithin!=='function')return;
  return this.autonomy.linkWorkbenchWithin(db,{operationId,domain:row.domain,aiAccountId:row.ai_account_id,
   conversationId:row.id,sessionId:row.session_id,operatorId:row.operator_id,modelState:'not-started'});
 }
 async updateWorkbenchWithin(db,operationId,fact){
  if(typeof this.autonomy?.updateWorkbenchWithin!=='function')return;
  // The original native ACK/card result remains authoritative if a new
  // projection fails. A savepoint keeps that committed source transaction
  // usable; original-source reads and the common monitor reconcile it later.
  await db.query('SAVEPOINT galaxy_workbench_projection');
  try{
   const command=(await db.query('SELECT result FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,operationId])).rows[0];
   const taskId=command?.result?.taskId;
   const result=await this.autonomy.updateWorkbenchWithin(db,{operationId:z.uuid().safeParse(taskId).success?taskId:operationId,turnOperationId:operationId,...fact});await db.query('RELEASE SAVEPOINT galaxy_workbench_projection');return result;
  }
  catch{
   await db.query('ROLLBACK TO SAVEPOINT galaxy_workbench_projection');await db.query('RELEASE SAVEPOINT galaxy_workbench_projection');
   try{process.stderr.write(JSON.stringify({event:'operations_autonomy_projection_unavailable',component:'api',stage:'workbench',operationId,time:new Date(this.now()*1000).toISOString()})+'\n');}catch{}
   return null;
  }
 }
 async boundedTaskWithin(db,row,command){
  const taskId=command?.result?.taskId;if(!taskId)return null;
  if(!z.uuid().safeParse(taskId).success||command.operator_id!==row.operator_id||command.conversation_id!==row.id)fail('operations_autonomy_workbench_scope_denied');
  return this.linkWorkbenchWithin(db,row,command.id,taskId);
 }
 async boundedTaskFor(actor,context){
  if(!context)return null;
  const {row}=await this.current(context.conversationId,{operator:actor});
  return transaction(this.db,async db=>{
   const command=(await db.query('SELECT * FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4',[this.endpoint,context.turnId,row.id,actor.operatorId])).rows[0];
   return this.boundedTaskWithin(db,row,command);
  });
 }
 async assertBoundedProposal(conversationId,turnId,proposal,{db=this.db}={}){
  const source=(await db.query('SELECT result FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3',[this.endpoint,turnId,conversationId])).rows[0];
  if(!source?.result?.taskId)return null;
  // The outer confirmation checks complete conversation/source validity.
  // In a business transaction, renew identity and task bounds on that same
  // connection; a second global pool lease would deadlock serialized stores.
  const row=(db===this.db?await this.current(conversationId):await this.currentWithin(db,conversationId)).row;
  const check=async db=>{
   const command=(await db.query('SELECT * FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4',[this.endpoint,turnId,row.id,row.operator_id])).rows[0];
   const task=await this.boundedTaskWithin(db,row,command);if(!task)return null;
   if(!Array.isArray(task.actions)||!task.actions.includes(proposal.requiredAction))fail('operations_autonomy_workbench_scope_denied');
   const scope=task.resourceScope;
   const targets=proposal.kind==='public-content-batch'?proposal.request?.items?.map(item=>item.id):[proposal.target?.id];
   if(!scope||!['all','eligible','selected'].includes(scope.kind)||scope.kind==='selected'&&(!task.resourceIds?.length||!targets?.length||targets.some(id=>!task.resourceIds.includes(id))))fail('operations_autonomy_workbench_scope_denied');
   return task;
  };
  return db===this.db?transaction(db,check):check(db);
 }
 async syncWorkbenchCardWithin(db,row){
  if(typeof this.autonomy?.updateWorkbenchWithin!=='function')return;
  const current=(await db.query('SELECT * FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND id=$2 AND operator_id=$3 AND turn_id=$4',[this.endpoint,row.id,row.operator_id,row.turn_id])).rows[0];
  const fact=workbenchCardFact(current);if(fact)return this.updateWorkbenchWithin(db,current.turn_id,fact);
 }
 async syncWorkbenchRuns(row,runs){
  if(typeof this.autonomy?.updateWorkbenchWithin!=='function')return;
  const matched=runs.filter(run=>z.uuid().safeParse(run.operationId).success&&typeof run.runId==='string');
  if(!matched.length)return;
  await transaction(this.db,async db=>{
   const saved=(await db.query(`SELECT id,native_run_id,result FROM operations_agentos_conversation_commands_v1
    WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=ANY($4::uuid[])
    AND result->>'cancelledOperationId' IS NULL`,[this.endpoint,row.id,row.operator_id,matched.map(run=>run.operationId)])).rows;
   const byId=new Map(saved.map(item=>[item.id,item]));
   for(const run of matched){if(run.status==='REGENERATED')continue;const source=byId.get(run.operationId);if(!source)continue;
    const known=source.native_run_id??source.result?.runId;
    if(known&&known!==run.runId)continue;
    await this.updateWorkbenchWithin(db,run.operationId,workbenchRunFact(run));
   }
  });
 }
 async bindRunOperations(row,runs){
  // Agno's accepted PENDING row precedes the final RunOutput metadata. Use
  // only our recorded native acknowledgement, scoped to this exact owner
  // and conversation, to associate its ongoing stream with the original turn.
  const ids=[...new Set(runs.filter(run=>run?.operationId==null&&typeof run.runId==='string').map(run=>run.runId))];if(!ids.length)return runs;
  const rows=(await this.db.query(`SELECT id,COALESCE(native_run_id,result->>'runId') AS run_id
   FROM operations_agentos_conversation_commands_v1
   WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3
   AND result->>'cancelledOperationId' IS NULL
   AND COALESCE(native_run_id,result->>'runId')=ANY($4::text[])`,[this.endpoint,row.id,row.operator_id,ids])).rows;
  const byRun=new Map();for(const item of rows)byRun.set(item.run_id,byRun.has(item.run_id)?null:item.id);
  return runs.map(run=>run?.operationId==null&&byRun.get(run.runId)?{...run,operationId:byRun.get(run.runId)}:run);
 }
 async cancellationActivities(row,runs){
  const ids=runs.map(run=>run.operationId).filter(id=>typeof id==='string'&&z.uuid().safeParse(id).success);if(!ids.length)return runs;
  const rows=(await this.db.query(`SELECT DISTINCT ON (result->>'cancelledOperationId') id,state,result->>'cancelledOperationId' AS turn_id,created_at
   FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3
   AND result->>'cancelledOperationId'=ANY($4::text[]) ORDER BY result->>'cancelledOperationId',created_at DESC,id DESC`,[this.endpoint,row.id,row.operator_id,ids])).rows;
  const byId=new Map(rows.map(item=>[item.turn_id,item]));
  return runs.map(run=>{const item=byId.get(run.operationId);return item&&['dispatching','accepted','unknown'].includes(item.state)?{...run,cancellation:{operationId:item.id,state:item.state,recordedAt:item.created_at instanceof Date?item.created_at.toISOString():null}}:run;});
 }
 async failureActivities(row,runs){
  const failed=runs.filter(run=>run?.status==='ERROR'&&typeof run.operationId==='string'&&z.uuid().safeParse(run.operationId).success);
  if(!failed.length)return runs;
  const ledger=(await this.db.query(`SELECT c.id,c.native_run_id,c.result->>'runId' AS receipt_run_id,
   EXISTS(SELECT 1 FROM operations_agentos_conversation_tool_calls_v1 t WHERE t.endpoint=c.endpoint AND t.conversation_id=c.conversation_id AND t.turn_id=c.id AND t.tool IN ('run-authorized-work','prepare-operation')) AS business_tool_seen,
   EXISTS(SELECT 1 FROM operations_agentos_conversation_cards_v1 p WHERE p.endpoint=c.endpoint AND p.conversation_id=c.conversation_id AND p.turn_id=c.id AND p.operator_id=c.operator_id) AS card_seen
   FROM operations_agentos_conversation_commands_v1 c
   WHERE c.endpoint=$1 AND c.conversation_id=$2 AND c.operator_id=$3 AND c.id=ANY($4::uuid[])`,[this.endpoint,row.id,row.operator_id,failed.map(run=>run.operationId)])).rows;
  const byId=new Map(ledger.map(item=>[item.id,item]));
  return runs.map(run=>{
   if(run?.status!=='ERROR')return run;
   const item=byId.get(run.operationId),bound=item&&typeof run.runId==='string'&&(item.native_run_id===run.runId||item.receipt_run_id===run.runId);
   return {...run,businessActivity:{state:!bound?'unknown':item.business_tool_seen===false&&item.card_seen===false?'not-started':'check-records',basis:'same-owner-turn-tool-and-card-ledger'}};
  });
 }
 async session(operator,domain,{create=false}={}){
  parse(z.enum(agentOsDomains),domain);
  const result=await transaction(this.db,async db=>{const actor=await this.authority.human(operator,{db,domain,purpose:'conversation'}),key=permissionKey(actor),accountId=operationsAiWorkScope(actor).accountId;
   let row=(await db.query('SELECT * FROM operations_agentos_conversations_v1 WHERE endpoint=$1 AND operator_id=$2 AND domain=$3 AND permission_key=$4 AND ai_account_id=$5 AND retired_at IS NULL',[this.endpoint,actor.operatorId,domain,key,accountId])).rows[0];
   if(!row&&create)row=(await db.query(`INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,created_at,ai_account_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(endpoint,operator_id,domain,permission_key) WHERE retired_at IS NULL DO NOTHING RETURNING *`,[randomUUID(),this.endpoint,actor.operatorId,domain,key,randomUUID(),new Date(this.now()*1000),accountId])).rows[0];
   if(!row&&create)row=(await db.query('SELECT * FROM operations_agentos_conversations_v1 WHERE endpoint=$1 AND operator_id=$2 AND domain=$3 AND permission_key=$4 AND ai_account_id=$5 AND retired_at IS NULL',[this.endpoint,actor.operatorId,domain,key,accountId])).rows[0];
   return {row,actor};
  });
  if(result.row&&this.tools&&!await this.tools.contextValid(result.row,result.actor)){
   await this.retire(result.row.id,'source-changed');
   return create?{...await this.session(operator,domain,{create}),contextChanged:true}:{row:null,actor:result.actor,contextChanged:true};
  }
  return result;
 }
 async retire(id,reason){await this.db.query('UPDATE operations_agentos_conversations_v1 SET retired_at=$3,retirement_reason=$4 WHERE endpoint=$1 AND id=$2 AND retired_at IS NULL',[this.endpoint,id,new Date(this.now()*1000),reason]);}
 view(row){return {id:row.id,domain:row.domain,sessionId:row.session_id,mode:'conversation',operatorId:row.operator_id,actions:[],resourceIds:[],hasPreparedCommand:false};}
 async currentWithin(db,id,{operator=null}={}){
  const row=(await db.query('SELECT * FROM operations_agentos_conversations_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,id])).rows[0];
  if(!row||operator&&row.operator_id!==operator.operatorId)fail('operations_agentos_conversation_not_found',404);
  if(row.retired_at)fail('operations_agentos_source_changed',409);
  if(!row.ai_account_id)fail('operations_ai_work_unassigned');
  const actor=await this.authority.human({kind:'business-operator',operatorId:row.operator_id,endpoint:this.endpoint},{db,domain:row.domain,purpose:'conversation'});
  if(operationsAiWorkScope(actor).accountId!==row.ai_account_id)fail('operations_ai_work_unassigned');
  if(permissionKey(actor)!==row.permission_key)fail('operations_agentos_authority_changed');return {row,actor};
 }
 async current(id,{operator=null}={}){parse(z.uuid(),id);const result=await transaction(this.db,db=>this.currentWithin(db,id,{operator}));
  if(this.tools&&!await this.tools.contextValid(result.row,result.actor)){await this.retire(id,'source-changed');fail('operations_agentos_source_changed',409);}
  return result;
 }
 async authorizeNative(input){const x=parse(nativeSchema,input),{row}=await this.current(x.conversationId),component='galaxy-conversation-'+row.domain;
  if(x.resourceType&&x.resourceType!=='agents'||x.resourceId&&x.resourceId!==component)fail('operations_agentos_domain_mismatch');
  // This private, current-AI instruction source is not an operator query and
  // never enters a public conversation view, signed token or client metadata.
  const configuration=(await this.db.query('SELECT configuration,prompt_version FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND domain=$2',[this.endpoint,row.domain])).rows[0];
  let rolePrompt=null;
  if(configuration){const selected=rolePromptSchema.safeParse({version:configuration.prompt_version,text:configuration.configuration?.prompt});if(!selected.success)fail('operations_agentos_role_prompt_unavailable',503);rolePrompt=selected.data;}
  await this.current(row.id);
  return {allowed:true,resourceIds:[component],execution:{...this.view(row),rolePrompt},readExpiresAt:this.now()+30};
 }
 async priorReadReceipts(actor,domain,context){
  const empty={basis:'current-conversation-prior-read-ledger',valuesCurrent:false,items:[]};
  if(!context)return empty;
  const conversationId=parse(z.uuid(),context.conversationId),turnId=parse(z.uuid(),context.turnId);
  const {row}=await this.current(conversationId,{operator:actor});
  if(row.domain!==domain)fail('operations_agentos_domain_mismatch');
  const command=(await this.db.query('SELECT id,created_at FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4',[this.endpoint,turnId,conversationId,actor.operatorId])).rows[0];
  if(!command)fail('operations_agentos_scope_denied');
  const rows=(await this.db.query(`WITH previous_turns AS (
   SELECT id FROM operations_agentos_conversation_commands_v1
   WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND created_at<$4
   ORDER BY created_at DESC,id DESC LIMIT 10)
   SELECT t.tool,t.state,t.metadata,t.created_at,t.updated_at
   FROM operations_agentos_conversation_tool_calls_v1 t JOIN previous_turns p ON p.id=t.turn_id
   WHERE t.endpoint=$1 AND t.conversation_id=$2 AND t.tool IN ('workbench-summary','query-operations','read-operation-object','read-ai-delegation')
   ORDER BY t.created_at DESC,t.id DESC LIMIT 80`,[this.endpoint,conversationId,actor.operatorId,command.created_at])).rows;
  await this.current(conversationId,{operator:actor});
  return {...empty,items:rows.map(conversationPriorReadReceipt).filter(Boolean).reverse()};
 }
 async summaryFor(actor,domain,args,context=null){parse(z.strictObject({}),args);
  actor=await this.authority.human(actor,{domain,purpose:'query'});
  const priorReadReceipts=await this.priorReadReceipts(actor,domain,context);
  const boundedTask=await this.boundedTaskFor(actor,context);
  const priorActionReceipts=this.tools?await this.tools.priorActionReferences(actor,domain,context):{basis:'same-owner-current-fixed-ai-completed-action-ledger',scope:'latest-20-completed-content-visibility-cards',valuesCurrent:false,availability:'unavailable',items:[]};
  const priorOperationReceipts=this.tools?await conversationOperationReceipts(this.tools,actor,domain,context):{availability:'unavailable',items:[]};
  let value,result;
  if(typeof this.summaryForConversation!=='function')result={domain,availability:'unavailable',reason:'summary-not-connected'};
  else try{value=await this.summaryForConversation(actor);}catch(error){if(error.status===403)throw error;result={domain,availability:'unavailable',reason:'summary-unavailable'};}
  const current=await this.authority.human(actor,{domain,purpose:'query'});
  if(current.businessAuthorization.version!==actor.businessAuthorization.version)fail('operations_agentos_authority_changed');
  if(context)await this.current(context.conversationId,{operator:current});
  const managementCapabilities=typeof this.authority.permissions?.managementCapabilitiesWithin==='function'
   ?await transaction(this.db,db=>this.authority.permissions.managementCapabilitiesWithin(db,{actor:current})):null;
  // Recheck after capability/configuration reads; a stale role snapshot cannot
  // turn the advertised directory into an execution permission.
  await this.authority.human(current,{domain,purpose:'query'});
  return {...(result??conversationSummary(value,domain,current.businessAuthorization.permissions)),queryAccess:agentOsQueryAccess(current.businessAuthorization.permissions),managementCapabilities,priorReadReceipts,priorActionReceipts,priorOperationReceipts,boundedTask};
 }
 executeTool(input){if(!this.tools)fail('operations_agentos_conversation_not_ready',503);return this.tools.execute(input);}
 async read(operator,domain){const {row,contextChanged=false}=await this.session(operator,domain),status=await this.client.status();let native=null;const runtimeState=status.state;
  const ready=[1,2].includes(status.conversationVersion)&&Array.isArray(status.conversationDomains)&&status.conversationDomains.includes(domain);
  if(row){
   if(runtimeState!=='connected')fail('operations_agentos_unavailable',503);
   if(![1,2].includes(status.conversationVersion))fail('operations_agentos_conversation_not_ready',503);
   // Read the native ledger even when a model has since been unassigned.
   // A temporary read failure must not renew the lease with a fabricated []:
   // the common UI reader retains prior DOM only until its original lease.
   native=await this.client.readConversation(this.view(row));
  }
  await this.authority.human(operator,{domain});if(row)await this.current(row.id,{operator});
  const toolCards=this.tools?await this.tools.cards(operator,domain):[];
  const configured=status.modelState==='configured'&&(!Array.isArray(status.configuredDomains)||status.configuredDomains.includes(domain));
  const runs=row?await this.cancellationActivities(row,await this.failureActivities(row,await this.bindRunOperations(row,native?.runs??[]))):[];if(row){await this.current(row.id,{operator});await this.syncWorkbenchRuns(row,runs);}
  const currentActor=await this.authority.human(operator,{domain,purpose:'query'});
  const managementCapabilities=typeof this.authority.permissions?.managementCapabilitiesWithin==='function'
   ?await transaction(this.db,db=>this.authority.permissions.managementCapabilitiesWithin(db,{actor:currentActor})):null;
  await this.authority.human(currentActor,{domain,purpose:'query'});
  return {domain,runs,toolCards,contextChanged,runtimeState,managementCapabilities,modelState:status.modelState==='unknown'?'unknown':configured?'configured':'not-configured',capabilities:{canSend:runtimeState==='connected'&&configured&&ready,canStream:runtimeState==='connected'&&ready&&status.conversationTransport?.events===true&&status.conversationTransport?.originalRunLookup===true,canCancel:runtimeState==='connected'&&ready&&status.conversationTransport?.cancel===true&&status.conversationTransport?.originalRunLookup===true},blockedReason:runtimeState!=='connected'?'runtime-unavailable':!configured?'model-not-configured':!ready?'runtime-not-ready':null,checkedAt:this.now(),readExpiresAt:Math.min(this.now()+30,native?.readExpiresAt??this.now()+30,...toolCards.map(card=>card.readExpiresAt))};
 }
 async nativeOperation(row,saved){
  let current;try{current=await this.client.readConversation(this.view(row));}catch(error){if(error.status===403)throw error;}
  const run=current?.runs?.find(run=>run.operationId===saved.id||run.runId===(saved.native_run_id??saved.result?.runId));if(run)return run;
  if(typeof this.client.readConversationOperation!=='function')return null;
  const status=await this.client.status();if(!status.conversationTransport?.originalRunLookup)return null;
  let original;try{original=await this.client.readConversationOperation(this.view(row),saved.id);}catch(error){if(error.status===403)throw error;return null;}
  if(original.operationId!==saved.id||original.runId!==null&&(typeof original.runId!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(original.runId)))fail('operations_agentos_response_invalid',503);
  if(!original.runId||original.state==='not-recorded')return null;
  if(original.native){if(original.native.runId!==original.runId||original.native.operationId!==saved.id)fail('operations_agentos_response_invalid',503);return original.native;}
  return{runId:original.runId,operationId:saved.id,status:['PENDING','RUNNING','CANCELLED','ERROR'].includes(original.state)?original.state:'unknown',content:null,userInput:null,createdAt:null,events:[],awaitingHuman:false};
 }
 async operation(operator,domain,id){parse(z.enum(agentOsDomains),domain);parse(z.uuid(),id);await this.authority.human(operator,{domain});
  const saved=(await this.db.query(`SELECT c.*,s.domain,s.operator_id AS owner FROM operations_agentos_conversation_commands_v1 c
   JOIN operations_agentos_conversations_v1 s ON s.id=c.conversation_id WHERE c.endpoint=$1 AND c.id=$2`,[this.endpoint,id])).rows[0];
  if(!saved||saved.owner!==operator.operatorId||saved.domain!==domain)fail('operations_agentos_operation_not_found',404);
  let row;try{row=(await this.current(saved.conversation_id,{operator})).row;}catch(error){if(error.code!=='operations_agentos_source_changed')throw error;return {...saved.result,state:'context-changed',native:null,contextChanged:true,replayed:true};}
  let target=saved;
  if(saved.result?.cancelledOperationId){target=(await this.db.query('SELECT * FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2 AND conversation_id=$3 AND operator_id=$4',[this.endpoint,saved.result.cancelledOperationId,saved.conversation_id,operator.operatorId])).rows[0];if(!target||target.result?.cancelledOperationId)fail('operations_agentos_operation_conflict',409);}
  const found=await this.nativeOperation(row,target);
  const run=found?(await this.cancellationActivities(row,await this.failureActivities(row,[found])))[0]:null;
  await this.current(row.id,{operator});if(run)await this.syncWorkbenchRuns(row,[run]);return {...saved.result,state:run?.status??(saved.state==='dispatching'?'unknown':saved.state),native:run??null,replayed:true};
 }
 async cancel(operator,domain,id,input,{authorize}={}){
  parse(z.enum(agentOsDomains),domain);parse(z.uuid(),id);const x=parse(z.strictObject({operationId:z.uuid()}),input);
  if(x.operationId===id||typeof authorize!=='function')fail('invalid_operations_agentos_request',400);
  const fresh=await authorize();if(fresh?.operatorId!==operator.operatorId||fresh?.endpoint!==this.endpoint)fail('business_admin_denied');await this.authority.human(fresh,{domain});
  const parent=(await this.db.query(`SELECT c.*,s.domain FROM operations_agentos_conversation_commands_v1 c JOIN operations_agentos_conversations_v1 s ON s.id=c.conversation_id
   WHERE c.endpoint=$1 AND c.id=$2 AND c.operator_id=$3 AND s.operator_id=$3`,[this.endpoint,id,operator.operatorId])).rows[0];
  if(!parent||parent.domain!==domain||parent.result?.cancelledOperationId)fail('operations_agentos_operation_not_found',404);
  const {row}=await this.current(parent.conversation_id,{operator:fresh}),digest=hash('cancel:'+id);
  const old=(await this.db.query('SELECT * FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId])).rows[0];
  if(old){if(old.operator_id!==operator.operatorId||old.conversation_id!==row.id||old.message_digest!==digest)fail('operations_agentos_operation_conflict',409);return this.operation(fresh,domain,x.operationId);}
  const status=await this.client.status();if(status.state!=='connected'||!status.conversationTransport?.cancel||!status.conversationTransport?.originalRunLookup)fail('operations_agentos_conversation_transport_unavailable',503);
  const native=await this.nativeOperation(row,parent);if(!native?.runId)fail('operations_agentos_run_not_available',409);
  const terminal=['COMPLETED','CANCELLED','ERROR','PAUSED'].includes(native.status),receipt={operationId:x.operationId,cancelledOperationId:id,runId:native.runId,state:terminal?native.status:'dispatching',replayed:false};
  const inserted=await transaction(this.db,async db=>{
   await this.authority.human(fresh,{db,domain});await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))',[this.endpoint+':conversation-cancel-parent:'+id]);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))',[this.endpoint+':conversation:'+x.operationId]);
   const saved=(await db.query('SELECT * FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId])).rows[0];
   if(saved){if(saved.operator_id!==fresh.operatorId||saved.conversation_id!==row.id||saved.message_digest!==digest)fail('operations_agentos_operation_conflict',409);return false;}
   if((await db.query("SELECT id FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND result->>'cancelledOperationId'=$4 LIMIT 1",[this.endpoint,row.id,fresh.operatorId,id])).rows.length)fail('operations_agentos_cancel_already_requested',409);
   await db.query('INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[x.operationId,this.endpoint,row.id,operator.operatorId,digest,terminal?'accepted':'dispatching',JSON.stringify(receipt),native.runId,new Date(this.now()*1000)]);return true;
  });
  if(!inserted)return this.operation(fresh,domain,x.operationId);
  let result=receipt;
  if(!terminal){
   try{const again=await authorize();if(again?.operatorId!==fresh.operatorId||again?.endpoint!==this.endpoint)fail('business_admin_denied');await this.current(row.id,{operator:again});await this.client.cancelConversation(this.view(row),native.runId);result={...receipt,state:'accepted'};}
   catch{result={...receipt,state:'unknown'};}
   await this.db.query('UPDATE operations_agentos_conversation_commands_v1 SET state=$3,result=$4 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId,result.state,JSON.stringify(result)]);
  }
  const final=await authorize();if(final?.operatorId!==fresh.operatorId||final?.endpoint!==this.endpoint)fail('business_admin_denied');await this.current(row.id,{operator:final});return result;
 }
 async *events(operator,domain,id,{after=-1,authorize,signal=null}={}){
  parse(z.enum(agentOsDomains),domain);parse(z.uuid(),id);parse(z.number().int().min(-1).max(9999999999),after);
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const fresh=await authorize();if(fresh?.operatorId!==operator.operatorId||fresh?.endpoint!==this.endpoint)fail('business_admin_denied');await this.authority.human(fresh,{domain});
  const saved=(await this.db.query(`SELECT c.*,s.domain,s.operator_id AS owner FROM operations_agentos_conversation_commands_v1 c JOIN operations_agentos_conversations_v1 s ON s.id=c.conversation_id WHERE c.endpoint=$1 AND c.id=$2`,[this.endpoint,id])).rows[0];
  if(!saved||saved.owner!==operator.operatorId||saved.domain!==domain||saved.result?.cancelledOperationId)fail('operations_agentos_operation_not_found',404);
  const {row}=await this.current(saved.conversation_id,{operator:fresh}),status=await this.client.status();
  if(status.state!=='connected'||!status.conversationTransport?.events||!status.conversationTransport?.originalRunLookup)fail('operations_agentos_conversation_transport_unavailable',503);
  const run=await this.nativeOperation(row,saved),expires=this.now()+30;
  const admitted=await authorize();if(admitted?.operatorId!==fresh.operatorId||admitted?.endpoint!==this.endpoint)fail('business_admin_denied');await this.current(row.id,{operator:admitted});
  yield{kind:'lease',operationId:id,readExpiresAt:expires,stopAvailable:!!run?.runId&&['PENDING','RUNNING'].includes(run.status)};
  if(!run?.runId){yield{kind:'resync',operationId:id,eventIndex:null};return;}
  if(['COMPLETED','CANCELLED','ERROR','PAUSED'].includes(run.status)){yield{kind:'terminal',operationId:id,eventIndex:null,status:run.status};return;}
  const observer=new AbortController(),observationSignal=signal?AbortSignal.any([signal,observer.signal]):observer.signal;
  for await(const event of coalescedConversationEvents(this.client.conversationEvents(this.view(row),run.runId,{after,signal:observationSignal}),{onClose:()=>observer.abort()})){
   if(signal?.aborted)return;
   if(this.now()>=expires){yield{kind:'resync',operationId:id,eventIndex:event.eventIndex??null};return;}
   const current=await authorize();if(current?.operatorId!==fresh.operatorId||current?.endpoint!==this.endpoint)fail('business_admin_denied');await this.current(row.id,{operator:current});
   if(this.now()>=expires){yield{kind:'resync',operationId:id,eventIndex:event.eventIndex??null};return;}
   yield{...event,operationId:id,readExpiresAt:expires};
  }
 }
 async run(operator,domain,input,{authorize}={}){const x=parse(conversationRunSchema,input);parse(z.enum(agentOsDomains),domain);if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const fresh=await authorize();if(fresh?.operatorId!==operator.operatorId||fresh?.endpoint!==this.endpoint)fail('business_admin_denied');await this.authority.human(fresh,{domain});
  const old=(await this.db.query(`SELECT c.*,s.domain FROM operations_agentos_conversation_commands_v1 c JOIN operations_agentos_conversations_v1 s ON s.id=c.conversation_id WHERE c.endpoint=$1 AND c.id=$2`,[this.endpoint,x.operationId])).rows[0];
  // Recover a receipt before checking engine/model readiness. Loss of a model
  // connection is never evidence that an earlier accepted call did not run.
  if(old){if(old.operator_id!==operator.operatorId||old.domain!==domain||old.message_digest!==turnDigest(x))fail('operations_agentos_operation_conflict',409);return this.operation(fresh,domain,x.operationId);}
  const status=await this.client.status();if(status.state!=='connected')fail('operations_agentos_not_configured',503);if(status.modelState!=='configured'||Array.isArray(status.configuredDomains)&&!status.configuredDomains.includes(domain))fail('operations_agentos_model_not_configured',503);
  if(![1,2].includes(status.conversationVersion)||!Array.isArray(status.conversationDomains)||!status.conversationDomains.includes(domain))fail('operations_agentos_conversation_not_ready',503);
  const {row}=await this.session(fresh,domain,{create:true});let retry=null;
  if(x.retryOfOperationId){
   const parent=(await this.db.query('SELECT * FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND id=$4',[this.endpoint,row.id,fresh.operatorId,x.retryOfOperationId])).rows[0];
   if(!parent||parent.result?.cancelledOperationId||parent.message_digest!==turnDigest({message:x.message,taskId:x.taskId,retryOfOperationId:parent.result?.retryOfOperationId}))fail('operations_agentos_retry_unavailable',409);
   const original=await this.nativeOperation(row,parent),checked=original?(await this.failureActivities(row,[{...original,operationId:parent.id}]))[0]:null;
   if(checked?.status!=='ERROR'||checked.errorCode!=='operations_agentos_model_request_failed'||checked.businessActivity?.state!=='not-started'||!['rate-limit','timeout','connection','service-unavailable','unknown'].includes(checked.failure?.category??'unknown')||checked.userInput!==x.message)fail('operations_agentos_retry_unavailable',409);
   retry={retryOfOperationId:parent.id,retryOfRunId:checked.runId,priorFailure:{status:'ERROR',errorCode:checked.errorCode,failure:checked.failure??null}};
  }
  const receipt={operationId:x.operationId,runId:null,state:'dispatching',native:null,replayed:false,...(x.taskId?{taskId:x.taskId}:{}),...retry};
  const inserted=await transaction(this.db,async db=>{await this.authority.human(fresh,{db,domain});await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))',[this.endpoint+':conversation:'+x.operationId]);
   if(retry){
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))',[this.endpoint+':conversation-retry:'+retry.retryOfOperationId]);
    if((await db.query("SELECT id FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND conversation_id=$2 AND operator_id=$3 AND result->>'retryOfOperationId'=$4 AND state<>'not-started' AND id<>$5 LIMIT 1",[this.endpoint,row.id,fresh.operatorId,retry.retryOfOperationId,x.operationId])).rows.length)fail('operations_agentos_retry_already_requested',409);
   }
   const existing=(await db.query('SELECT * FROM operations_agentos_conversation_commands_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId])).rows[0];
   if(existing){if(existing.operator_id!==fresh.operatorId||existing.conversation_id!==row.id||existing.message_digest!==turnDigest(x))fail('operations_agentos_operation_conflict',409);return false;}
   await db.query('INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[x.operationId,this.endpoint,row.id,fresh.operatorId,turnDigest(x),'dispatching',JSON.stringify(receipt),new Date(this.now()*1000)]);
   await this.linkWorkbenchWithin(db,row,x.operationId,x.taskId);return true;
  });
  if(!inserted)return this.operation(fresh,domain,x.operationId);
  let result;
  try{const again=await authorize();if(again?.operatorId!==fresh.operatorId||again?.endpoint!==this.endpoint)fail('business_admin_denied');await this.current(row.id,{operator:again});
   const native=await this.client.runConversation(this.view(row),{runId:x.operationId,message:x.message,stream:status.conversationTransport?.events===true&&status.conversationTransport?.originalRunLookup===true,...(retry?{retryOfRunId:retry.retryOfRunId,retryOfOperationId:retry.retryOfOperationId}:{})});result={...receipt,runId:native.run_id??native.runId??null,state:'accepted'};
  }catch(error){result={...receipt,state:error.status===403||error.code==='operations_agentos_model_not_configured'?'not-started':'unknown'};}
  await transaction(this.db,async db=>{
   await db.query('UPDATE operations_agentos_conversation_commands_v1 SET state=$3,result=$4,native_run_id=COALESCE(native_run_id,$5) WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId,result.state,JSON.stringify(result),result.runId]);
   await this.updateWorkbenchWithin(db,x.operationId,{...(result.runId?{nativeRunId:result.runId}:{}),modelState:result.state==='accepted'?'accepted':result.state==='not-started'?'not-started':'unknown',status:result.state==='accepted'?'running':result.state==='not-started'?'failed':'unknown'});
  });
  const final=await authorize();if(final?.operatorId!==fresh.operatorId||final?.endpoint!==this.endpoint)fail('business_admin_denied');await this.current(row.id,{operator:final});return result;
 }
}
