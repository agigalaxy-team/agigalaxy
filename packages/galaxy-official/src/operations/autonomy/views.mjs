import {transaction} from "../../infrastructure/database.mjs";
import {z} from 'zod';
import {taskQuerySchema,parse,iso,fail,domainNames,autonomyModes,autonomyBusinessStates,terminalStates} from './contract.mjs';
import {taskSourceRefsSql,taskSourceRefsWithin} from './sources.mjs';
const permitted=(actor,action)=>actor?.businessAuthorization?.permissions?.includes(action)===true;
const taskReadMap={'content-post':'post','content-reply':'reply','content-section':'section','business-account':'account',account:'account',section:'section','community-report':'case',case:'case','chat-report':'chat-report',feedback:'feedback',project:'project',method:'method','file-chat':'chat-file','file-forum':'forum-file','file-cleanup-plan':'file-cleanup-plan','messaging-plan':'message-plan','rule-key':'rule','strategy-run':'strategy-run'};
const modulePermission={'recommendation-policy':'recommendations.read','search-quality':'search-quality.read',maintenance:'maintenance.read','ai-role':'permissions.read','ai-role-assignment':'ai.accounts.read','ai-work-account':'ai.accounts.read',strategy:'strategies.read','strategy-configuration':'strategies.read'};
const kindPermission={post:'content.read',reply:'content.read',section:'sections.read',account:'accounts.read',case:'cases.read','chat-report':'chat-reports.read',feedback:'feedback.read',project:'resources.read',method:'resources.read','chat-file':'files.read','forum-file':'files.read','file-cleanup-plan':'files.read','message-plan':'notices.read',rule:'rules.read','strategy-run':'strategies.read'};
const n=value=>Number.isFinite(value)&&value>=0?value:null;

export class AutonomyReadModel{
 async checkTarget(actor,row,{includeReceipts=true,db=this.db}={}){
  if(includeReceipts){const refs=await taskSourceRefsWithin(db,this.endpoint,row.id);for(const ref of refs)await this.checkTarget(actor,{...row,...ref},{includeReceipts:false,db});}
  if(!row.target_type)return true;
  const kind=taskReadMap[row.target_type];
  if(kind){
   if(!this.queryTools)fail('operations_autonomy_source_unavailable',503);
   // Read through the existing source-aware service. An audit/task permission
   // alone cannot disclose a case, deleted content or an unavailable file.
   const viewer=await this.businessAdmin.authorizeAction(actor,kindPermission[kind],{db}),args={kind,id:row.target_id,filters:{}};
   // This is a human viewer's source check. Revoking the task AI's role must
   // never hide an owned old task from a currently qualified human reader.
   const value=typeof this.queryTools.read==='function'?await this.queryTools.read(viewer,args):await this.queryTools.execute({actor:viewer,domain:row.domain,tool:'read-operation-object',arguments:args});
   if(value.availability&&value.availability!=='available')fail('operations_autonomy_source_unavailable',409);
   await this.businessAdmin.authorizeAction(viewer,kindPermission[kind],{db});
  }else{const permission=modulePermission[row.target_type];if(!permission)fail('operations_autonomy_source_unavailable',409);await this.businessAdmin.authorizeAction(actor,permission,{db});}
  return true;
 }
 async taskView(db,row,actor,{includeReceipts=true,checkTarget=true}={}){
  if(checkTarget)await this.checkTarget(actor,row,{db});
  const continuation=await this.continuationWithin(db,row),pendingCalls=(await db.query("SELECT call_id,operation_id,tool,code FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND state='waiting-human' ORDER BY created_at,call_id",[this.endpoint,row.id])).rows.map(r=>({callId:r.call_id,operationId:r.operation_id,tool:r.tool,code:r.code}));
  const workbenchHref=await this.workbenchHrefWithin(db,row,actor);
  const controls=[];if(permitted(actor,'autonomy.control')){
   if(!terminalStates.has(row.state)){if(!['paused','waiting-human'].includes(row.state))controls.push('pause','takeover');else if(row.source!=='workbench'&&row.human_decision?.kind!=='takeover')controls.push('takeover');if(row.source!=='workbench'&&['paused','waiting-human'].includes(row.state)&&(!row.dispatch_started_at||row.native_continuable&&continuation.allowed))controls.push('resume');controls.push('stop');}
   if(row.dispatch_started_at&&row.state!=='stopped')controls.push('reconcile');
  }
  const receipts=includeReceipts?(await db.query('SELECT operation_id,action,target_type,target_id,state,basis,details,created_at FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 ORDER BY created_at,operation_id',[this.endpoint,row.id])).rows.map(r=>({operationId:r.operation_id,action:r.action,targetType:r.target_type,targetId:r.target_id,state:r.state,basis:r.basis,details:r.details,createdAt:iso(r.created_at)})):[];
  return{id:row.id,taskId:row.id,operationId:row.id,title:row.title,domain:row.domain,source:row.source,mode:row.mode,state:row.state,modelState:row.model_state,businessState:row.business_state,revision:row.revision,
   aiAccountId:row.ai_account_id,planId:row.config_id,configRevision:row.config_revision,promptVersion:row.prompt_version,planVersion:row.plan_version,delegationVersion:row.delegation_version,
   nativeRunId:row.native_run_id,strategyVersionId:row.configuration.versionBindings?.strategyVersionId??null,targetType:row.target_type,targetId:row.target_id,summary:row.summary??null,code:row.code??null,effects:receipts,businessReceipts:receipts,humanDecision:row.human_decision,pendingCalls,continuation,workbenchHref,
   calls:n(row.model_usage?.calls),tokens:{input:n(row.model_usage?.inputTokens),output:n(row.model_usage?.outputTokens),total:n(row.model_usage?.totalTokens)},durationMs:n(row.model_usage?.durationMs),
   createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),dueAt:iso(row.due_at),startedAt:iso(row.started_at),completedAt:iso(row.completed_at),lastValidAt:row.effective_check?iso(row.completed_at):null,availableControls:controls};
 }
 async tasks(operator,input={}){
  const q=parse(taskQuerySchema,input),actor=await this.actor(operator),values=[this.endpoint],parts=['t.endpoint=$1'];
  for(const[field,column]of[['domain','domain'],['source','source'],['state','state'],['mode','mode']])if(q[field]){values.push(q[field]);parts.push('t.'+column+'=$'+values.length);}
  if(q.targetType){values.push(q.targetType,q.targetId);const type='$'+(values.length-1),id='$'+values.length;parts.push(`((t.target_type=${type} AND t.target_id=${id}) OR EXISTS(SELECT 1 FROM (${taskSourceRefsSql('t.endpoint','t.id')}) refs WHERE refs.target_type=${type} AND refs.target_id=${id}))`);}
  // Metadata pages remain bounded; unavailable controlled sources are excluded
  // and their count is unknown rather than leaked as a directory count.
  const count=(await this.db.query(`SELECT count(*)::int AS total,bool_or(t.target_type IS NOT NULL OR EXISTS(SELECT 1 FROM (${taskSourceRefsSql('t.endpoint','t.id')}) refs WHERE refs.target_type IS NOT NULL)) AS controlled FROM operations_autonomy_tasks_v1 t WHERE `+parts.join(' AND '),values)).rows[0];
  const rows=(await this.db.query('SELECT t.* FROM operations_autonomy_tasks_v1 t WHERE '+parts.join(' AND ')+' ORDER BY t.created_at DESC,t.id DESC LIMIT $'+(values.length+1)+' OFFSET $'+(values.length+2),[...values,q.limit,(q.page-1)*q.limit])).rows;
  const items=[];let withheld=false;for(const row of rows){try{items.push(await this.taskView(this.db,row,actor));}catch(e){if(![403,404,409,410,503].includes(e.status))throw e;withheld=true;}}
  await this.actor(operator);return{items,total:withheld||count.controlled&&(q.page!==1||count.total>q.limit)?null:count.total,page:q.page,limit:q.limit,nextPage:rows.length===q.limit&&q.page*q.limit<count.total?q.page+1:null,availability:withheld?'partial':'available',...this.stamp()};
 }
 async getTask(operator,id){parse(z.uuid(),id);const actor=await this.actor(operator),row=await this.taskWithin(this.db,id),task=await this.taskView(this.db,row,actor);await this.actor(operator);return{task,...this.stamp()};}
 async overview(operator,{days=7}={}){
  const actor=await this.actor(operator);if(!Number.isInteger(days)||days<1||days>90)fail('invalid_operations_autonomy_request',400);const runtime=await this.runtime();
  await transaction(this.db,async db=>{await this.actor(actor,'autonomy.read',{db});await this.ensureWithin(db);});
  const until=this.at(),from=new Date(until.getTime()-days*86400000),cfgs=(await this.db.query('SELECT * FROM operations_autonomy_configs_v1 WHERE endpoint=$1 ORDER BY domain',[this.endpoint])).rows;
  const health=(await this.db.query('SELECT checked_at,last_tick_at,started_at FROM operations_autonomy_health_v1 WHERE endpoint=$1',[this.endpoint])).rows[0];
  const current=(await this.db.query('SELECT * FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND (created_at>=$2 OR state IN (\'running\',\'queued\',\'waiting-human\',\'unknown\')) ORDER BY created_at DESC,id DESC LIMIT 1000',[this.endpoint,from])).rows;
  const rows=[],withheld=[],withheldDomains=new Set();for(const row of current){try{await this.checkTarget(actor,row);rows.push(row);}catch(error){if(![403,404,409,410,503].includes(error.status))throw error;withheld.push(row.id);withheldDomains.add(row.domain);}}
  const window=rows.filter(r=>new Date(r.created_at)>=from),automatic=window.filter(r=>r.source!=='workbench');
  const grace=r=>(r.configuration.runtime?.startGraceSeconds??this.defaults.startGraceSeconds)*1000;
  const onTime=r=>{if(r.source!=='routine'||!r.effective_check||r.state!=='completed'||!r.completed_at)return false;const due=new Date(r.due_at).getTime(),completed=new Date(r.completed_at).getTime();return completed>=due&&completed<=due+grace(r)+(r.configuration.runtime?.roundSeconds??this.defaults.roundSeconds)*1000;};
  const counts=items=>({expected:items.filter(r=>r.source==='routine').length,completed:items.filter(r=>r.source==='routine'&&r.effective_check&&r.state==='completed').length,late:items.filter(r=>r.source==='routine'&&new Date(r.started_at??until).getTime()-new Date(r.due_at).getTime()>grace(r)).length,backlog:items.filter(r=>r.state==='queued').length,waitingHuman:items.filter(r=>r.state==='waiting-human').length});
  const accounts=[];for(const cfg of cfgs){const ready=await transaction(this.db,db=>this.readinessWithin(db,cfg,runtime)),items=rows.filter(r=>r.domain===cfg.domain&&r.source!=='workbench'),measure=counts(items);
   if(withheldDomains.has(cfg.domain)||current.length===1000)for(const key of Object.keys(measure))measure[key]=null;
   const alive=!!health&&(until-new Date(health.checked_at))/1000<=this.defaults.healthSeconds+this.defaults.startGraceSeconds;
   const overdue=items.some(r=>['unknown','failed','waiting-human'].includes(r.state)||r.state==='queued'&&until-new Date(r.due_at)>grace(r)||r.state==='running'&&r.started_at&&until-new Date(r.started_at)>(r.configuration.runtime?.roundSeconds??this.defaults.roundSeconds)*1000);
   const stale=cfg.last_valid_at&&until-new Date(cfg.last_valid_at)>((cfg.configuration.schedule.kind==='daily'?86400:cfg.configuration.schedule.minutes*60)+this.defaults.startGraceSeconds+this.defaults.roundSeconds)*1000;
   const healthState=!cfg.enabled?'pending':!alive?'unavailable':!ready.ready?'blocked':withheldDomains.has(cfg.domain)||current.length===1000?'unknown':overdue||stale?'attention':cfg.last_valid_at?'healthy':'pending';
   accounts.push({id:ready.account?.id??null,domain:cfg.domain,name:ready.account?.name??domainNames[cfg.domain],enabled:cfg.enabled,configRevision:cfg.revision,readiness:{ready:ready.ready,reasons:ready.reasons},health:healthState,lastValidAt:iso(cfg.last_valid_at),nextDueAt:iso(cfg.next_due_at),...measure,
    config:{id:cfg.id,domain:cfg.domain,revision:cfg.revision,...cfg.configuration,enabled:cfg.enabled,promptVersion:cfg.prompt_version,planVersion:cfg.plan_version,delegationVersion:cfg.delegation_version,nextDueAt:iso(cfg.next_due_at)}});
  }
  const receipts=(await this.db.query(`SELECT task_id,state,basis,created_at FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND created_at>=$2 AND task_id=ANY($3::uuid[])`,[this.endpoint,from,rows.map(r=>r.id)])).rows;
  const automaticIds=new Set(automatic.map(r=>r.id)),automaticReceipts=receipts.filter(r=>automaticIds.has(r.task_id)&&r.basis!=='workbench-original-domain-receipt');
  const measure=counts(automatic),summary={enabledAccounts:accounts.filter(a=>a.enabled).length,healthyAccounts:accounts.filter(a=>a.health==='healthy').length,active:rows.filter(r=>r.state==='running').length,queued:rows.filter(r=>r.state==='queued').length,waitingHuman:rows.filter(r=>r.state==='waiting-human').length,failed:window.filter(r=>r.state==='failed').length,unknown:rows.filter(r=>r.state==='unknown'||r.business_state==='unknown').length,businessCompleted:new Set(automaticReceipts.filter(r=>r.state==='completed').map(r=>r.task_id)).size,allBusinessCompleted:new Set(receipts.filter(r=>r.state==='completed').map(r=>r.task_id)).size,...measure,onTimeRate:measure.expected?automatic.filter(onTime).length/measure.expected:null};
  const groups=new Map();for(const row of automatic){const at=new Date(new Date(row.created_at).getTime()+8*3600000).toISOString().slice(0,10)+'T00:00:00+08:00';if(!groups.has(at))groups.set(at,[]);groups.get(at).push(row);}
  const timeline=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([at,items])=>({at,...counts(items),failed:items.filter(r=>r.state==='failed').length}));
  const view=async list=>{const items=[];for(const row of list.slice(0,20))items.push(await this.taskView(this.db,row,actor,{checkTarget:false}));return items;};
  // Call and token fields stay null until native metadata for this exact task
  // is observed; accepted task/queue rows are not provider-call counts.
  const usageRows=window.filter(r=>r.model_usage),usagePoints=usageRows.map(r=>({at:iso(r.created_at),calls:n(r.model_usage.calls),inputTokens:n(r.model_usage.inputTokens),outputTokens:n(r.model_usage.outputTokens),totalTokens:n(r.model_usage.totalTokens),durationMs:n(r.model_usage.durationMs)}));
  const usageKeys=['calls','inputTokens','outputTokens','totalTokens','durationMs'],tracked=window.filter(r=>r.mode!=='code'&&(r.dispatch_started_at||r.model_usage)),unknownTasks=tracked.filter(r=>usageKeys.some(k=>n(r.model_usage?.[k])===null)).length;
  const totals=Object.fromEntries(usageKeys.map(k=>[k,!unknownTasks&&!withheld.length&&current.length<1000&&usagePoints.length&&usagePoints.every(p=>p[k]!==null)?usagePoints.reduce((sum,p)=>sum+p[k],0):null]));
  const observedSubtotal=Object.fromEntries(usageKeys.map(k=>[k,usagePoints.some(p=>p[k]!==null)?usagePoints.reduce((sum,p)=>sum+(p[k]??0),0):null]));
  await this.actor(operator);
  if(withheld.length||current.length===1000)for(const key of Object.keys(summary))summary[key]=null;
  return{accounts,summary,runtime:{state:runtime.state,modelState:runtime.modelState},timeline:withheld.length?[]:timeline,modes:autonomyModes.map(key=>({key,count:withheld.length?null:automatic.filter(r=>r.mode===key).length})),results:autonomyBusinessStates.map(key=>({key,count:withheld.length?null:automatic.filter(r=>r.business_state===key).length})),usage:{points:usagePoints,totals,observedSubtotal,unknownTasks:withheld.length?null:unknownTasks,coverage:{trackedTasks:withheld.length?null:tracked.length,observedTasks:usageRows.length,complete:!unknownTasks&&!withheld.length&&current.length<1000,history:'ledger-window-only'}},recentTasks:await view(rows),humanTasks:await view(rows.filter(r=>r.state==='waiting-human')),exceptions:await view(rows.filter(r=>['failed','unknown','blocked'].includes(r.state))),
   capabilities:{canConfigure:permitted(actor,'autonomy.configure'),canEnable:permitted(actor,'autonomy.configure'),canControl:permitted(actor,'autonomy.control')},basis:{from:iso(from),until:iso(until),tasks:'persisted-intents-only',expected:'persisted-routine-intents-in-created-window',onTimeRate:'effective-routine-completed-within-frozen-due-grace-round-over-expected',late:'persisted-routine-start-grace-exceeded-not-missed-schedule-slots',recovery:'single-coalesced-catch-up-with-original-due-no-historical-slot-count',businessCompleted:'automatic-task-with-actual-business-receipt-excluding-workbench-cards',inspectionCompleted:'effective-tool-read-and-completed-round',coverage:current.length===1000?'latest-1000':'complete-window',availability:withheld.length?'partial':'available',calls:'observed-native-metadata-only',history:'not-backfilled'},...this.stamp()};
 }
 async workbenchSummary(operator){
  try{const data=await this.overview(operator);return{summary:data.summary,accounts:data.accounts,runtime:data.runtime,recentTasks:data.recentTasks.slice(0,6),humanTasks:data.humanTasks.slice(0,6),timeline:data.timeline,basis:data.basis,...this.stamp()};}
  catch(error){if(error.status!==403)throw error;return{summary:null,accounts:[],recentTasks:[],humanTasks:[],timeline:[],basis:{availability:'not-authorized'},...this.stamp()};}
 }
}
