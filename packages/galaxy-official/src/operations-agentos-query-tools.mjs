import {isDeepStrictEqual} from 'node:util';
import {ServiceError} from './shared/service-error.mjs';
import {agentOsQueryArgumentsSchema,agentOsReadArgumentsSchema,agentOsQueryDomains} from './shared/operations-agentos-query-schema.mjs';
import {agentOsQueryReadAction} from './shared/operations-agentos-query-access.mjs';
import {project,text,number,accountItem,contentItem,sectionItem,caseItem,caseDetail,caseMaterialVersion,chatCaseItem,chatCaseDetail,chatCaseMaterialVersion,feedbackItem,feedbackDetail,fileItem,cleanupCandidateItem,cleanupPlanItem,cleanupOperation,resourceItem,messagePlan,messageDraft,messageRun,recipientItem,historyItem,auditItem,analyticsData,analyticsBasis,queryProjection as view,ruleDetail,strategyDetail,searchDetail,spanItem} from './operations-agentos-query-view.mjs';
import {registeredDirectoryItem,registeredDirectoryPage,systemGeneralQuery,systemMailQuery,systemConnectionsQuery,systemAdvancedQuery,combinedQueryLease} from './operations-agentos-query-extensions-view.mjs';
import {z} from 'zod';
import {delegatedAiManagementReadSchema} from './operations/permissions/ai-delegation-schema.mjs';

const fail=(code,status=400)=>{throw new ServiceError(code,status);};
const parse=(schema,value)=>{let result;try{result=schema.safeParse(value);}catch{fail('invalid_operations_agentos_query');}if(!result.success)fail('invalid_operations_agentos_query');return result.data;};
const names={accounts:'业务账户','registered-users':'完整注册目录','system-settings':'系统设置',content:'公开内容',cases:'举报与申诉','chat-reports':'私聊案件',feedback:'使用反馈',files:'文件处理',resources:'项目与方法',analytics:'使用分析',recommendations:'推荐运营',search:'搜索质量',messaging:'官方消息',strategies:'目标与策略',rules:'业务规则',maintenance:'系统维护',audit:'业务审计',runs:'AI运行记录',jobs:'运行任务',permissions:'业务授权'};
const locations={accounts:'users','registered-users':'users','system-settings':'system-settings',content:'community?tab=posts',cases:'community?tab=reports','chat-reports':'chat-reports',feedback:'feedback',files:'files',resources:'resources',analytics:'analytics',recommendations:'recommendation',search:'search-quality',messaging:'messaging',strategies:'strategy',rules:'rules',maintenance:'maintenance',audit:'audit',runs:'ai-runs',jobs:'jobs',permissions:'permissions'};
const kindModule={account:'accounts','account-summary':'accounts','registered-user':'registered-users',post:'content',reply:'content',section:'content',case:'cases','chat-report':'chat-reports',feedback:'feedback','chat-file':'files','forum-file':'files','file-cleanup-plan':'files','file-cleanup-operation':'files',project:'resources',method:'resources','message-plan':'messaging','message-run':'messaging',rule:'rules','strategy-run':'strategies','ai-run':'runs','backup-point':'maintenance','restore-plan':'maintenance',role:'permissions'};
const kindLabel={account:'业务账户','account-summary':'账户使用情况','registered-user':'注册用户',post:'公开帖子',reply:'公开回复',section:'版块',case:'举报案件','chat-report':'私聊案件',feedback:'使用反馈','chat-file':'私聊文件','forum-file':'公开附件','file-cleanup-plan':'具体文件清理计划','file-cleanup-operation':'文件清理处理结果',project:'项目',method:'方法','message-plan':'消息计划','message-run':'消息执行',rule:'业务规则','strategy-run':'策略执行','ai-run':'AI运行','backup-point':'备份点','restore-plan':'恢复方案',role:'业务角色'};
function href(module,query={}){const path='/admin/operations/'+locations[module],q=new URLSearchParams(Object.entries(query).filter(([,value])=>value!==null&&value!==undefined&&value!=='').map(([key,value])=>[key,String(value)]));return path+(q.size?(path.includes('?')?'&':'?')+q:'');}
function objectHref(kind,id,row=null){
 if(kind==='registered-user')return href('registered-users',{registration:id,view:'detail'});
 if(kind==='account'||kind==='account-summary')return href('accounts',{account:id,...(kind==='account-summary'?{tab:'profile'}:{})});
 if(['post','reply'].includes(kind))return href('content',{contentKind:kind,id});if(kind==='section')return '/admin/operations/community?tab=sections&id='+encodeURIComponent(id);
 if(kind==='chat-file'||kind==='forum-file')return href('files',{id,fileKind:kind==='chat-file'?'chat':'forum'});
 if(kind==='file-cleanup-plan'||kind==='file-cleanup-operation')return href('files',{kind:'all',view:'cleanup',...(kind==='file-cleanup-plan'?{plan:id}:row?.planId?{plan:row.planId}:{})});
 if(kind==='project'||kind==='method')return href('resources',{id,kind:kind==='project'?'projects':'methods'});
 if(kind==='message-run')return href('messaging',{run:id});if(kind==='message-plan')return href('messaging',{id});
 if(kind==='ai-run')return href('runs',{run:id});if(kind==='rule')return href('rules',{key:id});
 if(kind==='strategy-run')return href('strategies',{tab:'runs',run:id});
 if(kind==='backup-point')return href('maintenance',{tab:'backups',point:id});if(kind==='restore-plan')return href('maintenance',{tab:'backups',plan:id});
 if(kind==='role')return href('permissions',{tab:'roles',id});return href(kindModule[kind],{id});
}
const scalarVersion=row=>row?.profileRevision??row?.version??row?.revision??row?.updatedAt??null;
function versionOf(kind,row){return kind==='chat-report'&&Array.isArray(row?.materials)?chatCaseMaterialVersion(row):kind==='case'&&row?.source&&Array.isArray(row.events)?caseMaterialVersion(row):kind==='message-plan'?JSON.stringify([row?.version??null,row?.revision??null,row?.state??null]):['post','reply','project','method','section'].includes(kind)?JSON.stringify([row?.version??null,row?.versionId??null,row?.sourceState??null,row?.visibility?.hidden??null,row?.curation?.revision??null]):scalarVersion(row);}
const publicKinds=new Set(['post','reply']);

/** Fixed read routes. Actors are supplied by the trusted conversation binding, never by model arguments. */
export class OperationsAgentOsQueryTools{
 constructor({authority,services={},now=authority?.now??(()=>Math.floor(Date.now()/1000))}){if(typeof authority?.human!=='function')throw new TypeError('Query tools require the current operations authority');Object.assign(this,{authority,services,now});}
 async authorize(actor,module,action,domain){const current=await this.authority.human(actor,{domain,action:'workbench.read',purpose:'query'});return this.authority.human(current,{domain,action:action??agentOsQueryReadAction(module),purpose:'query'});}
 method(service,method){const owner=this.services[service];if(typeof owner?.[method]!=='function')fail('operations_query_not_configured',503);return owner[method].bind(owner);}
 ref(kind,id,row,lease,filters={},materialPurpose=null){
  const feedbackSource=kind==='feedback'&&materialPurpose==='feedback-processing',caseSource=kind==='case'&&materialPurpose==='public-case-review',privateCaseSource=kind==='chat-report'&&materialPurpose==='private-case-review',draftSource=kind==='message-plan'&&materialPurpose==='message-draft-editing';
  if(!id)return null;const read={tool:'read-operation-object',arguments:{kind,id,filters}},valid=agentOsReadArgumentsSchema.safeParse(read.arguments);if(!valid.success)return null;
  const readable=['post','reply','project','method','section'].includes(kind)&&row?.sourceState==='available'&&row?.visibility?.hidden===false,publicSource=publicKinds.has(kind)&&readable;
  const sourceDeadline=caseSource&&row?.source?.availability==='available'?row.source.publishedUntil:publicSource?row.publishedUntil:null,
   deadline=Number.isFinite(sourceDeadline)?Math.min(lease.readExpiresAt,sourceDeadline):lease.readExpiresAt;
  return {kind,id,version:versionOf(kind,row),label:text(draftSource?row?.config?.content?.title:feedbackSource?row.title:readable?row.title:row?.displayName??row?.name)??kindLabel[kind],href:objectHref(kind,id,row),purpose:feedbackSource?'feedback-processing':caseSource?'public-case-review':privateCaseSource?'private-case-review':draftSource?'message-draft-editing':publicSource?'public-content':'operations',controlledSource:readable||feedbackSource||caseSource||privateCaseSource||draftSource,checkedAt:lease.checkedAt,readExpiresAt:deadline,read:{...read,arguments:valid.data}};
 }
 async execute({actor,domain,tool,arguments:input}){
  if(tool==='read-ai-delegation')return this.readAiManagement({actor,domain,input});
  if(!agentOsQueryDomains.includes(domain)||!['query-operations','read-operation-object'].includes(tool))fail('invalid_operations_agentos_query');
  const parsed=parse(tool==='query-operations'?agentOsQueryArgumentsSchema:agentOsReadArgumentsSchema,input),contentPage=tool==='query-operations'&&parsed.module==='content'&&parsed.view==='list',requestedLimit=contentPage?parsed.filters.limit:null,
   args=contentPage?{...parsed,filters:{...parsed.filters,limit:Math.min(requestedLimit,20)}}:parsed,queryModule=tool==='query-operations'?args.module:kindModule[args.kind];
  const action=agentOsQueryReadAction(queryModule,args);
  let fresh=await this.authorize(actor,queryModule,action,domain),result;
  try{result=tool==='query-operations'?await this.query(fresh,args):await this.read(fresh,args);}catch(error){
   if(error?.code!=='operations_query_not_configured')throw error;
   await this.authorize(actor,queryModule,action,domain);const checkedAt=this.now();return{tool,module:queryModule,view:args.view??null,availability:'not-configured',data:null,evidenceRefs:[],pagination:{next:null,complete:null},checkedAt,readExpiresAt:checkedAt+30,purpose:'operations',excludedFromProfile:true};
  }
  fresh=await this.authorize(actor,queryModule,action,domain);const checkedAt=this.now(),source=result.source??{},deadline=Number.isFinite(source.readExpiresAt)?Math.min(checkedAt+30,source.readExpiresAt):checkedAt+30;
  if(deadline<=checkedAt)fail('operations_query_expired',410);
  const lease={checkedAt,readExpiresAt:deadline},evidenceRefs=(result.refs??[]).map(({kind,id,row,filters,purpose})=>this.ref(kind,id,row,lease,filters,purpose)).filter(Boolean);
  const resultDeadline=Math.min(deadline,...evidenceRefs.filter(ref=>ref.controlledSource).map(ref=>ref.readExpiresAt));
  if(resultDeadline<=checkedAt)fail('operations_query_expired',410);
  const snapshot={kind:'operations-query',id:queryModule+':'+(args.view??args.kind),version:null,label:names[queryModule],href:href(queryModule,queryModule==='system-settings'&&args.view!=='overview'?{tab:args.view}:queryModule==='files'&&(args.view?.startsWith('cleanup-')||args.kind?.startsWith('file-cleanup-'))?{kind:'all',view:'cleanup'}:{}),purpose:'operations',controlledSource:false,...lease,read:{tool,arguments:args}};
  // Email lookup, when separately allowed by the directory service, must not
  // echo the supplied address into model output or stored source descriptors.
  const snapshots=['accounts','registered-users'].includes(queryModule)&&args.filters?.query?.includes('@')?[]:[snapshot],availability=result.availability??'available';
  const value={tool,module:queryModule,view:args.view??null,availability,data:result.data,evidenceRefs:availability==='available'?[...snapshots,...evidenceRefs]:[],pagination:result.pagination??{next:null,complete:true},...lease,readExpiresAt:resultDeadline,purpose:result.purpose??'operations',excludedFromProfile:!['analytics','recommendations','search'].includes(queryModule)};
  // Bound the source page before reading it. Its own cursor therefore resumes
  // immediately after the last returned row, without trimming/skipping items.
  if(contentPage)value.pagination={...value.pagination,requestedLimit,appliedLimit:args.filters.limit};
  if(Buffer.byteLength(JSON.stringify(value))>180000)fail('operations_query_result_too_large',413);
  return value;
 }
 async readAiManagement({actor,domain,input}){
  if(!agentOsQueryDomains.includes(domain))fail('invalid_operations_agentos_query');
  const args=parse(delegatedAiManagementReadSchema,input),fresh=await this.authority.human(actor,{domain,action:'workbench.read',purpose:'query'});let source,data;
  if(args.aiAccountId){
   source=await this.method('permissions','delegatedPrompt')(fresh,args);
   const schema=z.strictObject({aiAccountId:z.uuid(),domain:z.enum(['governance','messaging','discovery','maintenance']),name:z.string().max(100),configId:z.uuid(),revision:z.number().int().positive(),promptVersion:z.number().int().positive(),updatedAt:z.iso.datetime({offset:true}),text:z.string().max(16000)});
   const parsed=schema.safeParse(source.prompt);if(!parsed.success)fail('operations_query_response_invalid',503);
   data={prompt:parsed.data,delegationVersion:source.delegationVersion,scope:'role-work-requirements',instructionAuthority:'role-work-requirements-with-fixed-code-boundaries'};
  }else{
   source=await this.method('permissions','delegatedDirectory')(fresh);
   data=project(source,{delegation:{id:'s',sourceAiAccountId:'s',version:'n',enabled:'b',targetAiAccountIds:['s'],grantablePermissions:['s'],allowedManagementActions:['s'],updatedAt:'s'},targetAiAccounts:[{id:'s',domain:'s',name:'s',enabled:'b'}],
    roles:[{id:'s',name:'s',description:'s',subjectScope:'s',managedAiAccountIds:['s'],permissions:['s'],enabled:'b',version:'n',usage:{humanAssignments:'n',aiAssignments:'n',aiAccounts:[{id:'s',domain:'s',name:'s',enabled:'b'}]},impact:{affectsPeople:'b',affectsAi:'b',assignmentCount:'n'}}],
    assignments:[{id:'s',aiAccountId:'s',roleId:'s',enabled:'b',version:'n'}],availability:{canReadRoles:'b',canReadPrompts:'b',managementActions:['s'],promptActions:['s'],delegationId:'s',version:'n',targetAiAccountIds:['s']}});
  }
  await this.authority.human(fresh,{domain,action:args.aiAccountId?'ai.prompts.read':source.availability?.canReadRoles?'ai.roles.read':'ai.prompts.read',purpose:'query'});
  const checkedAt=this.now(),readExpiresAt=Math.min(checkedAt+30,source.readExpiresAt);if(!Number.isSafeInteger(readExpiresAt)||readExpiresAt<=checkedAt)fail('operations_query_expired',410);
  return{tool:'read-ai-delegation',module:'ai-management',view:args.aiAccountId?'role-work-requirements':'delegation',availability:'available',data,evidenceRefs:[],pagination:{next:null,complete:true},checkedAt,readExpiresAt,purpose:'ai-management',excludedFromProfile:true};
 }
 async query(actor,{module,view:which,filters:q}){
  const call=(name,method,...args)=>this.method(name,method)(actor,...args),refs=[];
  const list=(source,projector,kind,items=source.items)=>{
   if(!Array.isArray(items))fail('operations_query_response_invalid',503);
   const rows=items.map(item=>projector(item)).filter(Boolean);
   for(const row of items){const type=typeof kind==='function'?kind(row):kind;if(type)refs.push({kind:type,id:row.id??row.accountId??row.reportId??row.runId,row});}
   const next=source.nextAfter??null;return{source,data:{items:rows,coverage:'returned-page',scanLimited:source.scanTruncated??source.scanLimited??false,...(source.availability?{availability:project(source.availability,{state:'s',code:'s'})}:{})},refs,pagination:{next:next?{module,view:which,filters:{...q,after:next}}:null,complete:next?false:source.scanTruncated||source.scanLimited||source.availability?.state&&source.availability.state!=='available'?false:true}};
  };
  if(module==='accounts')return which==='summary'?{source:await call('accounts','directorySummary',q),get data(){return view.accountsSummary(this.source);}}:list(await call('accounts','list',q),accountItem,'account');
  if(module==='registered-users'){
   const source=await call('registeredUsers','list',q),data=registeredDirectoryPage(source,{filterSource:q.source}),ready=data.source.coverage==='complete-generation',next=ready&&data.pagination.page!==null&&data.pagination.totalPages!==null&&data.pagination.page<data.pagination.totalPages;
   return{source,data,availability:ready?'available':data.source.state==='not-configured'?'not-configured':'unavailable',refs:ready?data.items.map(row=>({kind:'registered-user',id:row.registrationId,row:{...row,displayName:row.business?.displayName??row.identity.displayName}})):[],pagination:{next:next?{module,view:which,filters:{...q,page:data.pagination.page+1}}:null,complete:ready?!next:false}};
  }
  if(module==='system-settings'){
   if(which==='general'){const source=await call('systemGeneral','publishedGeneral');return{source,data:systemGeneralQuery(source),availability:source.publication?.state==='available'?'available':'unavailable',pagination:{next:null,complete:source.publication?.state==='available'}};}
   if(which==='advanced'){const source=await call('systemSettings','advanced');return{source,data:systemAdvancedQuery(source)};}
   if(which==='overview'){
    const [current,general]=await Promise.all([call('systemSettings','overview'),call('systemGeneral','publishedGeneral')]),mail=current.sections?.mail,connections=current.sections?.['service-connections'];
    if(!mail||!connections)fail('operations_query_response_invalid',503);
    // Advanced uses this same observed mail/version, never an extra read or a
    // second source that could silently combine two different saved versions.
    const advanced={revision:mail.revision,versionId:mail.version?.id??null,connections:mail.configuration?.connections,source:'mail-configuration',limitsScope:'per-worker-process',current:mail.current};
    return{source:combinedQueryLease([current,mail,connections,general]),data:{sections:{general:systemGeneralQuery(general),mail:systemMailQuery(mail),'service-connections':systemConnectionsQuery(connections),advanced:systemAdvancedQuery(advanced)},basis:'current-safe-section-reads-general-published-only'}};
   }
   const source=await call('systemSettings','read',which);return{source,data:which==='mail'?systemMailQuery(source):systemConnectionsQuery(source)};
  }
  if(module==='content'){
   if(which==='sections')return list(await call('community','sections',q),sectionItem,'section');
   if(which==='tags'){const source=await call('content','tags');return{source,data:{items:(source.items??[]).map(x=>project(x,{id:'s',name:'s',enabled:'b',version:'n'}))}};}
   const source=await call('content','list',q.query?{...q,visibility:'visible'}:q),result=list(source,contentItem,x=>x.kind);result.data.summary=view.contentSummary(source.summary);return result;
  }
  if(module==='cases')return list(await call('community','reports',q),caseItem,'case');
  if(module==='chat-reports')return list(await call('chatReports','operatorQuery',q),chatCaseItem,'chat-report');
  if(module==='feedback'){const source=await call('feedback','list',{...q,query:''}),result=list(source,feedbackItem,'feedback');result.data.summary=view.feedbackSummary(source.summary);return result;}
  if(module==='files'){
   if(which==='cleanup-candidates')return list(await call('fileCleanup','candidates',q),cleanupCandidateItem,x=>x.kind+'-file');
   if(which==='cleanup-plans')return list(await call('fileCleanup','plans',q),cleanupPlanItem,'file-cleanup-plan');
   const source=await call('files',which,q);return which==='list'?list(source,fileItem,x=>x.kind+'-file'):{source,data:view.filesSummary(source)};
  }
  if(module==='resources')return list(await call('resources','list',which,q),resourceItem,which==='projects'?'project':'method');
  if(module==='analytics'){const source=await call('analytics','analytics',{kind:which,...q});return{source,data:{kind:source.kind,data:analyticsData(source.data,which,{checkedAt:source.checkedAt??this.now(),basis:source.basis}),basis:analyticsBasis(source.basis),source:source.source,purpose:source.purpose,coverage:source.coverage,historicalBackfill:source.historicalBackfill}};}
  if(module==='recommendations'){const source=await call('recommendations',which,q);return which==='history'?list(source,historyItem):{source,data:view.recommendation(source)};}
  if(module==='search'){const source=await call('searchQuality',which,q);if(which==='history')return list(source,historyItem);const next=source.queries?.nextAfter;return{source,data:searchDetail(source),pagination:{next:next?{module,view:which,filters:{...q,after:next}}:null,complete:!next}};}
  if(module==='messaging'){
   if(which==='recipients'){const{runId,...filters}=q;const result=list(await call('messaging','recipients',runId,filters),recipientItem);result.data.runId=runId;return result;}
   if(which==='history'){const{planId,...filters}=q;return list(await call('messaging','history',planId,filters),historyItem);}
   const source=await call('messaging',which==='plans'?'list':'runs',q),result=list(source,which==='plans'?messagePlan:messageRun,which==='plans'?'message-plan':'message-run');if(source.summary)result.data.summary=view.messageSummary(source.summary);return result;
  }
  if(module==='strategies'){
   const source=await call('strategies',which==='overview'?'get':which,q);
   if(which==='overview')return{source,data:strategyDetail(source)};
   if(which==='versions')return list(source,x=>project(x,{id:'s',version:'n',createdAt:'s'}));
   return list(source,x=>({...historyItem(x),version:project(x.version,{id:'s',version:'n',createdAt:'s'}),strategyId:text(x.strategyId),runId:text(x.runId)}));
  }
  if(module==='rules'){if(which==='overview'){const source=await call('rules','overview');return{source,data:{items:(source.items??[]).map(ruleDetail)},refs:(source.items??[]).map(row=>({kind:'rule',id:row.key,row}))};}const{key,...filters}=q;return list(await call('rules','versions',key,filters),x=>({...historyItem(x),version:project(x.version,{id:'s',key:'s',version:'n',publishedVersion:'n',source:'s',createdAt:'s'})}));}
  if(module==='maintenance'){
   const source=await call('maintenance',which,q);if(which==='overview')return{source,data:view.maintenance(source)};
   if(which==='backups')return list(source,view.point,'backup-point');if(which==='plans')return list(source,view.restorePlan,'restore-plan');
   const result=list({...source,nextAfter:source.nextBefore},x=>project(x,{...Object.fromEntries(['at','component','level','event','diagnostic','code','sqlState'].map(k=>[k,'s'])),status:'n'}));result.pagination.next=source.nextBefore?{module,view:which,filters:{...q,before:source.nextBefore}}:null;return result;
  }
  if(module==='audit')return list(await call('accounts','audit',q),auditItem);
  if(module==='runs'){const source=await call('aiRuns','runs',q),result=list(source,view.aiRun,'ai-run');result.pagination={next:source.nextPage?{module,view:which,filters:{...q,page:source.nextPage}}:null,complete:!source.nextPage};result.data.total=number(source.total);return result;}
  if(module==='jobs'){const{queue,...filters}=q;return list(await this.method('jobs','list')(queue,filters),view.job);}
  if(module==='permissions'){const source=await call('permissions',which);return list(source,which==='roles'?view.role:which==='personnel'?view.person:view.automation,which==='roles'?'role':null);}
  fail('invalid_operations_agentos_query');
 }
 async read(actor,{kind,id,filters}){
  const call=(service,method,...args)=>this.method(service,method)(actor,...args);let source,row,data,purpose=null;
  if(kind==='account'){source=await call('accounts','get',id);row=source.account;data=accountItem(row);}
  else if(kind==='registered-user'){source=await call('registeredUsers','detail',id);data=registeredDirectoryItem(source.item);row={...data,displayName:data.business?.displayName??data.identity.displayName};}
  else if(kind==='account-summary'){source=await call('accounts','accountSummary',id,filters);row=source;data=view.accountSummary(source);}
  else if(publicKinds.has(kind)){source=await call('content','get',kind,id);row=source.content;data=contentItem(row,{body:true});}
  else if(kind==='section'){source=await call('community','section',id);row=source;data=sectionItem(row);}
  else if(kind==='case'){source=await call('community','report',id);row=source;if(row?.id!==id)fail('operations_query_response_invalid',503);data=caseDetail(row);purpose='public-case-review';}
  else if(kind==='chat-report'){
   if(this.authority.acceptsDuty?.(actor)){
    let privateActor=null;try{privateActor=await this.authority.requireDutyAction(actor,'chat-reports.materials.read',{purpose:'prepare'});}catch(error){if(error.code!=='operations_permission_denied')throw error;}
    if(privateActor){source=await this.method('chatReports','operatorGet')(privateActor,{reportId:id});await this.authority.requireDutyAction(privateActor,'chat-reports.materials.read',{purpose:'prepare'});row=source;data=chatCaseDetail(row);purpose='private-case-review';}
    else{source=await call('chatReports','operatorGet',{reportId:id});row=source;data=chatCaseItem(row);}
   }else{source=await call('chatReports','operatorGet',{reportId:id});row=source;data=chatCaseItem(row);}
  }
  else if(kind==='feedback'){source=await call('feedback','get',id);row=source.feedback;if(row?.id!==id)fail('operations_query_response_invalid',503);data=feedbackDetail(row);purpose='feedback-processing';}
  else if(kind==='chat-file'||kind==='forum-file'){source=await call('files','get',kind==='chat-file'?'chat':'forum',id);row=source;data=fileItem(row);}
  else if(kind==='file-cleanup-plan'){source=await call('fileCleanup','plan',id);row=source;data=cleanupPlanItem(row);}
  else if(kind==='file-cleanup-operation'){source=await call('fileCleanup','operation',id);row=source;data=cleanupOperation(row);}
  else if(kind==='project'||kind==='method'){source=await call('resources','get',kind==='project'?'projects':'methods',id);row=source;data=resourceItem(row);}
  else if(kind==='message-plan'){source=await call('messaging','get',id);row=source.plan;const draft=row?.state==='draft';data={plan:draft?messageDraft(row):messagePlan(row),recentRuns:(source.recentRuns??[]).map(messageRun)};if(draft)purpose='message-draft-editing';}
  else if(kind==='message-run'){source=await call('messaging','run',id);row=source.run;data=messageRun(row);}
  else if(kind==='rule'){source=await call('rules','get',id);row=source;data=ruleDetail(row);}
  else if(kind==='strategy-run'){source=await call('strategies','runDetail',id);row=source.run;data=project(row,{...Object.fromEntries(['id','strategyId','state','code','createdAt','updatedAt'].map(k=>[k,'s'])),strategy:Object.fromEntries(['id','name','domain','mode'].map(k=>[k,'s'])),target:{kind:'s',id:'s',sourceVersion:'n'},canContinue:'b',continueCode:'s',native:{...Object.fromEntries(['runId','status','pauseKind'].map(k=>[k,'s'])),awaitingHuman:'b'}});}
  else if(kind==='ai-run'){source=await call('aiRuns','runDetail',id);row=source.run;data={run:view.aiRun(row),spans:(source.spans??[]).map(spanItem)};}
  else if(kind==='backup-point'){source=await call('maintenance','backup',id);row=source.point;data=view.point(row);}
  else if(kind==='restore-plan'){source=await call('maintenance','plan',id);row=source.plan??source;data=view.restorePlan(row);}
  else if(kind==='role'){source=await call('permissions','role',id);row=source.role;data=view.role(row);}
  else fail('invalid_operations_agentos_query');
  return{source,data,purpose,refs:[{kind,id,row,filters,purpose}]};
 }
 async revalidate({actor,domain,evidenceRefs}){
  if(!Array.isArray(evidenceRefs)||evidenceRefs.length>300)fail('invalid_operations_agentos_query');
  const refs=[],invalidRefs=[];const memo=new Map();
  for(const original of evidenceRefs){
   if(!original?.read||!['query-operations','read-operation-object'].includes(original.read.tool)){invalidRefs.push({kind:original?.kind??null,id:original?.id??null});continue;}
   try{
    const key=JSON.stringify(original.read);let result=memo.get(key);if(!result){result=await this.execute({actor,domain,...original.read});memo.set(key,result);}
    const current=result.evidenceRefs.find(ref=>ref.kind===original.kind&&ref.id===original.id);
    if(!current||original.controlledSource&&(!current.controlledSource||!isDeepStrictEqual(current.version,original.version))){invalidRefs.push({kind:original.kind,id:original.id});continue;}
    refs.push(current);
   }catch(error){if(![403,404,409,410].includes(error?.status))throw error;invalidRefs.push({kind:original.kind,id:original.id});}
  }
  return {valid:invalidRefs.length===0,refs,invalidRefs};
 }
}
