import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import canonicalize from 'canonicalize';
import {z} from 'zod';
import {aiWorkCapabilities} from './shared/operations-ai-work-capabilities.mjs';
import {checkConversationPublicReference} from './operations-agentos-public-reference.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {transaction} from './database.mjs';
import {workbenchActionCatalog,workbenchPrepareSchemas,workbenchCommandSchemas,workbenchActionToolSchema,workbenchEmptyArgumentsSchema,workbenchRunArgumentsSchema,workbenchAiPromptReviewSchema} from './operations-agentos-action-catalog.mjs';
import {p14ControlsSchema} from './shared/p14-rules-schema.mjs';
import {operationsPolicySchemas} from './shared/operations-product-schema.mjs';
import {aiActionDefinition} from './shared/operations-ai-action-registry.mjs';

const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const parse=(schema,value)=>{const result=schema?.safeParse(value);if(!result?.success)fail('invalid_operations_agentos_action',400);return result.data;};
const label=(value,fallback)=>typeof value==='string'&&value.trim()?value.replace(/[\p{Cc}]/gu,' ').trim().slice(0,180):fallback;
const categoryNames={technology:'科技',arts:'艺术',learning:'学习',life:'生活',galaxy:'银河',unclassified:'未分类'};
const stateNames={pending:'待处理',processing:'处理中',closed:'已关闭'};
const recommendationDirectionNames={increase:'增加',keep:'保持',decrease:'减少'};
const moduleNames={account:'账户',community:'社区',chat:'聊天',work:'协作',discovery:'发现',other:'其他'};
const cap=(value)=>{if(value!==true)fail('operations_agentos_operation_unavailable');};
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const restrictionTime=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value));
const safeReceipt=(value)=>({operationId:typeof value?.operationId==='string'?value.operationId:null,
 publishedVersion:count(value?.publishedVersion),
 version:count(value?.version??value?.content?.version??value?.plan?.version),revision:count(value?.revision??value?.visibility?.version??value?.content?.visibility?.version??value?.plan?.revision),
 hidden:typeof(value?.visibility?.hidden??value?.content?.visibility?.hidden)==='boolean'?(value.visibility?.hidden??value.content.visibility.hidden):null,
 state:['scheduled','active','paused','stopped','draft','resolved','prepared','running','awaiting-human','completed','blocked','no-action','unknown','active-for-new-matters'].includes(value?.state??value?.plan?.state??value?.run?.state)?(value.state??value.plan?.state??value.run?.state):null,
 phase:['prepared','submitting','task-pending','applied','failed','result-unknown'].includes(value?.phase)?value.phase:null,replayed:value?.replayed===true});
const requestSchema=value=>workbenchPrepareSchemas[value?.kind];
const requiredActionFor=x=>['job-cancel','job-retry'].includes(x.kind)?'jobs.'+(x.kind==='job-cancel'?'cancel':'retry'):x.kind==='search-retry'?'search.retry':x.kind==='ai-work-prompt-save'?'ai.prompts.update':x.kind==='ai-role-command'?'ai.roles.'+(x.command.kind==='role-create'?'create':x.command.kind==='role-update'?'update':x.command.enabled?'assign':'revoke'):x.kind==='public-content-batch'?'content.batch.'+x.action:x.kind==='private-case-message'?'chat-messages.'+x.action:x.kind==='ordinary-strategy-draft'?'strategies.ordinary.configure':x.kind==='ordinary-strategy-publish'?'strategies.ordinary.publish':x.kind==='recommendation-direction'?'recommendations.configure':x.kind==='content-visibility'?'content.'+x.action:x.kind==='content-curation'?'content.curate':x.kind==='section-classification'?'sections.classify':x.kind==='section-visibility'?'sections.'+x.action:x.kind==='resource-visibility'?'resources.'+x.action:x.kind==='account-restriction'?'accounts.restriction.'+x.action:x.kind==='feedback-update'?'feedback.update':x.kind==='file-scan-retry'?'files.scan.retry':x.kind==='file-access'?'files.access.'+x.action:x.kind==='file-cleanup-approve'?'files.cleanup.approve':x.kind==='case-resolve'?'cases.resolve':x.kind==='message-draft-create'?'notices.create':x.kind==='message-draft-save'?'notices.update':x.kind==='messaging-state'?(['activate','resume'].includes(x.action)?'notices.publish':'notices.withdraw'):x.kind==='strategy-control'?'strategies.control':x.kind==='strategy-continue'?'strategies.run':['rule-publish','rule-restore'].includes(x.kind)?'rules.write':x.kind==='search-apply'?'search-quality.publish':'search-quality.restore';
const humanDraftConfig=config=>({...config,automation:{kind:'human-required',factsConfirmed:false}});
const unknownFeedbackResult=operationId=>({operationId,state:'unknown',summary:'本次反馈处理结果尚未核实，系统会继续查询原结果。',receipt:null});
const unknownRecommendationResult=operationId=>({operationId,state:'unknown',summary:'推荐方向保存结果暂未核实，正在查询原结果。',receipt:null});
const recommendationPolicyInput=input=>pick(input,['operationId','expectedVersion','enabled','themeKey','direction','controls','reason']);
function recommendationResult(result,operationId,input,resultSource){
 const policy=result?.policy,directions=new Map(input.beforeDirections.map(item=>[item.key,item.direction]));directions.set(input.themeKey,input.direction);
 const expected=[...directions].map(([key,direction])=>({key,direction}));
 if(result?.operationId!==operationId||policy?.version!==input.expectedVersion+1||policy.enabled!==input.enabled
  ||!isDeepStrictEqual(policy.controls,input.controls)||!isDeepStrictEqual(policy.directions,expected)){
  if(resultSource==='ack')return unknownRecommendationResult(operationId);
  fail('operations_agentos_operation_conflict');
 }
 return{operationId,state:'completed',summary:policy.enabled?'这次主题推荐方向已保存。':'这次主题推荐方向已保存，方向调控仍未启用。',
  receipt:{operationId,version:policy.version,themeKey:input.themeKey,direction:input.direction,enabled:policy.enabled,replayed:result.replayed===true}};
}
function actionResult(kind,result,operationId,request,command=null,resultSource='ack'){
 if(['job-cancel','job-retry','search-retry'].includes(kind)){
  if(result?.jobId!==request.targetId||typeof result.state!=='string'||kind==='search-retry'&&result.generation!==command.expectedGeneration||kind!=='search-retry'&&result.queue!==request.queue)fail('operations_agentos_operation_conflict');
  return{operationId,state:'completed',summary:kind==='job-cancel'?'这次任务取消已记录。':'已重新安排原失败任务；实际执行结果仍需读取。',receipt:{operationId,...result}};
 }
 if(kind==='ai-work-prompt-save'){
  const prompt=result?.prompt;if(result?.operationId!==operationId||prompt?.aiAccountId!==request.aiAccountId||prompt.revision!==command.expectedRevision+1||prompt.promptVersion!==command.expectedPromptVersion+1||result.delegationVersion!==command.delegationVersion)fail('operations_agentos_operation_conflict');
  return{operationId,state:'completed',summary:'岗位工作要求已保存，新轮次采用新版本。',receipt:{operationId,aiAccountId:prompt.aiAccountId,configId:prompt.configId,revision:prompt.revision,promptVersion:prompt.promptVersion,delegationVersion:result.delegationVersion,replayed:result.replayed===true}};
 }
 if(kind==='ai-role-command'){
  const input=command.command,assignment=input.kind==='assignment-save',value=assignment?result?.assignment:result?.role;
  if(result?.operationId!==operationId||!z.uuid().safeParse(value?.id).success||value.version!==input.expectedVersion+1||result.delegationVersion!==command.delegationVersion||assignment&&(value.aiAccountId!==input.aiAccountId||value.roleId!==input.roleId||value.enabled!==input.enabled)||!assignment&&(value.subjectScope!=='ai-only'||value.name!==input.name||value.enabled!==input.enabled||!isDeepStrictEqual(value.permissions,input.permissions)))fail('operations_agentos_operation_conflict');
  return{operationId,state:'completed',summary:assignment?'获准 AI 的专用角色分配已保存。':'获准 AI 的专用角色已保存。',receipt:{operationId,delegationVersion:result.delegationVersion,...(assignment?{assignmentId:value.id,aiAccountId:value.aiAccountId,roleId:value.roleId}:{roleId:value.id}),version:value.version,enabled:value.enabled,replayed:result.replayed===true}};
 }
 if(kind==='recommendation-direction')return recommendationResult(result,operationId,command,resultSource);
 if(kind==='message-draft-create'||kind==='message-draft-save'){
  const plan=result?.plan,create=kind==='message-draft-create',planId=create?command.planId:request.targetId;
  if(plan?.id!==planId||plan.state!=='draft'||plan.version!==(create?1:command.expectedVersion+1)||plan.revision!==(create?1:command.expectedRevision+1)||!isDeepStrictEqual(plan.config,command.config)){
   if(resultSource==='receipt')fail('operations_agentos_operation_conflict');
   return{operationId,state:'unknown',summary:'消息草稿保存结果暂未核实，系统会继续查询原操作。',receipt:null};
  }
  return{operationId,state:'completed',summary:create?'消息草稿已生成，事实与受众仍待人工核实。':'消息草稿已保存，事实与受众仍待人工核实。',receipt:{operationId,planId,version:plan.version,revision:plan.revision,state:'draft',automation:{kind:'human-required',factsConfirmed:false},replayed:result.replayed===true}};
 }
 if(kind==='public-content-batch'){
  if(result?.operationId!==operationId||!Array.isArray(result.items)||result.items.length!==command.items.length||result.items.some((item,i)=>item.id!==command.items[i].id||item.kind!==command.items[i].kind||!['applied','rejected'].includes(item.status)))fail('operations_agentos_operation_conflict');
  const applied=result.items.filter(item=>item.status==='applied').length,rejected=result.items.length-applied;return{operationId,state:applied?'completed':'failed',summary:'这批公开内容已处理 '+applied+' 项，未处理 '+rejected+' 项。',receipt:{operationId,counts:{applied,rejected},items:result.items.map(item=>({kind:item.kind,id:item.id,status:item.status,code:item.code??null,revision:item.visibility?.version??null})),replayed:result.replayed===true}};
 }
 if(kind==='private-case-message'){
  const selected=result?.materials?.find(item=>item.messageId===request.messageId),revision=result?.messageOperation?.revision??selected?.moderation?.revision??result?.revision,version=result?.messageOperation?.reportVersion??result?.version,id=result?.messageOperation?.operationId??result?.operationId;
  if(id!==operationId||(result?.reportId??request.reportId)!==request.reportId||revision!==command.expectedRevision+1||version!==command.expectedVersion+1)fail('operations_agentos_operation_conflict');
  return{operationId,state:'completed',summary:'本案所选消息处理已记录。',receipt:{operationId,reportId:request.reportId,messageId:request.messageId,sourceRevision:command.messageRevision,version,revision,action:request.action,ownHidden:request.action!=='restore',replayed:result.replayed===true||result.messageOperation?.replayed===true}};
 }
 if(kind==='ordinary-strategy-draft'||kind==='ordinary-strategy-publish'){
  if(result?.operationId!==operationId||result.strategyId!==request.strategyId||!z.uuid().safeParse(result.versionId).success||!Number.isSafeInteger(result.version)||!Number.isSafeInteger(result.revision)||result.state!==(kind==='ordinary-strategy-draft'?'saved':'active-for-new-matters')||request.versionId&&result.versionId!==request.versionId)fail('operations_agentos_operation_conflict');
  return{operationId,state:'completed',summary:kind==='ordinary-strategy-draft'?'日常策略调整已保存为草稿。':'日常策略调整已发布，仅用于新事项。',receipt:{operationId,strategyId:result.strategyId,versionId:result.versionId,version:result.version,revision:result.revision,state:result.state,replayed:result.replayed===true}};
 }
 const receipt=safeReceipt(result);
 if(kind==='feedback-update'){
  const feedback=resultSource==='ack'?result?.feedback:null,revision=count(resultSource==='ack'?feedback?.revision:result?.revision),expected=count(command?.expectedRevision);
  const unconfirmed=()=>{if(resultSource==='ack')return unknownFeedbackResult(operationId);fail('operations_agentos_operation_conflict');};
  if(expected===null||expected<1||revision!==expected+1||result?.operationId!==operationId
   ||(resultSource==='ack'?feedback?.id:result?.feedbackId)!==request?.targetId)return unconfirmed();
  if(feedback){
   for(const key of ['category','module','state'])if(Object.hasOwn(command,key)&&feedback[key]!==command[key])return unconfirmed();
   if(Object.hasOwn(command,'note')&&(result.history?.items?.[0]?.kind!=='updated'||result.history.items[0].note!==command.note))return unconfirmed();
  }
  return{operationId,state:'completed',summary:'这条反馈已更新。',receipt:{operationId,feedbackId:request.targetId,revision,replayed:receipt.replayed}};
 }

 if(kind==='content-curation'){
  const value=result?.content??result,version=count(result?.content?.version??result?.sourceVersion),revision=count(result?.content?.curation?.revision??result?.revision);
  if(value?.kind!==request?.targetKind||value?.id!==request?.targetId||version===null||revision===null||revision<1
   ||result?.operationId!==undefined&&result.operationId!==operationId)fail('operations_agentos_operation_conflict');
  // Curation and visibility have independent revisions. An ACK's current
  // content envelope and the original durable audit result must name the same
  // curation effect, never its unrelated visibility state.
  Object.assign(receipt,{operationId,version,revision,hidden:null});
 }
 if(kind==='file-access'){
  const stop=request?.action==='stop';
  if(result?.operationId!==operationId||result?.kind!==request?.targetKind||result?.id!==request?.targetId||result?.action!==request?.action
   ||count(result.revision)===null||result.revision<1||result.stopped!==stop||(stop?result.until!==request.until:result.until!==null))fail('operations_agentos_operation_conflict');
  return{operationId,state:'completed',summary:stop?'已设置停止访问，截止北京时间 '+restrictionTime(result.until*1000)+'。':'已解除这次确认的运营访问覆盖。',
   receipt:{operationId,kind:result.kind,id:result.id,action:result.action,revision:result.revision,stopped:result.stopped,until:result.until,replayed:receipt.replayed}};
 }
 if(kind==='account-restriction'){
  const value=result?.restriction,release=request?.action==='release';
  if(result?.accountId!==request?.targetId||result?.operationId!==operationId||value?.scope!=='community-participation'||count(value.revision)===null||typeof value.active!=='boolean'
   ||(release?(value.until!==null||value.active!==false):!Number.isFinite(Date.parse(value.until))||Date.parse(value.until)!==Date.parse(request.until)))fail('operations_agentos_operation_conflict');
  return{operationId,state:'completed',summary:release?'已解除这次确认的参与限制。':'已设置参与限制，截止北京时间 '+restrictionTime(value.until)+'。',
   receipt:{operationId,accountId:result.accountId,revision:value.revision,restriction:{scope:value.scope,active:value.active,until:value.until},replayed:receipt.replayed}};
 }
 if(kind==='file-cleanup-approve'){
  const state=result?.plan?.state,planId=result?.planId;
  if(result?.kind!=='approve'||!z.uuid().safeParse(planId).success||!['queued','running','completed','attention','cancelled'].includes(state))fail('operations_agentos_operation_conflict');
  return{operationId,state:'completed',summary:state==='completed'?'这份清理计划已批准，逐项处理已结束；对象移除结果可在计划中查看。':state==='attention'?'这份清理计划已批准，部分对象的结果尚未确认，请查看计划。':state==='cancelled'?'这份计划曾获批准，后续清理已取消。':'已批准这份计划，系统会逐项核对并清理。',receipt:{...receipt,planId,state}};
 }
 if(kind==='rule-publish'||kind==='rule-restore')return{operationId,state:receipt.publishedVersion>0?'completed':'unknown',summary:receipt.publishedVersion>0?(kind==='rule-publish'?'这份规则已发布。':'已将所选历史内容发布为新的规则版本。'):'正在取得规则的发布结果。',receipt};
 if(kind==='strategy-continue')return{operationId,state:receipt.state==='unknown'?'unknown':['completed','no-action','blocked'].includes(receipt.state)?'completed':'processing',summary:receipt.state==='completed'?'这项处理已完成。':receipt.state==='no-action'?'本次决定已记录，未执行处理。':receipt.state==='blocked'?'当前条件不满足，事项已停止。':receipt.state==='unknown'?'本次决定已记录，正在读取处理进展。':'本次决定已记录，事项正在继续。',receipt};
 return{operationId,state:receipt.phase==='result-unknown'?'unknown':receipt.phase&&receipt.phase!=='applied'&&receipt.phase!=='failed'?'processing':receipt.phase==='failed'?'failed':'completed',
  summary:kind==='file-scan-retry'?'已重新安排扫描，等待扫描结果。':receipt.phase==='applied'?'搜索配置已生效。':receipt.phase==='result-unknown'?'搜索配置结果暂未取得，正在查询原操作。':receipt.phase&&receipt.phase!=='failed'?'搜索配置正在应用。':receipt.phase==='failed'?'搜索配置未生效。':'本次处理已完成。',receipt};
}

const ruleNames={'resource-budget':'资源额度','community-quota':'参与额度','forum-quota':'论坛额度','business-controls':'业务规则与名单'};
const numericRuleLabels={maxPayloadBytesPerSubject:['单主体数据存储上限','字节'],maxQueuedJobsPerSubject:['单主体排队任务上限','项'],maxActiveExportsPerSubject:['单主体有效导出上限','项'],maxActiveJobsGlobal:['全服务并行任务','项'],maxActiveJobsPerSubject:['单主体并行任务','项'],promotionDays:['转为普通账户所需时间','天'],invitationCooldownDays:['邀请冷却时间','天'],maxPermissionSeconds:['内容授权最长时间','秒'],maxGovernanceHideSeconds:['治理隐藏最长时间','秒'],dailyUsageDays:['用量记录保留时间','天'],auditDays:['社区审计保留时间','天'],accountForumMaxBytes:['单账户社区数据上限','字节'],maxTitleCodePoints:['标题上限','字'],maxBodyCodePoints:['帖子上限','字'],maxReplyCodePoints:['回复上限','字'],maxReportCodePoints:['举报说明上限','字'],maxLinks:['链接数量上限','个'],maxLinkCodePoints:['单链接长度上限','字'],maxPayloadBytes:['单次内容上限','字节'],maxAppeals:['每案申诉上限','次'],maxReportEvents:['每案处理记录上限','条']};
const quotaRuleLabels={task:'任务',comment:'评论',invitation:'邀请',post:'发帖',version:'帖子修订',reply:'回复',report:'举报'};
async function ruleDifference(key,before,after,catalog,accountLabel){
 const schema=key==='business-controls'?p14ControlsSchema:operationsPolicySchemas[key],old=parse(schema,before),next=parse(schema,after),lines=[];
 const add=line=>{lines.push(line);if(line.length>5000||lines.length>80||lines.reduce((n,x)=>n+x.length,0)>20000)fail('operations_agentos_rule_review_required');};
 const show=value=>Number.isSafeInteger(value)?value.toLocaleString('zh-CN'):String(value),enabled=value=>value?'启用':'停用';
 if(key!=='business-controls'){
  for(const field of new Set([...Object.keys(old),...Object.keys(next)])){
   if(isDeepStrictEqual(old[field],next[field]))continue;
   if(field==='new'||field==='normal'){for(const category of Object.keys(next[field]))if(old[field][category]!==next[field][category])add((field==='new'?'新账户':'普通账户')+'每日'+quotaRuleLabels[category]+'额度：'+show(old[field][category])+' 次改为 '+show(next[field][category])+' 次');}
   else{const descriptor=numericRuleLabels[field];if(!descriptor)fail('operations_agentos_rule_review_required');add(descriptor[0]+'：'+show(old[field])+' '+descriptor[1]+'改为 '+show(next[field])+' '+descriptor[1]);}
  }
  return lines;
 }
 const named=(items,key,value)=>items?.find(item=>item[key]===value)?.label??null;
 for(const [feature,value]of Object.entries(next.features))if(old.features[feature]!==value){const name=named(catalog.features,'key',feature);if(!name)fail('operations_agentos_rule_review_required');add('功能「'+name+'」：'+enabled(old.features[feature])+'改为'+enabled(value));}
 const changedLists=new Set(),listDescription=item=>(item.kind==='domain'?'域名名单':'词条名单')+'「'+item.name+'」（'+enabled(item.enabled)+'）；条目：'+(item.entries.length?item.entries.map(value=>'「'+value+'」').join('、'):'无');
 for(const id of new Set([...old.lists.map(x=>x.id),...next.lists.map(x=>x.id)])){
  const a=old.lists.find(x=>x.id===id),b=next.lists.find(x=>x.id===id);if(isDeepStrictEqual(a,b))continue;changedLists.add(id);
  if(a)add((b?'原名单：':'移除名单：')+listDescription(a));if(b)add((a?'改为名单：':'新增名单：')+listDescription(b));
 }
 const condition=(node,policy)=>{
  if(Array.isArray(node.rules))return(node.combinator==='or'?'满足任一条件':'同时满足')+'（'+node.rules.map(child=>condition(child,policy)).join('；')+'）';
  const field=catalog.fields?.find(item=>item.name===node.field),operator=field?.operators?.find(item=>item.name===node.operator)?.label;
  if(!field||!operator)fail('operations_agentos_rule_review_required');const value=['keywordList','domainList'].includes(node.field)?policy.lists.find(item=>item.id===node.value)?.name:field.values?.find(item=>item.name===node.value)?.label??show(node.value);
  if(value===undefined)fail('operations_agentos_rule_review_required');return field.label+' '+operator+' '+value;
 };
 const ruleDescription=async(rule,policy)=>{
  const targets=rule.targets.map(value=>named(catalog.targets,'key',value));if(targets.some(x=>!x))fail('operations_agentos_rule_review_required');
  const exceptions=[];for(const exception of rule.exceptions){const people=[];for(const id of exception.accountIds)people.push(await accountLabel(id));exceptions.push('「'+exception.name+'」（'+enabled(exception.enabled)+'）：'+people.join('、'));}
  return'「'+rule.name+'」（'+enabled(rule.enabled)+'）；适用'+targets.join('、')+'；'+condition(rule.conditions,policy)+'；命中后停止本次新操作；例外：'+(exceptions.join('；')||'无');
 };
 const changedReference=node=>Array.isArray(node?.rules)?node.rules.some(changedReference):changedLists.has(node?.value);
 for(const id of new Set([...old.rules.map(x=>x.id),...next.rules.map(x=>x.id)])){
  const a=old.rules.find(x=>x.id===id),b=next.rules.find(x=>x.id===id);if(isDeepStrictEqual(a,b)&&!changedReference(a?.conditions)&&!changedReference(b?.conditions))continue;
  if(a)add((b?'原规则：':'移除规则：')+await ruleDescription(a,old));if(b)add((a?'改为规则：':'新增规则：')+await ruleDescription(b,next));
 }
 return lines;
}

// This adapter does not mint an executor or grant. Model tools can discover an
// already authorized task or prepare a typed human operation. Execution uses
// the stored human card or the exact grant-bound duty command.
export class OperationsAgentOsActionTools{
 constructor({conversations,authority,gateway,services={},now=authority.now}){Object.assign(this,{conversations,authority,gateway,services,now,db:authority.db,endpoint:authority.endpoint});this.dutyKinds=new Set(['job-cancel','job-retry','search-retry','content-visibility','content-curation','public-content-batch','private-case-message','section-classification','section-visibility','resource-visibility','account-restriction','feedback-update','file-scan-retry','file-access','case-resolve','recommendation-direction','search-apply','search-restore','ordinary-strategy-draft','ordinary-strategy-publish','message-draft-create','message-draft-save','messaging-state']);authority.dutyActionReady=permission=>this.dutyActionReady(permission);}
 enableDutyKind(kind){if(!workbenchPrepareSchemas[kind]||!workbenchCommandSchemas[kind])fail('operations_agentos_action_not_connected',503);this.dutyKinds.add(kind);}
 dutyActionReady(permission){
  const definition=aiActionDefinition(permission);if(definition?.query)return true;
  if(definition?.purposeBoundRead)return definition.handler.methods.every(method=>typeof this.services[definition.handler.service]?.[method]==='function');
  if(['ai-role-delegation','ai-prompt-delegation'].includes(definition?.kind))return definition.handler.methods.every(method=>typeof this.services.permissions?.[method]==='function');
  if(!definition?.autonomous||!this.dutyKinds.has(definition.kind))return false;
  return definition.handler?.methods.every(method=>typeof this.services[definition.handler.service]?.[method]==='function')===true;
 }
 service(name,method){const service=this.services[name];if(typeof service?.[method]!=='function')fail('operations_agentos_action_not_connected',503);return service;}
 async human(operator,action,{authorize=null,db}={}){
  if(this.authority.acceptsDuty?.(operator))return this.authority.human(operator,{action,authorize,db});
  return this.authority.human(operator,{action,authorize,db,purpose:'prepare'});
 }
 async prepareFor(operator,domain,input,{publicReference,operationId}={}){
  const request=parse(requestSchema(input),input),entry=workbenchActionCatalog.find(item=>item.kind===request.kind);
  if(publicReference!==undefined&&!['content-visibility','content-curation'].includes(request.kind))fail('invalid_operations_agentos_request',400);
  if(!entry)fail('operations_agentos_action_unavailable',403);
  operator=await this.authority.human(operator,{domain,purpose:'prepare'});
  const actor=await this.human(operator,entry.read),x=request;
  let target,title,requiredAction,command,review,impact=[],basis=[],readExpiresAt=this.now()+30;
  const deadline=(until,maximum,sourceUntil=null)=>{if(!Number.isSafeInteger(maximum)||until<=this.now()||until>this.now()+maximum||sourceUntil!==null&&until>sourceUntil)fail('operations_hide_expiry');return new Date(until*1000).toISOString();};
  const expiry=value=>{if(Number.isSafeInteger(value))readExpiresAt=Math.min(readExpiresAt,value);};
  const visibilityCommand=(view,sourceVersion,action)=>({kind:action,expectedVersion:sourceVersion,expectedVisibilityVersion:view.visibility.version,...(x.until===undefined?{}:{until:x.until}),reason:x.reason});
  if(['job-cancel','job-retry','search-retry'].includes(x.kind)){
   const job=await this.service('jobActions','read').read(actor,x.kind,x);
   if(x.kind==='search-retry'){cap(job.state==='failed');command={expectedGeneration:job.generation,reason:x.reason};}
   else{cap(x.kind==='job-retry'?job.state==='failed':['created','retry','active','cancelled'].includes(job.state));command={expectedState:job.state,expectedRetryCount:job.retryCount,reason:x.reason};}
   target={kind:x.kind==='search-retry'?'search-job':'queue-job',id:x.targetId,label:x.kind==='search-retry'?'失败索引任务的第 '+job.generation+' 代':x.queue+' 队列中的具体任务',href:'/admin/operations/jobs'};
   title=x.kind==='job-cancel'?'取消这项运行任务':'重新安排这项失败任务';requiredAction=requiredActionFor(x);
   basis=[{label:'任务 ID',value:x.targetId},{label:x.kind==='search-retry'?'索引代数':'队列',value:x.kind==='search-retry'?String(job.generation):x.queue},{label:'当前状态',value:job.state}];impact=[x.kind==='job-cancel'?'停止这项队列工作；已完成的外部效果不会撤回。':'仅重新安排所选失败任务，不表示索引或业务已经执行成功。','执行前重新检查任务状态及所属业务权限。'];
  }else if(x.kind==='ai-work-prompt-save'){
   if(this.authority.acceptsDuty?.(actor))fail('operations_agentos_management_card_requires_human',403);
   const item=await this.service('permissions','delegatedPrompt').delegatedPrompt(actor,{aiAccountId:x.aiAccountId}),prompt=item.prompt;expiry(item.readExpiresAt);
   if(prompt.text===x.prompt)fail('operations_ai_prompt_no_change');
   command={aiAccountId:x.aiAccountId,expectedRevision:prompt.revision,expectedPromptVersion:prompt.promptVersion,prompt:x.prompt,delegationVersion:item.delegationVersion};
   target={kind:'ai-work-prompt',id:x.aiAccountId,label:label(prompt.name,'获准 AI')+'的岗位工作要求',href:'/admin/operations/ai-work-accounts?domain='+prompt.domain+'&tab=duty'};
   title='修改「'+label(prompt.name,'获准 AI')+'」的岗位工作要求';requiredAction='ai.prompts.update';
   review=workbenchAiPromptReviewSchema.parse({kind:'ai-work-prompt',aiAccountId:x.aiAccountId,domain:prompt.domain,name:prompt.name,configId:prompt.configId,expectedRevision:prompt.revision,promptVersion:prompt.promptVersion,nextPromptVersion:prompt.promptVersion+1,scope:'role-work-requirements',source:prompt.text?'saved-configuration':'empty-default',before:prompt.text,after:x.prompt,effect:'new-rounds-only'});
   basis=[{label:'当前岗位要求',value:'版本 '+prompt.promptVersion+'；配置修订 '+prompt.revision},{label:'人工管理范围',value:'委派版本 '+item.delegationVersion}];
   impact=['仅更新这个岗位的工作要求，新轮次采用新版本。','模型、固定代码边界、目标、角色权限、自动授权、开关和运行频率保持原配置。'];
  }else if(x.kind==='ai-role-command'){
   if(this.authority.acceptsDuty?.(actor))fail('operations_agentos_management_card_requires_human',403);
   const permissions=this.service('permissions','delegatedRolePreparation'),directory=await permissions.delegatedDirectory(actor),item=await permissions.delegatedRolePreparation(actor,x.command),role=x.command;
   expiry(directory.readExpiresAt);expiry(item.readExpiresAt);if(directory.delegation?.version!==item.delegationVersion)fail('operations_ai_delegation_version_changed');
   command={command:item.command,delegationVersion:item.delegationVersion};requiredAction=requiredActionFor(x);
   const assignment=role.kind==='assignment-save',selectedId=assignment?role.id??parse(z.uuid(),operationId):role.kind==='role-update'?role.id:parse(z.uuid(),operationId),name=assignment?directory.targetAiAccounts.find(row=>row.id===role.aiAccountId)?.name:role.name;
   target={kind:assignment?'ai-role-assignment':'ai-role',id:selectedId,label:label(name,'获准 AI 专用角色'),href:'/admin/operations/permissions?tab=roles'};title=assignment?(role.enabled?'分配':'撤回')+'获准 AI 的专用角色':role.kind==='role-create'?'创建获准 AI 专用角色':'修改获准 AI 专用角色';
   basis=[{label:'人工管理范围',value:'委派版本 '+item.delegationVersion},{label:'原对象版本',value:String(role.expectedVersion)}];
   impact=assignment?['只'+(role.enabled?'分配':'撤回')+'这个获准其他 AI 的指定专用角色。','目标 AI：'+label(name,'获准 AI')+'；角色：'+label(directory.roles.find(row=>row.id===role.roleId)?.name,'当前专用角色')]:['角色名称：'+role.name,'角色说明：'+role.description,'角色状态：'+(role.enabled?'启用':'停用'),'角色权限：'+(role.permissions.join('、')||'无'),'管理目标：'+role.targetAiAccountIds.map(id=>label(directory.targetAiAccounts.find(row=>row.id===id)?.name,'获准 AI')).join('、')];
   impact.push('只影响人工委派内其他 AI 的专用角色；共享角色、人员角色、总控自身与管理范围保持原边界。');
  }else if(x.kind==='account-restriction'){
   const item=await this.service('accounts','get').get(actor,x.targetId),account=item.account,restriction=account?.restriction;
   if(account?.accountId!==x.targetId||restriction?.scope!=='community-participation'||count(restriction.revision)===null||typeof restriction.active!=='boolean')fail('operations_agentos_operation_unavailable');
   expiry(item.readExpiresAt??(Number.isSafeInteger(item.checkedAt)?item.checkedAt+30:null));
   cap(x.action==='apply'?item.permissions?.canRestrict:item.permissions?.canRelease);
   if(x.action==='apply'&&Date.parse(x.until)<=this.now()*1000)fail('operations_agentos_restriction_deadline');
   if(x.action==='release'&&(!restriction.active||!Number.isFinite(Date.parse(restriction.until))||Date.parse(restriction.until)<=this.now()*1000))fail('operations_agentos_restriction_inactive');
   const name=label(account.displayName,null),uid=label(account.uid,null);if(!name&&!uid)fail('operations_agentos_operation_unavailable');
   target={kind:'account',id:x.targetId,label:name?(uid&&uid!==name?name+'（UID '+uid+'）':name):'UID '+uid,href:'/admin/operations/users?account='+x.targetId+'&tab=restrictions'};
   title=x.action==='release'?'解除此账户参与限制':restriction.active?'调整此账户参与限制':'限制此账户参与';requiredAction=requiredActionFor(x);
   command={expectedRevision:restriction.revision,reason:x.reason,...(x.action==='apply'?{until:x.until}:{})};
   basis=[{label:'当前参与状态',value:restriction.active?'限制至北京时间 '+restrictionTime(restriction.until):'当前没有生效的参与限制'}];
   impact=[x.action==='release'?'解除当前这一版账户参与限制，其他内容治理、权限和额度仍按原条件执行。':(restriction.active?'本次将现有限制调整为':'本次限制生效至')+'北京时间 '+restrictionTime(x.until)+'。',
    '现有业务参与总门覆盖帖子发布与修订、回复、任务发布、评论、邀请、聊天发送与编辑及相关上传。',
    '这项限制不关闭登录、不删除已有内容；已有读取、撤回和退出仍按各自权限执行。','处理原因：'+x.reason];
   expiry(Math.floor(Date.parse(x.action==='apply'?x.until:restriction.until)/1000));
  }else if(x.kind==='public-content-batch'){
   const content=this.service('content','preview'),items=[];for(const selected of x.items){const item=(await content.get(actor,selected.kind,selected.id)).content;cap(x.action==='hide'?item.capabilities?.canBatchHide:item.capabilities?.canBatchRestore);items.push({...selected,expectedVersion:item.version,expectedRevision:item.visibility.version});expiry(item.publishedUntil);}
   const preview=await content.preview(actor,{kind:x.action,items,...(x.until===undefined?{}:{until:x.until})});if(preview.items.some(item=>!item.eligible)||items.length>preview.maximumItems)fail('operations_agentos_human_review_required',409);
   target={kind:'content-batch',id:items[0].id,label:'明确选定的 '+items.length+' 项公开内容',href:'/admin/operations/community?tab=posts'};title='批量'+(x.action==='hide'?'下架':'恢复')+'明确选定的公开内容';requiredAction=requiredActionFor(x);command={kind:x.action,items,...(x.until===undefined?{}:{until:x.until}),reason:x.reason};basis=[{label:'明确影响范围',value:items.length+' 项已选当前公开来源'}];impact=['逐项核对原版本和运营覆盖版本，未满足条件的对象保留拒绝原因。'];
  }else if(x.kind==='private-case-message'){
   const detail=await this.service('chatReports','operatorGet').operatorGet(actor,{reportId:x.reportId}),material=detail.materials.find(item=>item.messageId===x.messageId&&item.state==='available');if(!material)fail('chat_report_message_not_selected',404);
   cap(material.moderation?.[{hide:'canHide',restore:'canRestore',keep:'canKeep'}[x.action]]);expiry(detail.readExpiresAt);target={kind:'chat-report',id:x.reportId,label:'具体私聊案件已选消息',href:'/admin/operations/chat-reports?report='+x.reportId};title='处理本案已选消息';requiredAction=requiredActionFor(x);command={expectedVersion:detail.version,expectedRevision:material.moderation.revision,messageRevision:material.revision,action:x.action,summary:x.summary};basis=[{label:'资料范围',value:'仅本案明确提供且当前仍可读取的消息版本'}];impact=['记录本案单条消息的'+({hide:'屏蔽',restore:'恢复',keep:'维持屏蔽'}[x.action])+'；其他案件覆盖和个人隐藏保持各自有效条件。'];
  }else if(x.kind==='content-visibility'||x.kind==='content-curation'){
   const response=await this.service('content','get').get(actor,x.targetKind,x.targetId),item=response.content;
   if(item.sourceState!=='available')fail('operations_source_unavailable');
   checkConversationPublicReference(publicReference,x.targetKind,x.targetId,item);expiry(item.publishedUntil);
   target={kind:x.targetKind,id:x.targetId,label:label(item.title,x.targetKind==='post'?'公开帖子':'公开回复'),href:'/admin/operations/community?tab=posts&contentKind='+x.targetKind+'&id='+x.targetId};
   basis=[{label:'来源',value:'当前可公开读取的'+(x.targetKind==='post'?'帖子':'回复')},{label:'当前展示',value:item.visibility.hidden?'已隐藏':'正常展示'}];
   if(x.kind==='content-visibility'){
    cap(x.action==='hide'?item.capabilities?.canHide:item.capabilities?.canRestore);requiredAction='content.'+x.action;
    title=x.action==='hide'?'下架这条公开内容':'恢复这条公开内容';
    impact=x.action==='hide'?['停止该内容的公开展示，截止 '+deadline(x.until,item.maxHideSeconds,item.publishedUntil??null)]:['解除这次运营下架。作者已撤回、已到期或没有阅读权限的内容仍不展示。'];
    command={kind:x.action,expectedVersion:item.version,expectedRevision:item.visibility.version,...(x.until===undefined?{}:{until:x.until}),reason:x.reason};
   }else{
    cap(item.capabilities?.canCurate);requiredAction='content.curate';title='调整这条内容的分类与编排';
    command={expectedVersion:item.version,expectedRevision:item.curation.revision,...pick(x,['topic','pinned','featured','tagIds','reason'])};
    impact=[...(Object.hasOwn(x,'topic')?['分类：'+(x.topic===null?'恢复来源分类':categoryNames[x.topic])]:[]),...(x.pinned===undefined?[]:['置顶：'+(x.pinned?'是':'否')]),...(x.featured===undefined?[]:['精选：'+(x.featured?'是':'否')])];
    if(x.tagIds){const response=await this.service('content','tags').tags(actor),tags=response.items??response.tags??response;
     if(!Array.isArray(tags)||x.tagIds.some(id=>!tags.some(tag=>tag.id===id&&tag.enabled)))fail('operations_tag_unavailable');impact.push('标签：'+(x.tagIds.length?x.tagIds.map(id=>label(tags.find(tag=>tag.id===id)?.name,'标签')).join('、'):'清除运营标签'));}
   }
  }else if(x.kind==='section-classification'||x.kind==='section-visibility'){
   const item=await this.service('community','section').section(actor,x.targetId);expiry(item.readExpiresAt);
   if(item.sourceState!=='available')fail('operations_source_unavailable');target={kind:'section',id:x.targetId,label:label(item.title,'版块'),href:'/admin/operations/community?tab=sections&id='+x.targetId};
   basis=[{label:'当前分类',value:categoryNames[item.category]??'未记录'},{label:'当前展示',value:item.visibility.hidden?'已隐藏':'正常展示'}];
   if(x.kind==='section-classification'){cap(item.canManage);title='调整版块分类';requiredAction='sections.classify';impact=['分类改为'+categoryNames[x.category]];command={expectedVersion:item.version,category:x.category,reason:x.reason};}
   else{cap(x.action==='hide'?item.canHide:item.canRestore);title=x.action==='hide'?'下架这个版块':'恢复这个版块';requiredAction='sections.'+x.action;command=visibilityCommand(item,item.version,x.action);impact=x.action==='hide'?['停止版块展示，截止 '+deadline(x.until,item.maxHideSeconds)]:['解除这次运营下架，版块仍只向原本有权阅读的人展示。'];}
  }else if(x.kind==='resource-visibility'){
   const item=await this.service('resources','get').get(actor,x.targetKind,x.targetId);expiry(item.readExpiresAt);
   cap(x.action==='hide'?item.canHide:item.canRestore);target={kind:x.targetKind,id:x.targetId,label:label(item.title,x.targetKind==='projects'?'项目':'方法'),href:'/admin/operations/resources?kind='+x.targetKind+'&id='+x.targetId};
   title=(x.action==='hide'?'下架这个':'恢复这个')+(x.targetKind==='projects'?'项目':'方法');requiredAction='resources.'+x.action;command=visibilityCommand(item,item.version,x.action);
   basis=[{label:'来源状态',value:item.sourceState==='available'?'当前可读取':'当前不可读取'},{label:'当前展示',value:item.visibility.hidden?'已隐藏':'正常展示'}];
   impact=x.action==='hide'?['停止展示，截止 '+deadline(x.until,item.maxHideSeconds)]:['解除这次运营下架。已归档、撤回或到期的材料仍不展示。'];
  }else if(x.kind==='feedback-update'){
   const response=await this.service('feedback','get').get(actor,x.targetId),item=response.feedback;cap(response.permissions?.canManage);expiry(response.readExpiresAt);
   target={kind:'feedback',id:x.targetId,label:label(item.title,'使用反馈'),href:'/admin/operations/feedback?id='+x.targetId};title='更新这条使用反馈';requiredAction='feedback.update';
   command={expectedRevision:item.revision,...pick(x,['category','module','state','note'])};
   basis=[{label:'当前状态',value:stateNames[item.state]??'未记录'}];
   impact=[...(x.state===undefined?[]:['状态：'+stateNames[x.state]]),...(Object.hasOwn(x,'category')?['分类：'+(x.category===null?'未分类':x.category==='problem'?'问题':'建议')]:[]),...(x.module===undefined?[]:['所属模块：'+moduleNames[x.module]]),...(x.note?['添加内部备注：'+x.note]:[])];
  }else if(x.kind==='file-scan-retry'){
   const item=await this.service('files','get').get(actor,x.targetKind,x.targetId);cap(item.canRetryScan);expiry(item.readExpiresAt);
   target={kind:'file',id:x.targetId,label:label(item.name,'文件'),href:'/admin/operations/files?fileKind='+x.targetKind+'&id='+x.targetId};
   title='重新安排文件扫描';requiredAction='files.scan.retry';command={kind:'scan',expectedVersion:item.processingVersion??item.version,reason:x.reason};
   basis=[{label:'处理资格',value:'当前可重新安排扫描'}];impact=['重新安排安全扫描，不删除文件。扫描结果会在检查完成后更新。'];
  }else if(x.kind==='file-access'){
   const item=await this.service('fileAccess','get').get(actor,x.targetKind,x.targetId),access=item.access;
   if(item.id!==x.targetId||item.kind!==x.targetKind||typeof item.processingVersion!=='string'||!item.processingVersion.length||item.processingVersion.length>8192||count(access?.revision)===null||typeof access.stopped!=='boolean')fail('operations_agentos_operation_unavailable');
   cap(x.action==='stop'?access.canStop:access.canRestore);expiry(item.readExpiresAt);
   if(x.action==='stop'&&x.until<=this.now())fail('operations_file_access_until',400);
   if(x.action==='stop'?access.stopped:!access.stopped||!Number.isSafeInteger(access.until)||access.until<=this.now())fail('operations_file_access_changed');
   target={kind:'file',id:x.targetId,label:label(item.name,x.targetKind==='chat'?'私聊附件':'社区附件'),href:'/admin/operations/files?fileKind='+x.targetKind+'&id='+x.targetId};
   title=x.action==='stop'?'停止此文件访问':'恢复此文件访问';requiredAction=requiredActionFor(x);
   command={expectedVersion:item.processingVersion,expectedRevision:access.revision,action:x.action,reason:x.reason,...(x.action==='stop'?{until:x.until}:{})};
   basis=[{label:'文件来源',value:x.targetKind==='chat'?'私聊附件':'社区附件'},{label:'运营访问状态',value:access.stopped?'停止至北京时间 '+restrictionTime(access.until*1000):'当前没有生效的运营访问覆盖'}];
   impact=[x.action==='stop'?'停止此文件的获准取件，截止北京时间 '+restrictionTime(x.until*1000)+'。':'解除当前这一版运营访问覆盖。',
    '此操作不删除文件，也不更改原存储期限、作者撤回或清理计划。',
    x.action==='stop'?'停止期间，下载与获准导出仍受同一文件访问控制。':'恢复后仍按原扫描结果、来源状态与阅读权限判断是否可取件。','处理原因：'+x.reason];
   expiry(x.action==='stop'?x.until:access.until);
  }else if(x.kind==='file-cleanup-approve'){
   const plan=await this.service('fileCleanup','plan').plan(actor,x.planId);expiry(plan.readExpiresAt);
   cap(plan.state==='awaiting-approval'&&plan.permissions?.canApprove);await this.human(actor,'files.cleanup.approve');
   const review=()=>fail('operations_agentos_cleanup_review_required');
   if(plan.id!==x.planId||!Number.isSafeInteger(plan.revision)||plan.revision<1||!Array.isArray(plan.items)||plan.items.length<1||plan.items.length>50||plan.itemCount!==plan.items.length||count(plan.declaredBytes)===null)review();
   const keys=new Set();let bytes=0;
   impact=['清除以下 '+plan.itemCount+' 份文件在服务器上的副本，无法从此处恢复。'];
   for(const [index,item]of plan.items.entries()){
    const key=item.kind+':'+item.id;
    if(!['chat','forum'].includes(item.kind)||!z.uuid().safeParse(item.id).success||keys.has(key)||count(item.size)===null||!['expired','unreferenced'].includes(item.reason)||item.state!=='pending')review();
    keys.add(key);bytes+=item.size;if(!Number.isSafeInteger(bytes))review();
    const source=item.kind==='chat'?'私聊附件':'社区附件',name=label(item.name,'未命名'+source),references=count(item.referenceCount),active=count(item.activeReferences),expiresAt=typeof item.expiresAt==='string'&&Number.isFinite(Date.parse(item.expiresAt))?new Date(item.expiresAt).toISOString():null;
    impact.push((index+1)+'. '+name+' · '+source+' · 声明大小 '+item.size.toLocaleString('zh-CN')+' 字节 · '+(item.reason==='expired'?'既有期限已到':'已无有效来源引用')+' · 制定时有效引用 '+(active===null?'未确认':active)+' / 总引用 '+(references===null?'未确认':references)+' · 既有到期时间 '+(expiresAt??'未记录'));
   }
   if(bytes!==plan.declaredBytes)review();
   impact.push('只处理这份已列明的计划，不包含之后新增的文件。清理前会再次核对引用、留存和对象状态，有变化的文件不会继续清理。','批准只安排逐项处理；对象是否已移除以实际结果为准，磁盘释放空间目前无法确认。');
   if(impact.length>54||impact.some(line=>line.length>5000)||impact.reduce((n,line)=>n+line.length,0)>20000)review();
   target={kind:'file-cleanup-plan',id:x.planId,label:'具体文件清理计划（'+plan.itemCount+' 份文件）',href:'/admin/operations/files?kind=all&view=cleanup&plan='+x.planId};
   title='批准清理这 '+plan.itemCount+' 份文件';requiredAction='files.cleanup.approve';command={expectedRevision:plan.revision};
   basis=[{label:'计划制定时间',value:typeof plan.createdAt==='string'&&Number.isFinite(Date.parse(plan.createdAt))?new Date(plan.createdAt).toISOString():'未记录'},{label:'固定范围',value:plan.itemCount+' 份文件；声明大小合计 '+plan.declaredBytes.toLocaleString('zh-CN')+' 字节'},{label:'当前计划',value:'等待本次人工批准'}];
  }else if(x.kind==='case-resolve'){
   const item=await this.service('community','report').report(actor,x.targetId);cap(item.canModerate);expiry(item.readExpiresAt);
   const action=x.restrictionAction??(x.hideUntil===undefined?'keep':'hide');cap(action==='hide'?item.currentEffect?.canHide:action==='release'?item.currentEffect?.canRelease:item.currentEffect?.canKeep);
   target={kind:'public-case',id:x.targetId,label:label(item.title,'公开内容举报与申诉'),href:'/admin/operations/community?tab=reports&id='+x.targetId};
   title='复核这项公开举报与申诉';requiredAction='cases.resolve';command={expectedVersion:item.version,...pick(x,['resolution','summary','restrictionAction','hideUntil'])};
   basis=[{label:'处理资格',value:'当前独立处理者可复核'},{label:'本案限制',value:item.currentEffect?.active?'当前生效':'当前无生效限制'}];
   impact=['结论：'+({accepted:'举报成立',dismissed:'不采纳举报','needs-review':'需要进一步复核'}[x.resolution]),action==='keep'?'维持本案现有展示限制。':action==='release'?'解除本案的隐藏限制。其他案件的限制，以及原内容的可见条件仍保持。':'设置本案隐藏，截止 '+deadline(x.hideUntil,item.maxHideSeconds,item.source?.publishedUntil??null),'处理说明：'+x.summary];
  }else if(x.kind==='ordinary-strategy-draft'||x.kind==='ordinary-strategy-publish'){
   const prepared=await this.service('ordinaryStrategies','prepare').prepare(actor,x.kind==='ordinary-strategy-draft'?'draft':'publish',x);expiry(prepared.readExpiresAt);command=prepared.command;
   target={kind:'strategy',id:x.strategyId,label:label(prepared.strategy.name,'日常策略'),href:'/admin/operations/strategies?strategy='+x.strategyId};title=x.kind==='ordinary-strategy-draft'?'调整已批准边界内的日常策略':'发布已保存的日常策略调整';requiredAction=requiredActionFor(x);
   basis=[{label:'授权范围',value:'仅包含已批准的参数、启停及领导方式边界'}];impact=[x.kind==='ordinary-strategy-draft'?'保存一份受限草稿，后续仍需通过当前消费者预演。':'对新事项使用已预演的受限策略版本。'];
  }else if(x.kind==='message-draft-create'||x.kind==='message-draft-save'){
   const create=x.kind==='message-draft-create',config=humanDraftConfig(x.config),messaging=this.service('messaging','validateConfig');
   // The creation ID belongs to the original server operation/card. It is
   // never accepted in model arguments or replaced during card revalidation.
   const id=create?parse(z.uuid(),operationId):x.targetId;
   await transaction(this.db,db=>messaging.validateConfig(config,db));
   if(create)command={planId:id,config};
   else{
    const response=await messaging.get(actor,id),item=response.plan;expiry(response.readExpiresAt);
    cap(item?.id===id&&item.state==='draft'&&item.capabilities?.canSave);
    command={expectedVersion:item.version,expectedRevision:item.revision,config};
   }
   expiry(Math.floor(Date.parse(config.content.expiresAt)/1000));
   target={kind:'message-plan',id,label:label(config.content.title,'待核实消息草稿'),href:'/admin/operations/messaging?id='+id};title=create?'生成待人工核实的消息草稿':'保存待人工核实的消息草稿';requiredAction=requiredActionFor(x);
   basis=[{label:'事实与受众',value:'待人工核实；本操作不批准发布'},{label:'渠道',value:config.channels.map(channel=>({announcement:'公开公告',inapp:'站内信',email:'系统邮件'})[channel]).join('、')},
    {label:'受众草案',value:config.audience.kind==='all-accounts'?'全部符合条件的账户':config.audience.kind==='accounts'?'明确列出的 '+config.audience.accountIds.length+' 个账户':'主体类型：'+config.audience.subjectTypes.map(type=>({person:'个人',agent:'Agent',organization:'组织'})[type]).join('、')}];
   impact=['仅保存草稿，保存后仍需人工核实事实与受众；本操作不发布、不发送。','标题：'+config.content.title,'正文：',config.content.body,'正文链接：'+(config.content.href??'无'),
    '截止时间：'+config.content.expiresAt,'时间草案：'+(config.schedule.kind==='immediate'?'发布批准后立即执行':config.schedule.kind==='once'?config.schedule.at:config.schedule.cron+' · '+config.schedule.timezone)];
  }else if(x.kind==='messaging-state'){
   const response=await this.service('messaging','get').get(actor,x.targetId),item=response.plan;expiry(response.readExpiresAt);
   cap(item.capabilities?.[{activate:'canActivate',pause:'canPause',resume:'canResume',stop:'canStop',withdraw:'canWithdraw'}[x.action]]);
   target={kind:'message-plan',id:x.targetId,label:label(item.config?.content?.title,'消息计划'),href:'/admin/operations/messaging?id='+x.targetId};
   title=({activate:'发布这份消息计划',pause:'暂停这份消息计划',resume:'恢复这份消息计划',stop:'停止这份消息计划',withdraw:'撤回这份消息计划'})[x.action];
   requiredAction=['activate','resume'].includes(x.action)?'notices.publish':'notices.withdraw';command={expectedVersion:item.version,expectedRevision:item.revision};
   basis=[{label:'当前计划',value:({draft:'草稿',active:'运行中',paused:'已暂停',stopped:'已停止',expired:'已到期'})[item.effectiveState??item.state]??'未记录'},
    {label:'渠道',value:(item.config?.channels??[]).map(channel=>({announcement:'公开公告',inapp:'站内信',email:'系统邮件'})[channel]).filter(Boolean).join('、')||'未记录'}];
   const audience=item.config?.audience;basis.push({label:'受众',value:audience?.kind==='all-accounts'?'全部符合条件的账户':audience?.kind==='accounts'?'已选 '+audience.accountIds.length+' 个账户':audience?.kind==='attributes'?'主体类型：'+audience.subjectTypes.map(type=>({person:'个人',agent:'Agent',organization:'组织'})[type]).join('、'):'未记录'});
   impact=['activate','resume'].includes(x.action)?['按这份计划的内容、渠道和时间发布或发送；每次执行时确定并保留当次符合条件的受众。','邮件提交后是否送达，以实际回执为准。']:x.action==='withdraw'?['撤回已发布的公告和站内信，停止后续发送；已提交的邮件无法收回。']:[x.action==='pause'?'暂停后续发送，已发送的消息保持当前状态。':'停止后续发送，已发送的消息保持当前状态。'];
  }else if(x.kind==='strategy-control'){
   const item=await this.service('strategies','get').get(actor);cap(item.capabilities?.canControl);if(!item.active||item.paused===(x.action==='pause'))fail('operations_agentos_operation_unavailable');
   expiry(item.readExpiresAt);target={kind:'strategy-configuration',id:item.active.id,label:'当前已发布策略',href:'/admin/operations/strategy'};title=x.action==='pause'?'暂停策略执行':'恢复策略执行';requiredAction='strategies.control';command={expectedRevision:item.revision,kind:x.action,reason:x.reason};
   basis=[{label:'当前执行',value:item.paused?'已暂停':'已启用'}];impact=[x.action==='pause'?'暂停整套已发布策略的后续步骤；已经完成的处理不撤销。':'恢复整套已发布策略的后续步骤；已经完成的处理不会再次执行。'];
  }else if(x.kind==='strategy-continue'){
   const item=await this.service('strategies','runDetail').runDetail(actor,x.runId);expiry(item.readExpiresAt);if(item.run?.native?.status!=='PAUSED'||item.run.native.awaitingHuman!==true)fail('p13_run_not_paused');cap(item.run.canContinue);
   target={kind:'strategy-run',id:x.runId,label:label(item.run.strategy?.name,'策略事项'),href:'/admin/operations/strategy?tab=runs&run='+x.runId};title=x.decision==='proceed'?'同意推进这项处理':'不执行这项处理';requiredAction='strategies.run';
   command=item.run.native.pauseKind==='input'?{inputDecision:x.decision}:{confirmed:x.decision==='proceed'};basis=[{label:'当前步骤',value:label(item.run.native.currentStep,'等待本次人工决定')}];
   impact=[x.decision==='proceed'?'按原计划继续这项处理。若权限或内容状态已有变化，系统会停止相应动作。':'结束本次处理，不执行待确认动作。'];
  }else if(x.kind==='rule-publish'||x.kind==='rule-restore'){
   const service=this.service('rules','get'),item=await service.get(actor,x.key);expiry(item.readExpiresAt);
   cap(x.kind==='rule-publish'?item.capabilities?.canPublish:item.capabilities?.canRestore);await this.human(actor,'rules.write');
   let version=item.draft;
   if(x.kind==='rule-restore'){
    version=item.active?.id===x.versionId?item.active:null;let after=null,complete=false;
    for(let page=0;!version&&page<5;page++){
     const history=await service.versions(actor,x.key,{limit:50,...(after?{after}:{})});expiry(history.readExpiresAt);
     version=history.items?.find(row=>row.version?.id===x.versionId)?.version??(history.baseline?.id===x.versionId?history.baseline:null);
     if(!history.nextAfter){complete=true;break;}if(history.nextAfter===after)fail('operations_agentos_rule_review_required');after=history.nextAfter;
    }
    if(!version)fail(complete?'operations_rule_version_unavailable':'operations_agentos_rule_review_required',complete?404:409);
    if(!Number.isSafeInteger(version.publishedVersion)||version.publishedVersion<1)fail('operations_rule_version_not_published');
   }
   if(!version||version.key!==x.key)fail('operations_rule_draft_changed');
   const accountNames=new Map(),accountName=async id=>{
    if(accountNames.has(id))return accountNames.get(id);if(accountNames.size>=100)fail('operations_agentos_rule_review_required');
    const current=await this.service('accounts','get').get(actor,id),account=current.account;expiry(current.readExpiresAt);
    const name=label(account?.displayName,null),uid=label(account?.uid,null);if(!name&&!uid)fail('operations_agentos_rule_review_required');
    const value=name?(uid&&uid!==name?name+'（UID '+uid+'）':name):'UID '+uid;accountNames.set(id,value);return value;
   };
   const differences=await ruleDifference(x.key,item.active?.policy,version.policy,item.catalog??{},accountName);
   target={kind:'rule',id:x.key,label:ruleNames[x.key],href:'/admin/operations/rules?key='+encodeURIComponent(x.key)+'&version='+version.id};
   title=x.kind==='rule-publish'?'发布这份'+ruleNames[x.key]+'草稿':'恢复这份'+ruleNames[x.key]+'历史内容';requiredAction='rules.write';
   command={expectedRevision:item.revision,versionId:version.id,reason:x.reason};
   basis=[{label:'当前发布',value:'发布版本 '+item.active.publishedVersion},{label:x.kind==='rule-publish'?'已保存草稿':'目标历史内容',value:x.kind==='rule-publish'?'管理版本 '+version.version:'发布版本 '+version.publishedVersion}];
   impact=[...(differences.length?differences:['内容与当前发布相同，将记录为新的发布版本。']),
    x.key==='business-controls'?'只影响之后对应的新操作；既有内容不会被追溯处置。':'后续操作按新的额度和规则检查，已经发生的操作不撤销。',
    item.adoption?.mode==='current-transaction'?'后续对应操作会读取当前发布规则。':'各运行组件更新后采用，实际采用状态可在规则页查看。','变更说明：'+x.reason];
   if(impact.some(line=>line.length>5000)||impact.reduce((n,line)=>n+line.length,0)>20000)fail('operations_agentos_rule_review_required');
  }else if(x.kind==='recommendation-direction'){
   const item=await this.service('recommendations','overview').overview(actor,{days:7});expiry(item.readExpiresAt);cap(item.capabilities?.canConfigure);
   const policy=item.policy,theme=item.catalog?.items?.find(item=>item.key===x.themeKey);
   if(!theme||!Array.isArray(policy?.directions))fail('operations_agentos_operation_unavailable');
   command=parse(workbenchCommandSchemas[x.kind].omit({operationId:true}),{expectedVersion:policy.version,enabled:policy.enabled,themeKey:x.themeKey,direction:x.direction,controls:policy.controls,reason:x.reason,
    beforeDirections:policy.directions,themeVersion:theme.version,themeEnabled:theme.enabled});
   const before=command.beforeDirections.find(item=>item.key===x.themeKey)?.direction??'keep';
   if(before===x.direction||!theme.enabled&&policy.enabled&&x.direction!=='keep')fail('operations_agentos_operation_unavailable');
   target={kind:'recommendation-theme',id:x.themeKey,label:label(theme.label,'推荐主题'),href:'/admin/operations/recommendation?tab=strategy&id='+encodeURIComponent(x.themeKey)};
   title='调整「'+target.label+'」的推荐方向';requiredAction='recommendations.configure';
   basis=[{label:'当前方向',value:recommendationDirectionNames[before]},{label:'方向调控',value:policy.enabled?'已启用':'未启用'},{label:'主题状态',value:theme.enabled?'已启用':'已停用'}];
   impact=['展示机会：'+recommendationDirectionNames[before]+'改为'+recommendationDirectionNames[x.direction]+'。',
    !policy.enabled?'方向调控当前关闭，本次仅保存方向，不改变当前推荐排序。':!theme.enabled?'此主题仍停用，本次不启用主题。':'后续推荐按这一软性方向处理，个人需求、合格供给和负反馈仍参与排序。',
    '保留当前开关、重复与集中控制、其它主题方向及映射。','需要撤销时，可按最新配置恢复原方向。'];
  }else{
   const service=this.service('searchQuality','overview'),item=await service.overview(actor,{days:7,limit:1});expiry(item.readExpiresAt);const configuration=item.configuration;
   let version=configuration.draft;if(x.kind==='search-restore'){const history=await service.history(actor,{limit:50});version=[configuration.active,...(history.versions??[])].find(value=>value?.id===x.versionId);cap(version?.restorable);}
   cap(x.kind==='search-apply'?item.capabilities?.canPublish:item.capabilities?.canRestore);if(!version)fail('search_quality_version_unavailable');
   target={kind:'search-configuration',id:version.id,label:'搜索配置版本 '+version.version,href:'/admin/operations/search-quality?tab=versions'};title=x.kind==='search-apply'?'应用已保存的搜索草稿':'恢复这份搜索配置';requiredAction=x.kind==='search-apply'?'search-quality.publish':'search-quality.restore';command={expectedRevision:configuration.revision,versionId:version.id,reason:x.reason};
   basis=[{label:'可见范围',value:'已下架、到期、非公开或无权阅读的内容仍不进入搜索结果'}];impact=[x.kind==='search-apply'?'将这份草稿的同义词和排序设置用于后续搜索。':'将后续搜索恢复为所选历史版本的设置。','设置完成后才会显示为已生效；结果暂未取得时，系统会继续查询。','需要回退时，可在版本记录中恢复曾生效的配置。'];
  }
  await this.human(actor,requiredAction);if(readExpiresAt<=this.now())fail('operations_source_unavailable');
  return{schemaVersion:1,kind:x.kind,domain,request,command,target,title,impact,basis,requiredAction,checkedAt:this.now(),readExpiresAt,decisionSource:'human-required',...(review?{review}:{}),...(publicReference===undefined?{}:{publicReference:{...publicReference}})};
 }
 async executePrepared(operator,proposal,{authorize,operationId}={}){
  const x=parse(requestSchema(proposal?.request),proposal?.request);if(proposal?.schemaVersion!==1||proposal.kind!==x.kind)fail('invalid_operations_agentos_action',400);
  const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId:parse(z.uuid(),operationId)}),entry=workbenchActionCatalog.find(item=>item.kind===x.kind);
  const expectedAction=requiredActionFor(x);
  if(!entry||proposal.requiredAction!==expectedAction||typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  for(const key of ['reason','category','module','state','note','resolution','summary','restrictionAction','hideUntil','topic','pinned','featured','tagIds','strategyId','parameterEdits','mode','enabled'])if(Object.hasOwn(x,key)&&JSON.stringify(x[key])!==JSON.stringify(input[key]))fail('invalid_operations_agentos_action',400);
  if(x.kind==='public-content-batch'&&(!isDeepStrictEqual(x.items,input.items.map(item=>({kind:item.kind,id:item.id})))||input.kind!==x.action)||x.kind==='private-case-message'&&input.action!==x.action)fail('invalid_operations_agentos_action',400);
  if(['content-visibility','section-visibility','resource-visibility','strategy-control'].includes(x.kind)&&input.kind!==x.action||Object.hasOwn(x,'until')&&input.until!==x.until||['search-restore','rule-restore','ordinary-strategy-publish'].includes(x.kind)&&input.versionId!==x.versionId)fail('invalid_operations_agentos_action',400);
  if(x.kind==='account-restriction'&&(x.action==='apply')!==Object.hasOwn(input,'until'))fail('invalid_operations_agentos_action',400);
  if(x.kind==='file-access'&&(input.action!==x.action||(x.action==='stop')!==Object.hasOwn(input,'until')))fail('invalid_operations_agentos_action',400);
  if(x.kind==='recommendation-direction'&&(input.themeKey!==x.themeKey||input.direction!==x.direction))fail('invalid_operations_agentos_action',400);
  if(['message-draft-create','message-draft-save'].includes(x.kind)&&(!isDeepStrictEqual(input.config,humanDraftConfig(x.config))||proposal.target?.kind!=='message-plan'||proposal.target.id!==(x.kind==='message-draft-create'?operationId:x.targetId)||x.kind==='message-draft-create'&&input.planId!==operationId))fail('invalid_operations_agentos_action',400);
  const actor=await this.authority.human(operator,{domain:proposal.domain,action:expectedAction,authorize,purpose:this.authority.acceptsDuty?.(operator)?null:'prepare'}),
   // Services recheck a service actor on their own transaction connection.
   // An identity callback must not start a second PG lease inside that check.
   fresh=({db}={})=>this.authority.acceptsDuty?.(actor)?actor:this.human(actor,'workbench.read',{authorize,db});
  let result;
  if(['job-cancel','job-retry','search-retry'].includes(x.kind))result=await this.service('jobActions','command').command(actor,x.kind,x,input,{authorize:fresh});
  else if(x.kind==='ai-work-prompt-save'){
   if(this.authority.acceptsDuty?.(actor)||input.aiAccountId!==x.aiAccountId||input.prompt!==x.prompt||proposal.target?.kind!=='ai-work-prompt'||proposal.target.id!==x.aiAccountId)fail('invalid_operations_agentos_action',400);
   const {delegationVersion,...body}=input;result=await this.service('permissions','delegatedPromptSave').delegatedPromptSave(actor,body,{expectedDelegationVersion:delegationVersion});
  }else if(x.kind==='ai-role-command'){
   if(this.authority.acceptsDuty?.(actor)||!isDeepStrictEqual(input.command,x.command))fail('invalid_operations_agentos_action',400);
   result=await this.service('permissions','delegatedRoleSave').delegatedRoleSave(actor,{...input.command,operationId},{expectedDelegationVersion:input.delegationVersion});
  }else if(x.kind==='public-content-batch')result=await this.service('content','batch').batch(actor,input);
  else if(x.kind==='private-case-message')result=await this.service('chatReports','operatorMessageVisibility').operatorMessageVisibility(actor,{reportId:x.reportId,messageId:x.messageId},input,{authorize:fresh});
  else if(x.kind==='content-visibility')result=await this.service('content','visibility').visibility(actor,x.targetKind,x.targetId,input);
  else if(x.kind==='content-curation')result=await this.service('content','curate').curate(actor,x.targetKind,x.targetId,input);
  else if(x.kind==='section-classification')result=await this.service('community','classify').classify(actor,x.targetId,input);
  else if(x.kind==='section-visibility')result=await this.service('community','sectionVisibility').sectionVisibility(actor,x.targetId,input);
  else if(x.kind==='resource-visibility')result=await this.service('resources','visibility').visibility(actor,x.targetKind,x.targetId,input);
  else if(x.kind==='account-restriction'){
   try{const method=x.action==='apply'?'restrict':'releaseRestriction';result=await this.service('accounts',method)[method](actor,x.targetId,input);}
   catch(error){if(error?.code==='account_restriction_changed')fail('operations_agentos_restriction_changed');if(error?.code==='invalid_restriction_expiry')fail('operations_agentos_restriction_deadline',400);throw error;}
  }
  else if(x.kind==='feedback-update'){
   const service=this.service('feedback','event');
   try{result=await service.event(actor,x.targetId,input);}
   catch(error){
    // event() commits before its detail read. A later denial, missing source
    // or transport failure cannot prove that this exact effect did not occur.
    if(['invalid_feedback_request','feedback_revision_conflict','feedback_no_change'].includes(error?.code))throw error;
    return unknownFeedbackResult(operationId);
   }
  }
  else if(x.kind==='file-scan-retry'){if(input.kind!=='scan')fail('invalid_operations_agentos_action',400);result=await this.service('files','retry').retry(actor,x.targetKind,x.targetId,input,{authorize:fresh});}
  else if(x.kind==='file-access'){
   try{result=await this.service('fileAccess','change').change(actor,x.targetKind,x.targetId,input,{authorize:fresh});}
   catch(error){
    // change() commits its immutable event before its own final authorization
    // and detail read. A later denial/read error is not proof of no effect.
    // Only these closed, transaction-rejecting input/CAS cases are definite.
    if(['invalid_operations_request','business_admin_operation_conflict','operations_file_changed','operations_file_access_changed','operations_file_access_until','operations_file_access_unavailable','operations_file_access_restore_unavailable'].includes(error?.code))throw error;
    return{operationId,state:'unknown',summary:'本次处理结果暂时无法读取，系统会继续查询。',receipt:null};
   }
  }
  else if(x.kind==='file-cleanup-approve')result=await this.service('fileCleanup','approve').approve(actor,x.planId,input,{authorize:fresh});
  else if(x.kind==='case-resolve')result=await this.service('community','resolve').resolve(actor,x.targetId,input);
  else if(x.kind==='ordinary-strategy-draft'||x.kind==='ordinary-strategy-publish')result=await this.service('ordinaryStrategies','command').command(actor,x.kind==='ordinary-strategy-draft'?'draft':'publish',input);
  else if(x.kind==='message-draft-create')result=await this.service('messaging','create').create(actor,{operationId,config:input.config},{authorize:fresh,planId:operationId});
  else if(x.kind==='message-draft-save')result=await this.service('messaging','save').save(actor,x.targetId,input,{authorize:fresh});
  else if(x.kind==='messaging-state')result=await this.service('messaging','action').action(actor,x.targetId,x.action,input,{authorize:fresh});
  else if(x.kind==='strategy-control')result=await this.service('strategies','control').control(actor,input,{authorize:fresh});
  else if(x.kind==='strategy-continue')result=await this.service('strategies','continue').continue(actor,x.runId,input,{authorize:fresh});
  else if(x.kind==='rule-publish'||x.kind==='rule-restore')result=await this.service('rules',x.kind==='rule-publish'?'publish':'restore')[x.kind==='rule-publish'?'publish':'restore'](actor,x.key,input,{authorize:fresh});
  else if(x.kind==='recommendation-direction'){
   try{result=await this.service('recommendations','savePolicy').savePolicy(actor,recommendationPolicyInput(input),{authorize:fresh,expectedTheme:{key:input.themeKey,expectedVersion:input.themeVersion,enabled:input.themeEnabled}});}
   catch(error){
    if(['invalid_recommendation_request','recommendation_policy_changed','recommendation_theme_changed','recommendation_theme_unavailable','recommendation_operation_conflict'].includes(error?.code))throw error;
    return unknownRecommendationResult(operationId);
   }
  }
  else result=await this.service('searchQuality','command').command(actor,x.kind==='search-apply'?'apply':'restore',input,{authorize:fresh});
  // The domain call has returned and may already have committed. A failed
  // final authorization cannot turn that effect into an unexecuted command.
  // Keep only the original ID so current authority can recover its receipt.
  try{await this.human(actor,expectedAction,{authorize});}
  catch{return{operationId,state:'unknown',summary:'本次处理结果暂时无法读取，系统会继续查询。',receipt:null};}
  return actionResult(x.kind,result,operationId,x,proposal.command);
 }
 async assertPriorDutyDecisionWithin(db,actor,request,grantId){
  const actions={
   'content-visibility':['community-content-visibility','community-content-batch-visibility'],'content-curation':['community-content-curation'],
   'section-classification':['community-section-classify'],'section-visibility':['community-section-visibility'],
   'resource-visibility':['resource-visibility'],'account-restriction':['restriction-set','restriction-release'],
   'feedback-update':['feedback-update'],'file-access':['file-access-stop','file-access-restore'],'case-resolve':['community-report-resolve'],
   'recommendation-direction':['recommendations.configure'],'search-apply':['search-quality.publish','search-quality.restore'],'search-restore':['search-quality.publish','search-quality.restore'],
   'messaging-state':['notice-publish','notice-withdraw'],
  }[request.kind];
  if(!actions)return;
  const id=request.targetId??request.versionId??null,rows=(await db.query(`SELECT actor_kind,operator_id,grant_id,operation_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND action=ANY($2::text[])
   AND ($3::text IS NULL OR account_id::text=$3 OR selection->>'id'=$3 OR selection->>'resourceId'=$3 OR selection->>'planId'=$3 OR selection->'items' @> jsonb_build_array(jsonb_build_object('id',$3::text)))
   ORDER BY sequence DESC LIMIT 1`,[this.endpoint,actions,id])).rows;
  const previous=rows[0];if(previous&&(previous.actor_kind!=='operations-ai-service'||previous.operator_id!==actor.operatorId||previous.grant_id!==grantId))fail('operations_agentos_human_review_required',409);
 }
 async qualifyDutyTargetWithin(db,{actor,permission,targetId,request,command,grantId=null}){
  const x=parse(requestSchema(request),request);if(requiredActionFor(x)!==permission||!this.dutyActionReady(permission))fail('operations_agentos_action_not_connected',503);
  const expected=x.targetId??x.reportId??x.strategyId??(x.kind==='public-content-batch'?targetId:x.kind==='recommendation-direction'?x.themeKey:x.kind==='message-draft-create'?command?.planId:command?.versionId);if(expected!==targetId||x.kind==='public-content-batch'&&!x.items.some(item=>item.id===targetId))fail('operations_agentos_scope_denied',403);
  if(['job-cancel','job-retry','search-retry'].includes(x.kind)){
   await this.service('jobActions','qualifyWithin').qualifyWithin(db,actor,x.kind,x,command);
  }else if(x.kind==='public-content-batch'){
   for(const item of x.items){const service=this.service('content','rawWithin'),source=await service.rawWithin(db,item.kind,item.id);if(!(await service.publicSourceWithin(db,item.kind,source.head,source.source)).available)fail('operations_source_unavailable',409);if(grantId)await this.assertPriorDutyDecisionWithin(db,actor,{kind:'content-visibility',targetId:item.id},grantId);}
  }else if(x.kind==='private-case-message'){
   const g=this.service('chatReports','assertDutyCaseWithin');await g.assertDutyCaseWithin(db,actor,x.reportId);const row=await g.row(db,x.reportId),context=await g.contextWithin(db,row,actor,{operator:true});if(!context.canModerate||g.expired(row))fail('operations_agentos_human_review_required',409);
   const materials=(await db.query('SELECT * FROM account_chat_governance_materials_v1 WHERE report_id=$1 AND message_id=$2 AND revision=$3 AND erased_at IS NULL',[x.reportId,x.messageId,command.messageRevision])).rows;if(!materials.length||!await g.sourceStillAvailableWithin(db,materials[0]))fail('chat_report_source_unavailable',409);
   if(grantId){const prior=(await db.query("SELECT actor_kind,operator_id,grant_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='chat-report-event' AND selection->>'reportId'=$2 AND selection->>'messageId'=$3 ORDER BY sequence DESC LIMIT 1",[this.endpoint,x.reportId,x.messageId])).rows[0];if(prior&&(prior.actor_kind!=='operations-ai-service'||prior.operator_id!==actor.operatorId||prior.grant_id!==grantId))fail('operations_agentos_human_review_required',409);}
  }else if(x.kind==='content-visibility'||x.kind==='content-curation'){
   const source=await this.service('content','rawWithin').rawWithin(db,x.targetKind,x.targetId),state=await this.services.content.publicSourceWithin(db,x.targetKind,source.head,source.source);
   if(!state.available)fail('operations_source_unavailable',409);
  }else if(x.kind==='resource-visibility'){
   const service=this.service('resources','rowWithin'),row=await service.rowWithin(db,x.targetKind,x.targetId);if((await service.sourceWithin(db,x.targetKind,row)).state!=='available')fail('operations_source_unavailable',409);
  }else if(x.kind==='section-visibility'||x.kind==='section-classification'){
   const service=this.service('community','sectionWithin'),row=await service.sectionWithin(db,x.targetId);if((await service.sectionViewWithin(db,row,actor)).sourceState!=='available')fail('operations_source_unavailable',409);
  }else if(x.kind==='case-resolve'){
   const service=this.service('community','reportWithin'),row=await service.reportWithin(db,x.targetId),view=await service.reportViewWithin(db,row,actor,{detail:true});
   if(!view.canModerate||view.source.availability!=='available')fail('operations_agentos_human_review_required',409);
   if(row.decision_event_id&&(await db.query('SELECT 1 FROM forum_governance_events_v1 WHERE id=$1',[row.decision_event_id])).rows.length)fail('operations_agentos_human_review_required',409);
  }else if(x.kind==='account-restriction')await this.service('accounts','accountWithin').accountWithin(db,x.targetId);
  else if(x.kind==='feedback-update')await this.service('feedback','headWithin').headWithin(db,x.targetId);
  else if(x.kind==='file-access'||x.kind==='file-scan-retry')await this.service(x.kind==='file-access'?'fileAccess':'files','scopedRowWithin').scopedRowWithin(db,x.targetKind,x.targetId);
  else if(x.kind==='recommendation-direction'){
   const catalog=await this.service('recommendations','catalogWithin').catalogWithin(db);if(!catalog.some(theme=>theme.key===x.themeKey&&theme.enabled))fail('recommendation_theme_unavailable',409);
  }else if(x.kind==='search-apply'||x.kind==='search-restore'){
   const selected=await this.service('searchQuality','versionWithin').versionWithin(db,command.versionId);if(!selected)fail('search_quality_version_unavailable',409);
  }else if(x.kind==='ordinary-strategy-draft'||x.kind==='ordinary-strategy-publish'){
   const current=await this.service('ordinaryStrategies','inspectWithin').inspectWithin(db,actor,x.strategyId);if(current.head.paused||!current.strategy.ordinaryBounds||current.strategy.mode==='human-led')fail('operations_agentos_human_review_required',409);
  }else if(x.kind==='message-draft-create'||x.kind==='message-draft-save'){
   if(!isDeepStrictEqual(command?.config,humanDraftConfig(x.config)))fail('operations_agentos_scope_denied',403);
   // Eligible scope proves only a new, unapproved draft or a current draft.
   // It grants no publication, delivery, fact or audience approval.
   await this.service('messaging','assertDutyDraftWithin').assertDutyDraftWithin(db,actor,{planId:targetId,kind:x.kind==='message-draft-create'?'create':'save',config:command.config});
  }else if(x.kind==='messaging-state'){
   const messaging=this.service('messaging','assertDutyPlanWithin'),plan=await messaging.planWithin(db,x.targetId);await messaging.assertDutyPlanWithin(db,actor,plan,x.action);
  }else fail('operations_agentos_action_not_connected',503);
  if(grantId)await this.assertPriorDutyDecisionWithin(db,actor,x,grantId);
  return{allowed:true};
 }
 async qualifyDutyBatchImpactWithin(db,actor,request,approved){
  const ids=request.items.map(item=>item.id),context=this.authority.dutyContext(actor),task=(await db.query('SELECT configuration FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,context.taskId])).rows[0],grant=(await db.query('SELECT resource_scope_kind,resource_ids FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,approved.grantId])).rows[0],version=(await db.query('SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,approved.strategyVersionId])).rows[0],scope=version?.configuration.strategies.find(item=>item.id===approved.strategyId)?.execution?.resourceScope;
  const planIds=task?.configuration.plan?.resourceIds;if(!Array.isArray(planIds)||!planIds.length||grant?.resource_scope_kind!=='selected'||scope?.kind!=='selected'||ids.some(id=>!planIds.includes(id)||!grant.resource_ids.includes(id)||!scope.resourceIds.includes(id)))fail('operations_agentos_human_review_required',409);
 }
 async dutyReceipt(actor,stored){
  const proposal=stored.proposal,operationId=stored.operation_id,result=await this.recoverPrepared(actor,proposal,operationId);
  // recoverPrepared reads immutable domain receipts; a model/tool ACK alone
  // never supplies the completed business state used by the task dashboard.
  const effectState=result.state==='completed'?'completed':result.state==='failed'?'failed':'unknown';
  const value={...result,operationId,effectState,target:proposal.target,basis:effectState==='completed'?'persisted-domain-operation-receipt':'original-operation-query'};
  await this.db.query('UPDATE operations_ai_duty_operations_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId,effectState,JSON.stringify(value),new Date(this.now()*1000)]);return value;
 }
 async executeDutyOperation({actor,operationId,arguments:input,authorizeOperation,reconcile=false}={}){
  if(!this.authority.acceptsDuty(actor)||typeof authorizeOperation!=='function')fail('operations_ai_duty_operation_denied',403);
  parse(z.uuid(),operationId);const request=parse(requestSchema(input),input),permission=requiredActionFor(request),definition=aiActionDefinition(permission);
  if(!this.dutyKinds.has(request.kind))fail('operations_agentos_action_not_connected',503);
  if(!definition?.autonomous||definition.humanOnly)return{operationId,state:'waiting-human',effectState:'not-started',code:'operations_agentos_human_review_required',basis:'fixed-human-condition'};
  if(!this.dutyActionReady(permission))return{operationId,state:'waiting-human',effectState:'not-started',code:'operations_agentos_action_not_connected',basis:'handler-not-connected'};
  const prior=(await this.db.query('SELECT * FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
  if(prior){if(prior.task_id!==actor.taskId||prior.ai_account_id!==actor.aiAccountId||!isDeepStrictEqual(prior.request,request))fail('operations_agentos_operation_conflict');return this.dutyReceipt(actor,prior);}
  if(reconcile)return{operationId,state:'unknown',effectState:'unknown',code:'operations_agentos_original_operation_not_recorded',basis:'original-operation-query'};
  const proposal=await this.prepareFor(actor,actor.domain,request,{operationId}),targetId=proposal.target.id;
  const verify=async(db,operation)=>{
   const approved=await authorizeOperation(db,operation);if(approved?.allowed!==true||!approved.grantId||!approved.strategyId)fail('operations_ai_duty_operation_denied',403);
   if(request.kind==='public-content-batch'){
    await this.qualifyDutyBatchImpactWithin(db,operation.actor,request,approved);
    for(const item of request.items){const current=await authorizeOperation(db,{...operation,targetId:item.id});if(current?.allowed!==true||['grantId','grantVersion','strategyId','strategyVersionId'].some(key=>current[key]!==approved[key]))fail('operations_agentos_human_review_required',409);}
   }
   await this.qualifyDutyTargetWithin(db,{...operation,grantId:approved.grantId});return approved;
  };
  const bound=await this.authority.bindDutyOperation(actor,{permission,operationId,targetId,request,command:proposal.command},{authorizeOperation:verify}),binding=this.authority.dutyMetadata(bound),
   frozen={schemaVersion:1,kind:proposal.kind,domain:proposal.domain,request:proposal.request,command:proposal.command,target:{kind:proposal.target.kind,id:proposal.target.id},requiredAction:proposal.requiredAction,decisionSource:'approved-automatic-plan'};
  const stored=await transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912487))',[this.endpoint+':'+operationId]);
   const row=(await db.query('SELECT * FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];if(row)return{row,existing:true};
   return{row:(await db.query(`INSERT INTO operations_ai_duty_operations_v1(operation_id,endpoint,task_id,ai_account_id,kind,request,proposal,binding,state,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dispatching',$9,$9) RETURNING *`,[operationId,this.endpoint,actor.taskId,actor.aiAccountId,request.kind,JSON.stringify(request),JSON.stringify(frozen),JSON.stringify(binding),new Date(this.now()*1000)])).rows[0],existing:false};
  });
  if(!isDeepStrictEqual(stored.row.request,request)||stored.row.task_id!==actor.taskId)fail('operations_agentos_operation_conflict');
  if(stored.existing)return this.dutyReceipt(actor,stored.row);
  try{
   await this.executePrepared(bound,proposal,{operationId,authorize:()=>bound});
   return await this.dutyReceipt(actor,stored.row);
  }catch(error){
   await this.db.query("UPDATE operations_ai_duty_operations_v1 SET state='unknown',updated_at=$3 WHERE endpoint=$1 AND operation_id=$2",[this.endpoint,operationId,new Date(this.now()*1000)]);
   if(error.code==='operations_agentos_human_review_required')return{operationId,state:'waiting-human',effectState:'unknown',code:error.code,basis:'current-human-condition'};
   throw error;
  }
 }
 async recoverPrepared(operator,proposal,operationId){
  const x=parse(requestSchema(proposal?.request),proposal?.request);parse(z.uuid(),operationId);if(proposal?.schemaVersion!==1||proposal.kind!==x.kind||proposal.requiredAction!==requiredActionFor(x))fail('invalid_operations_agentos_action',400);
  const entry=workbenchActionCatalog.find(item=>item.kind===x.kind);if(!entry)fail('invalid_operations_agentos_action',400);
  // Pure recovery reads the original durable result. Losing permission for a
  // new write must not hide an owned receipt from a currently qualified reader.
  const currentRead=actor=>this.authority.human(actor,{domain:proposal.domain,action:entry.read,purpose:x.kind==='private-case-message'?'prepare':'query'});
  const actor=await currentRead(operator),missing={operationId,state:'not-recorded',summary:'尚未记录本次处理。',receipt:null};let result;
  if(['job-cancel','job-retry','search-retry'].includes(x.kind)){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId});
   if(input.reason!==x.reason)fail('operations_agentos_operation_conflict');
   result=await this.service('jobActions','operation').operation(actor,x.kind,x,proposal.command,operationId);if(!result)return missing;
  }else if(x.kind==='ai-work-prompt-save'||x.kind==='ai-role-command'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId}),body=x.kind==='ai-work-prompt-save'?pick(input,['operationId','aiAccountId','expectedRevision','expectedPromptVersion','prompt']):{...input.command,operationId},kind=x.kind==='ai-work-prompt-save'?'prompt-save':x.command.kind;
   if(x.kind==='ai-work-prompt-save'&&(body.aiAccountId!==x.aiAccountId||body.prompt!==x.prompt)||x.kind==='ai-role-command'&&!isDeepStrictEqual(input.command,x.command))fail('operations_agentos_operation_conflict');
   const saved=await this.service('permissions','delegatedManagementOperation').delegatedManagementOperation(actor,operationId,{kind,input:body});if(saved.state==='not-recorded')return missing;result=saved.result;
  }else if(x.kind==='public-content-batch'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId}),{reason,...metadata}=input,row=(await this.db.query('SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];if(!row)return missing;
   if(row.operator_id!==actor.operatorId||row.action!=='community-content-batch-visibility'||!isDeepStrictEqual(row.selection,{...metadata,reasonDigest:createHash('sha256').update(reason).digest('hex')}))fail('operations_agentos_operation_conflict');result=row.result;
  }else if(x.kind==='private-case-message'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId}),g=this.service('chatReports','assertDutyCaseWithin');if(this.authority.acceptsDuty?.(actor))await transaction(this.db,db=>g.assertDutyCaseWithin(db,actor,x.reportId));
   const event=(await this.db.query('SELECT actor_kind,operator_id,version,input FROM account_chat_governance_events_v1 WHERE id=$1 AND report_id=$2',[operationId,x.reportId])).rows[0],audit=(await this.db.query("SELECT result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2 AND action='chat-report-event'",[this.endpoint,operationId])).rows[0];if(!event||!audit)return missing;
   if(event.actor_kind!==actor.kind||event.operator_id!==actor.operatorId||!isDeepStrictEqual(event.input,{...input,reportId:x.reportId,messageId:x.messageId,kind:'message-'+x.action}))fail('operations_agentos_operation_conflict');result={operationId,reportId:x.reportId,version:event.version,revision:audit.result.revision,replayed:true};
  }else if(x.kind==='ordinary-strategy-draft'||x.kind==='ordinary-strategy-publish'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId}),saved=await this.service('ordinaryStrategies','operation').operation(actor,x.strategyId,operationId);
   if(saved.state==='not-recorded')return missing;if(saved.kind!==(x.kind==='ordinary-strategy-draft'?'ordinary-draft':'ordinary-publish')||!isDeepStrictEqual(saved.input,input))fail('operations_agentos_operation_conflict');result=saved.result;
  }else if(x.kind==='account-restriction'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId}),row=(await this.db.query('SELECT operator_id,account_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
   if(input.reason!==x.reason||(x.action==='apply')!==Object.hasOwn(input,'until')||x.action==='apply'&&input.until!==x.until)fail('operations_agentos_operation_conflict');
   if(!row)return missing;
   if(row.operator_id!==actor.operatorId||row.account_id!==x.targetId||row.action!==(x.action==='apply'?'restriction-set':'restriction-release')||!isDeepStrictEqual(row.selection,input))fail('operations_agentos_operation_conflict');
   result=row.result;
  }else if(x.kind==='feedback-update'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId});
   for(const key of ['category','module','state','note'])if(Object.hasOwn(x,key)&&!isDeepStrictEqual(x[key],input[key]))fail('operations_agentos_operation_conflict');
   // The domain reader validates the real immutable feedback audit receipt.
   // It never reads private notes as recovery material or repeats the effect.
   const saved=await this.service('feedback','operation').operation(actor,x.targetId,operationId);
   if(saved.state==='not-recorded')return missing;
   const selection={expectedRevision:input.expectedRevision,...pick(input,['category','module','state']),noteHash:input.note?createHash('sha256').update(input.note).digest('hex'):null};
   if(saved.state!=='recorded'||saved.operationId!==operationId||saved.feedbackId!==x.targetId||saved.action!=='feedback-update'||!isDeepStrictEqual(saved.selection,selection))fail('operations_agentos_operation_conflict');
   result={...saved.result,replayed:saved.replayed===true};
  }else if(x.kind==='recommendation-direction'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId}),body=recommendationPolicyInput(input);
   if(input.themeKey!==x.themeKey||input.direction!==x.direction||input.reason!==x.reason)fail('operations_agentos_operation_conflict');
   const saved=await this.service('recommendations','commandResult').commandResult(actor,operationId),row=(await this.db.query(
    'SELECT operator_id,kind,revision,theme_key,request_hash,result FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
   if(!row){
    if(saved.state==='recorded')fail('operations_agentos_operation_conflict');
    await currentRead(actor);
    // An attempted card's absent receipt is not proof that a delayed request
    // cannot arrive. Keep recovery read-only, rather than re-arm this card.
    return unknownRecommendationResult(operationId);
   }
   const requestHash=createHash('sha256').update(canonicalize({kind:'policy',input:body})).digest('hex');
   if(row.operator_id!==actor.operatorId||row.kind!=='policy-updated'||row.theme_key!==x.themeKey||row.request_hash!==requestHash
    ||row.revision!==input.expectedVersion+1||saved.state!=='recorded'||saved.operationId!==operationId||saved.kind!=='policy'
    ||saved.result?.version!==row.revision||saved.result?.themeKey!==x.themeKey)fail('operations_agentos_operation_conflict');
   result={...row.result,replayed:true};
  }else if(x.kind==='file-access'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId});
   if(input.action!==x.action||input.reason!==x.reason||(x.action==='stop')!==Object.hasOwn(input,'until')||x.action==='stop'&&input.until!==x.until)fail('operations_agentos_operation_conflict');
   // The public GET intentionally omits reason and CAS. Match every frozen
   // input against the same endpoint's immutable event before using its receipt.
   const saved=await this.service('fileAccess','operation').operation(actor,operationId),row=(await this.db.query(`SELECT operator_id,kind,file_id,action,expected_version,expected_revision,reason,stopped_until,revision
    FROM operations_file_access_events_v1 WHERE endpoint=$1 AND operation_id=$2`,[this.endpoint,operationId])).rows[0];
   if(!row){if(saved.state==='recorded')fail('operations_agentos_operation_conflict');return missing;}
   const until=row.stopped_until?Math.floor(new Date(row.stopped_until).getTime()/1000):null;
   if(row.operator_id!==actor.operatorId||row.kind!==x.targetKind||row.file_id!==x.targetId||row.action!==x.action||row.expected_version!==input.expectedVersion
    ||row.expected_revision!==input.expectedRevision||row.reason!==input.reason||until!==(input.until??null)||saved.state!=='recorded'||saved.revision!==row.revision)fail('operations_agentos_operation_conflict');
   result={...saved,replayed:true};
  }else if(x.kind==='file-cleanup-approve'){
   const input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId}),row=(await this.db.query('SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
   if(!row)return missing;
   if(row.operator_id!==actor.operatorId||row.action!=='file-cleanup-approve'||!isDeepStrictEqual(row.selection,{operationId,id:x.planId,command:input,resourceId:x.planId}))fail('operations_agentos_operation_conflict');
   const service=this.service('fileCleanup','operation'),saved=await service.operation(actor,operationId);
   if(saved.state!=='recorded')return missing;if(saved.kind!=='approve'||saved.planId!==x.planId)fail('operations_agentos_operation_conflict');
   result={...row.result,plan:await service.plan(actor,x.planId)};
  }else if(x.kind==='search-apply'||x.kind==='search-restore'){
   const stored=(await this.db.query('SELECT operator_id,kind,version_id FROM operations_search_quality_operations_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];if(!stored)return missing;
   if(stored.operator_id!==actor.operatorId||stored.kind!==(x.kind==='search-apply'?'apply':'restore')||stored.version_id!==proposal.command.versionId)fail('operations_agentos_operation_conflict');
   try{result=await this.service('searchQuality','operation').operation(actor,operationId);}catch(error){if(error.code==='search_quality_operation_unavailable'&&error.status===404)return missing;throw error;}
  }else if(x.kind==='rule-publish'||x.kind==='rule-restore'){
   const kind=x.kind==='rule-publish'?'publish':'restore',row=(await this.db.query('SELECT operator_id,policy_key,kind,input FROM operations_p14_rule_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
   if(!row)return missing;if(row.operator_id!==actor.operatorId||row.policy_key!==x.key||row.kind!==kind||!isDeepStrictEqual(row.input,{...proposal.command,operationId}))fail('operations_agentos_operation_conflict');
   result=await this.service('rules','operation').operation(actor,operationId);if(result.state!=='recorded')return missing;
  }else if(x.kind==='strategy-control'||x.kind==='strategy-continue'){
   const service=this.service('strategies','operation'),saved=await service.operation(actor,operationId);if(saved.state==='not-recorded')return missing;
   if(saved.kind!==(x.kind==='strategy-control'?'control':'continue'))fail('operations_agentos_operation_conflict');
   result=saved.result;
   if(x.kind==='strategy-continue'){
    if(saved.result?.runId!==x.runId)fail('operations_agentos_operation_conflict');const current=await service.runDetail(actor,x.runId);result={...current,operationId};
    // A persisted human decision is not proof that the native continuation was
    // accepted. GET never calls continue or manufactures a replacement intent.
    if(current.run?.native?.awaitingHuman){
     if(saved.continuation?.state==='accepted'){await currentRead(actor);return{operationId,state:'processing',summary:'本次决定已受理，正在读取处理进展。',receipt:safeReceipt(result)};}
     result={...current,run:{...current.run,state:'unknown'},operationId};
    }
   }
  }else if(x.kind==='message-draft-create'||x.kind==='message-draft-save'){
   const create=x.kind==='message-draft-create',input=parse(workbenchCommandSchemas[x.kind],{...proposal.command,operationId}),planId=create?operationId:x.targetId,
    saved=await this.service('messaging','commandResult').commandResult(actor,operationId),row=(await this.db.query('SELECT operator_id,kind,input,result FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
   if(!isDeepStrictEqual(input.config,humanDraftConfig(x.config))||proposal.target?.id!==planId||create&&input.planId!==planId)fail('operations_agentos_operation_conflict');
   if(!row){if(saved.state==='recorded')fail('operations_agentos_operation_conflict');return missing;}
   const expected=create?input:{...input,planId};
   if(row.operator_id!==actor.operatorId||row.kind!==(create?'create':'save')||!isDeepStrictEqual(row.input,expected)||saved.state!=='recorded'||saved.operationId!==operationId||saved.result?.planId!==planId||saved.result?.state!=='draft'||saved.result?.version!==row.result?.plan?.version||saved.result?.revision!==row.result?.plan?.revision)fail('operations_agentos_operation_conflict');
   result={...row.result,replayed:true};
  }else if(x.kind==='messaging-state'){
   const row=(await this.db.query('SELECT operator_id,kind,input,result FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];if(!row)return missing;
   if(row.operator_id!==actor.operatorId||row.kind!==x.action||row.input?.planId!==x.targetId)fail('operations_agentos_operation_conflict');result=row.result;
  }else{
   const actions={'content-visibility':'community-content-visibility','content-curation':'community-content-curation','section-classification':'community-section-classify','section-visibility':'community-section-visibility','resource-visibility':'resource-visibility','feedback-update':'feedback-update','file-scan-retry':'file-retry','case-resolve':'community-report-resolve'},
    row=(await this.db.query('SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];if(!row)return missing;
   if(row.operator_id!==actor.operatorId||row.action!==actions[x.kind]||row.selection?.id!==x.targetId)fail('operations_agentos_operation_conflict');
   const selectionKind=x.kind==='content-visibility'?row.selection.targetKind:row.selection.kind;
   if(x.targetKind&&selectionKind!==x.targetKind)fail('operations_agentos_operation_conflict');result=row.result;
  }
  await currentRead(actor);return actionResult(x.kind,result,operationId,x,proposal.command,'receipt');
 }
 async listAuthorizedWork(operator,domain){
  // A grant-bound autonomous execution and a manager-confirmed preparation
  // are separate capabilities. An empty or denied execution directory must
  // not decide whether this current actor can prepare a human card.
  const finish=async(items,complete,readExpiresAt,availability='available')=>{
   const preparer=await this.authority.human(operator,{domain,purpose:'prepare'});
   const availableKinds=aiWorkCapabilities(domain,preparer.businessAuthorization.permissions).preparableKinds;
   return{items,basis:{scope:'owned-explicit-authorized-work',complete,availability},
    humanPreparation:{tool:'prepare-operation',availableKinds,requiresAuthorizedExecution:false,requiresHumanConfirmation:true,objectEligibility:'checked-when-preparing'},
    checkedAt:this.now(),readExpiresAt:Math.min(readExpiresAt,this.now()+30)};
  };
  let actor,directory;
  try{
   actor=await this.authority.human(operator,{domain,purpose:'execution'});
   if(!actor.businessAuthorization.permissions.some(code=>this.authority.supported.has(code)))return finish([],false,this.now()+30,'not-authorized');
   directory=await this.authority.list(actor);
  }catch(error){
   if(error.status!==403||error.code!=='operations_permission_denied')throw error;
   return finish([],false,this.now()+30,'not-authorized');
  }
  const items=[];let readExpiresAt=this.now()+30;
  for(const execution of directory.items){if(execution.executorKind!=='ai'||execution.state!=='active'||!execution.hasPreparedCommand||execution.domain!==domain)continue;
   try{const item=await this.inspectWork(actor,execution.id);readExpiresAt=Math.min(readExpiresAt,item.readExpiresAt);items.push(item);}catch(error){if(![403,404,409,410].includes(error.status))throw error;items.push({executionId:execution.id,domain:execution.domain,target:null,action:null,available:false,code:'operations_agentos_work_unavailable'});}
  }
  return finish(items,directory.items.length<100,readExpiresAt);
 }
 async inspectWork(operator,id){
  const stored=await this.authority.get(operator,id),execution=stored.execution,command=stored.preparedAction;if(!command)fail('operations_agentos_prepared_command_required');
  const actor=await this.authority.actor(id,{resourceIds:[command.targetId],caller:operator});await this.authority.requireAction(actor,'content.read');
  const response=await this.service('content','get').get(actor,command.targetKind,command.targetId),item=response.content;
  const bindings=(await this.db.query('SELECT id,state FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND execution_id=$2',[this.endpoint,id])).rows;
  const reviews=(await this.db.query("SELECT id FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND execution_id=$2 AND kind='review' LIMIT 1",[this.endpoint,id])).rows;
  let priorDecisionAllowed=true;try{await transaction(this.db,db=>this.gateway.checkPriorDecision(db,actor,command));}catch(error){if(error.code!=='operations_agentos_human_review_required')throw error;priorDecisionAllowed=false;}
  const sourceMatches=item.sourceState==='available'&&item.version===command.input.expectedVersion&&item.visibility.version===command.input.expectedRevision;
  const can=command.input.kind==='hide'?item.capabilities?.canHide:item.capabilities?.canRestore;
  const temporal=command.input.kind==='restore'||Number.isSafeInteger(item.maxHideSeconds)&&command.input.until>this.now()&&command.input.until<=this.now()+item.maxHideSeconds;
  const available=sourceMatches&&can===true&&temporal&&priorDecisionAllowed&&!bindings.length&&!reviews.length;
  return{executionId:id,domain:execution.domain,action:'content.'+command.input.kind,target:{kind:command.targetKind,id:command.targetId,label:label(item.title,command.targetKind==='post'?'公开帖子':'公开回复'),href:'/admin/operations/community?tab=posts&contentKind='+command.targetKind+'&id='+command.targetId},
   available,code:bindings.length?'operations_agentos_workflow_bound':reviews.length?'operations_agentos_human_review_required':!priorDecisionAllowed?'operations_agentos_human_review_required':available?null:'operations_agentos_work_unavailable',
   strategyRunId:bindings[0]?.id??null,checkedAt:this.now(),readExpiresAt:Math.min(this.now()+30,item.publishedUntil??this.now())};
 }
 async runAuthorizedWork(actor,domain,id){
  actor=await this.authority.human(actor,{domain,purpose:'execution'});
  const stored=await this.authority.get(actor,id);if(stored.execution.executorKind!=='ai'||stored.execution.domain!==domain)fail('operations_agentos_domain_mismatch',403);
  await this.authority.actor(id,{caller:actor});
  const completed=(await this.db.query("SELECT result FROM operations_agentos_tool_calls_v1 WHERE endpoint=$1 AND execution_id=$2 AND tool='execute-prepared-command' AND state='completed' ORDER BY created_at LIMIT 1",[this.endpoint,id])).rows[0];
  if(completed?.result)return{state:'completed',replayed:true,result:safeReceipt(completed.result)};
  const item=await this.inspectWork(actor,id);if(!item.available)return{state:item.code==='operations_agentos_human_review_required'||item.code==='operations_agentos_workflow_bound'?'requires-human':'unavailable',...item};
  // One execution already freezes one command. A second model call must query
  // that same effect rather than manufacture another business operation ID.
  const runId='workbench-'+createHash('sha256').update(id).digest('hex');
  const result=await this.gateway.execute({executionId:id,runId,callId:'workbench-prepared-command',tool:'execute-prepared-command',arguments:{}},{caller:actor});
  return{state:'completed',executionId:id,result:safeReceipt(result)};
 }
 async execute(input){
  const x=parse(workbenchActionToolSchema,input),{row,actor}=await this.conversations.current(x.conversationId);if(row.session_id!==x.sessionId)fail('operations_agentos_scope_denied',403);let result;
  if(x.tool==='list-authorized-work'){parse(workbenchEmptyArgumentsSchema,x.arguments);result=await this.listAuthorizedWork(actor,row.domain);}
  else if(x.tool==='run-authorized-work'){const args=parse(workbenchRunArgumentsSchema,x.arguments);result=await this.runAuthorizedWork(actor,row.domain,args.executionId);}
  else result={state:'prepared',proposal:await this.prepareFor(actor,row.domain,x.arguments)};
  await this.conversations.current(row.id);return result;
 }
}
