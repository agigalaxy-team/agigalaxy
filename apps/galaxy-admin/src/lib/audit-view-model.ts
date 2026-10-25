import type {AuditEvent} from '../components/business-types';
import {paginationPageNumbers} from './pagination-model';
import {systemSettingsOriginalHref} from './system-settings-view-model';

export type AuditKind='all'|'business'|'reads';
export type AuditPageSize=20|30|50|100;
export type AuditFilters={account:string;resource:string;after:string;trail:string;selected:string;query:string;kind:AuditKind;action:string;day:string;page:number;pageSize:AuditPageSize;snapshot:string;sort:'newest'|'oldest'};
type AuditFilterInput=Partial<{[Key in keyof AuditFilters]:AuditFilters[Key]|string}>;
export type AuditMetadata={key:string;label:string;value:string};
export type AuditObject={id:string;kind:string;label:string;href:string|null};
export type AuditOutcome={key:string;label:string;tone:'neutral'|'positive'|'warning'|'negative'};
export type AuditRelation={item:AuditEvent;basis:string[]};

const route='/admin/operations/audit';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxCursor=9223372036854775807n;

const actionLabels:Record<string,string>={
  'community-section-classify':'调整版块分类','community-section-visibility':'处理版块显示','community-report-resolve':'处理社区举报',
  'operations-summary-read':'读取运营概览','restriction-set':'暂停社区参与','restriction-release':'解除社区参与限制','type-change':'更正账户类型',
  'registered-user-password-reset':'发送用户密码重置邮件','registered-user-login-disable':'停用用户登录','registered-user-login-restore':'恢复用户登录',
  'registered-user-sessions-revoke':'撤销用户会话','registered-user-profile-correct':'更正用户资料','registered-user-profile-preset':'预置用户资料',
  'management-account-create':'创建管理账户','management-account-profile-update':'修改管理账户资料',
  'management-account-login-disable':'停用管理账户登录','management-account-login-restore':'恢复管理账户登录',
  'management-account-password-reset':'重置管理账户临时密码','management-account-sessions-revoke':'撤销管理账户会话','management-account-delete':'删除管理账户登录身份',
  'management-account-admission-change':'调整管理账户准入','management-account-email-change':'变更管理账户登录邮箱',
  'ai-work-profile-save':'修改 AI 工作账户资料','ai-work-state-save':'启停 AI 工作账户','ai-work-assignment-save':'调整 AI 工作账户角色',
  'ai-delegation-save':'设置总控管理范围','ai-role-create':'创建 AI 专用角色','ai-role-update':'修改 AI 专用角色','ai-role-assignment-save':'调整 AI 岗位角色',
  'autonomy-config':'保存值守计划','autonomy-enable':'启停岗位值守','autonomy-control':'处理任务状态','autonomy-run':'安排值守事项','autonomy-settings':'调整运行配置','autonomy-strategy-task':'安排策略事项','autonomy-decision':'记录人工决定',
  'system-settings-save':'保存系统设置','system-settings-test':'测试系统连接','system-settings-apply':'应用系统设置','system-settings-credential-provision':'更新系统服务凭据',
  'users-query':'查找账户','user-read':'读取账户资料','audit-read':'读取审计记录','rule-save':'保存业务规则',
  'notice-create':'创建通知','notice-save':'修改通知','notice-publish':'发布通知','notice-withdraw':'撤回通知','notice-delivery':'执行通知投递',
  'retention-request':'安排到期清理','retention-complete':'到期清理完成','retention-failed':'到期清理失败',
  'section-classification':'调整版块分类','section-visibility':'处理版块显示','forum-report-resolve':'处理社区举报',
  'resource-visibility':'处理资料显示','file-retry':'重新安排文件处理','operations-job-cancel':'取消后台任务',
  'operations-job-retry':'重试后台任务','search-recovery-retry':'安排检索恢复',
  'feedback-query':'查询使用反馈','feedback-read':'读取使用反馈','feedback-update':'更新使用反馈',
  'chat-reports-query':'查询私聊举报','chat-report-read':'读取私聊举报','chat-report-event':'处理私聊举报','chat-report-attachment':'读取私聊举报附件',
  'job-cancel':'取消后台任务','job-retry':'重试后台任务','search-retry':'安排检索恢复',
  'community-posts-query':'查询社区帖子','community-post-read':'读取社区帖子','community-sections-query':'查询社区版块','community-section-read':'读取社区版块',
  'community-reports-query':'查询社区举报','community-report-read':'读取社区举报','resources-query':'查询项目与方法','resource-read':'读取项目与方法',
  'files-query':'查询文件处理','file-read':'读取文件处理',
  'file-access-read':'读取文件访问处理','file-access-stop':'停止文件访问','file-access-restore':'恢复文件访问',
  'file-cleanup-read':'读取文件清理计划','file-cleanup-create':'形成文件清理计划','file-cleanup-approve':'批准文件清理计划','file-cleanup-cancel':'取消文件清理计划',
  'community-content-query':'查询公开内容','community-content-read':'读取公开内容','community-content-visibility':'处理公开内容显示',
  'community-content-curation':'整理公开内容','community-content-batch-preview':'预览公开内容批量处理','community-content-batch-visibility':'批量处理公开内容显示',
  'community-tags-query':'查询内容标签','community-tag-create':'创建内容标签','community-tag-update':'修改内容标签',
  'permission-role-save':'保存业务角色','permission-assignment-save':'调整人员授权','permission-automation-save':'保存自动执行授权',
  'recommendations.configure':'调整推荐策略与主题',
  'search-quality.configure':'保存搜索配置草稿','search-quality.publish':'应用搜索配置','search-quality.restore':'恢复搜索配置',
  'models.configure':'保存人工模型设置','models.apply':'应用人工模型设置',
  'strategies.configure':'保存目标与策略草稿','strategies.publish':'发布目标与策略','strategies.control':'暂停或恢复策略执行','strategies.run':'启动或继续策略事项',
  'strategies.ordinary.configure':'在明确范围内修改普通策略','strategies.ordinary.publish':'在明确范围内发布普通策略',
  'maintenance-query':'读取整站维护','maintenance-logs-query':'读取运行日志','maintenance-backup-create':'创建整站备份','maintenance-backup-verify':'检查备份点',
  'maintenance-restore-plan':'准备恢复方案','maintenance-restore-approve':'批准恢复方案','maintenance-restore-execute':'执行恢复方案','maintenance-restore-cancel':'取消恢复方案',
  'smtp-query':'读取发信服务','smtp-config-save':'保存发信服务配置','smtp-connection-test':'测试发信连接','smtp-delivery-test':'测试邮件投递','smtp-dns-check':'检查发信域名记录',
};
const dottedAuditActions=new Set(['recommendations.configure','search-quality.configure','search-quality.publish','search-quality.restore','models.configure','models.apply','strategies.configure','strategies.publish','strategies.control','strategies.run','strategies.ordinary.configure','strategies.ordinary.publish']);
const readActions=new Set(['operations-summary-read','users-query','user-read','audit-read','feedback-query','feedback-read',
  'chat-reports-query','chat-report-read','chat-report-attachment','community-posts-query','community-post-read','community-sections-query','community-section-read',
  'community-reports-query','community-report-read','resources-query','resource-read','files-query','file-read',
  'community-content-query','community-content-read','community-content-batch-preview','community-tags-query','maintenance-query','maintenance-logs-query',
  'file-cleanup-read','file-access-read','smtp-query','smtp-dns-check']);
const stateLabels:Record<string,string>={
  draft:'草稿',queued:'排队中',running:'执行中',active:'有效',pending:'待处理',processing:'处理中',closed:'已处理',
  published:'已发布',withdrawn:'已撤回',delivered:'已投递',complete:'已完成',completed:'已完成',succeeded:'已完成',
  failed:'失败',partial:'部分完成',expired:'已到期',cancelled:'已取消',canceled:'已取消',effective:'已生效',
  waiting:'等待中','not-applied':'尚未应用',unavailable:'暂不可用',available:'可取得',paused:'已暂停',
  hidden:'已隐藏',visible:'可显示',deleted:'已删除',quarantined:'已隔离','not-connected':'未接通',
  'not-analyzed':'尚未分析','not-collected':'尚未采集',ready:'已就绪',allowed:'允许',denied:'拒绝',
  received:'已接收',reviewing:'复核中',appealed:'申诉中',resolved:'已处理',scheduled:'已安排',created:'已创建',retry:'等待重试',
  delivering:'投递中',stopped:'已停止',submitted:'已提交',unknown:'结果未知',skipped:'已跳过',submitting:'提交中',
  'not-configured':'未配置',ineligible:'不符合条件',testing:'测试中',connected:'连接通过',checked:'已检查',blocked:'已阻止',
  'awaiting-approval':'待人工批准',approved:'已批准',preparing:'准备中',restoring:'恢复中',validating:'核查中','ready-to-open':'等待开放',opening:'开放中',
  prepared:'已准备',accepted:'已受理',uploading:'上传中','scan-pending':'等待扫描',scanning:'扫描中',erased:'已清除',revoked:'已撤回',
};
const subjectLabels:Record<string,string>={person:'个人',organization:'组织',agent:'Agent',unknown:'未知'};
const tokenLabels:Record<string,Record<string,string>>={
  kind:{projects:'项目',methods:'方法',project:'项目',method:'方法',post:'帖子',reply:'回复',report:'举报',file:'文件',feedback:'使用反馈',notice:'通知',
    'password-reset':'密码重置邮件','login-disable':'停用登录','login-restore':'恢复登录','sessions-revoke':'撤销会话','profile-correct':'更正资料','profile-preset':'预置资料',
    review:'开始复核',pause:'暂停参与',resume:'恢复参与',resolve:'记录处理结果','message-hide':'屏蔽本案消息','message-restore':'解除本案消息屏蔽','message-keep':'维持本案消息覆盖',chat:'私聊附件',forum:'公开内容附件',scan:'扫描',cleanup:'清理'},
  view:{'directory-summary':'账户目录汇总','usage-summary':'账户使用汇总','business-account-metadata':'账户资料','type-history':'类型更正历史','association-metadata':'身份关联信息'},
  queryKind:{all:'全部',email:'邮箱','uid-or-username':'UID或用户名'},
  subjectType:subjectLabels,previousType:subjectLabels,nextType:subjectLabels,
  category:{problem:'使用问题',suggestion:'建议',unclassified:'待归类'},
  module:{account:'账户',community:'社区',chat:'聊天',work:'工作',discovery:'发现',other:'其他'},
  key:{'resource-budget':'资源预算','community-quota':'社区额度','forum-quota':'论坛额度'},
  state:stateLabels,applicationState:stateLabels,publicActivityState:stateLabels,submission:stateLabels,
  channel:{announcement:'公告',inapp:'站内信',email:'电子邮件'},action:{stop:'停止访问',restore:'恢复访问'},
  scope:{'community-participation':'社区参与'},execution:{worker:'后台Worker'},
  section:{general:'常规设置',mail:'邮件服务','service-connections':'服务接入'},
  domain:{overview:'总控',governance:'治理',messaging:'消息',discovery:'数据与发现',maintenance:'运维'},
  audience:{all:'全部账户',accounts:'指定账户','quota-layer':'额度层','subject-type':'主体类型'},
};
type ValueKind='id'|'number'|'boolean'|'token'|'time'|'fields'|'management-phases';
const fields:Record<string,{label:string;kind:ValueKind}>={
  id:{label:'对象编号',kind:'id'},accountId:{label:'账户编号',kind:'id'},resourceId:{label:'对象编号',kind:'id'},registrationId:{label:'注册用户编号',kind:'id'},
  targetOperatorId:{label:'目标管理账户编号',kind:'id'},roleId:{label:'业务角色编号',kind:'id'},
  delegationId:{label:'总控管理范围',kind:'id'},delegationVersion:{label:'管理范围版本',kind:'number'},sourceAiAccountId:{label:'来源 AI 账户',kind:'id'},aiAccountId:{label:'目标 AI 账户',kind:'id'},targetCount:{label:'授权目标数',kind:'number'},
  versionId:{label:'设置版本',kind:'id'},section:{label:'设置类别',kind:'token'},
  assignmentId:{label:'角色分配编号',kind:'id'},domain:{label:'AI 职责',kind:'token'},
  assignmentVersion:{label:'分配版本',kind:'number'},assignmentEnabled:{label:'分配有效',kind:'boolean'},
  sectionId:{label:'版块编号',kind:'id'},reportId:{label:'举报编号',kind:'id'},noticeId:{label:'通知编号',kind:'id'},
  roomId:{label:'对话编号',kind:'id'},messageId:{label:'消息编号',kind:'id'},
  projectId:{label:'项目编号',kind:'id'},methodId:{label:'方法编号',kind:'id'},fileId:{label:'文件编号',kind:'id'},
  feedbackId:{label:'反馈编号',kind:'id'},runId:{label:'运行编号',kind:'id'},jobId:{label:'任务编号',kind:'id'},
  planId:{label:'计划编号',kind:'id'},recipientId:{label:'收件记录编号',kind:'id'},modelRecordId:{label:'模型记录编号',kind:'id'},
  operationId:{label:'操作编号',kind:'id'},httpRequestId:{label:'请求编号',kind:'id'},
  kind:{label:'类型',kind:'token'},view:{label:'读取内容',kind:'token'},queryKind:{label:'查询方式',kind:'token'},
  subjectType:{label:'主体类型',kind:'token'},previousType:{label:'原主体类型',kind:'token'},nextType:{label:'新主体类型',kind:'token'},
  category:{label:'分类',kind:'token'},module:{label:'所属模块',kind:'token'},key:{label:'规则',kind:'token'},
  state:{label:'状态',kind:'token'},scope:{label:'作用范围',kind:'token'},audience:{label:'受众类型',kind:'token'},
  execution:{label:'执行通道',kind:'token'},applicationState:{label:'应用状态',kind:'token'},publicActivityState:{label:'公开参与统计',kind:'token'},
  action:{label:'处理动作',kind:'token'},channel:{label:'消息渠道',kind:'token'},submission:{label:'邮件提交',kind:'token'},
  version:{label:'版本',kind:'number'},expectedVersion:{label:'操作前版本',kind:'number'},revision:{label:'修订',kind:'number'},
  expectedRevision:{label:'操作前修订',kind:'number'},expectedVisibilityVersion:{label:'操作前显示版本',kind:'number'},
  policyVersion:{label:'规则版本',kind:'number'},sourceVersion:{label:'来源版本',kind:'number'},count:{label:'返回数量',kind:'number'},
  planVersion:{label:'计划版本',kind:'number'},profileRevision:{label:'资料修订',kind:'number'},
  sourceRevision:{label:'消息来源修订',kind:'number'},
  limit:{label:'每页数量',kind:'number'},days:{label:'统计天数',kind:'number'},audienceCount:{label:'本次受众数',kind:'number'},
  deliveredCount:{label:'本次投递数',kind:'number'},total:{label:'记录中的总数',kind:'number'},
  permissionCount:{label:'权限项数',kind:'number'},
  active:{label:'当前有效',kind:'boolean'},hidden:{label:'运营隐藏',kind:'boolean'},replayed:{label:'原操作重放',kind:'boolean'},
  enabled:{label:'当前启用',kind:'boolean'},
  stopped:{label:'访问已停止',kind:'boolean'},retryable:{label:'可重试',kind:'boolean'},
  preserveHistory:{label:'保留历史',kind:'boolean'},processingComplete:{label:'处理完成',kind:'boolean'},applied:{label:'已应用',kind:'boolean'},hasQuery:{label:'包含查询条件',kind:'boolean'},
  until:{label:'截止时间',kind:'time'},recordedAt:{label:'记录时间',kind:'time'},completedAt:{label:'完成时间',kind:'time'},
  fields:{label:'变更字段',kind:'fields'},changedFields:{label:'变更字段',kind:'fields'},
  phases:{label:'处理阶段',kind:'management-phases'},
};
const changeLabels:Record<string,string>={category:'反馈类型',module:'所属模块',state:'处理状态',note:'内部备注',hidden:'显示状态',subjectType:'主体类型',
  name:'名称',description:'说明',enabled:'启用状态',permissions:'功能权限',operatorId:'管理人员',roleId:'业务角色',executorKind:'执行类型',mode:'执行方式',resourceIds:'对象范围',resourceScope:'对象范围',
  host:'SMTP服务器',port:'SMTP端口',tls:'连接加密',credentialRef:'凭据引用',connectionTimeoutMs:'连接超时',greetingTimeoutMs:'握手超时',socketTimeoutMs:'会话超时',maxConnections:'并发连接数',rateLimit:'发送限速',rateWindowSeconds:'限速时间窗',dkimSelector:'DKIM选择器'};
const containers:Record<string,string[]>={restriction:['active','until','revision'],profile:['subjectType','revision'],change:['previousType','nextType','revision'],processing:['state','processingComplete']};
const messageKindLabels:Record<string,string>={create:'创建计划',save:'保存计划',activate:'启用计划',pause:'暂停计划',resume:'恢复计划',stop:'停止计划',withdraw:'撤回计划',retry:'重试本次执行',run:'执行消息计划','inapp-delivery':'投递站内信','email-submission':'提交邮件'};
const managementAccountKindLabels:Record<string,string>={create:'创建账户','profile-update':'修改资料','login-disable':'停用登录','login-restore':'恢复登录','password-reset':'设置临时密码','sessions-revoke':'撤销会话',delete:'删除登录身份','admission-change':'调整后台准入','email-change':'验证并更换邮箱'};
const systemSettingsKindLabels:Record<string,string>={save:'保存配置',test:'测试连接',apply:'应用配置',credential:'更新凭据'};
const systemSettingsActions=new Set(['system-settings-save','system-settings-test','system-settings-apply','system-settings-credential-provision']);
const aiWorkKindLabels:Record<string,string>={'profile-save':'修改岗位资料','state-save':'启停岗位','assignment-save':'调整岗位角色'};
const aiWorkActions=new Set(Object.keys(aiWorkKindLabels).map(kind=>'ai-work-'+kind));
const managementAccountActions=new Set(Object.keys(managementAccountKindLabels).map(kind=>'management-account-'+kind));
const registeredUserActions=new Set(['registered-user-password-reset','registered-user-login-disable','registered-user-login-restore','registered-user-sessions-revoke','registered-user-profile-correct','registered-user-profile-preset']);
const managementPhaseLabels:Record<string,string>={'native-account':'原生账户','native-admission':'后台准入','local-principal':'历史主体','business-assignments':'业务角色','native-sessions':'原生会话','portal-sessions':'管理会话','email-verification':'新邮箱验证'};
const managementPhaseStateLabels:Record<string,string>={accepted:'已受理',confirmed:'已核实',submitted:'已提交',failed:'失败',unknown:'结果未知'};

export function auditActionLabel(action:string){return Object.hasOwn(actionLabels,action)?actionLabels[action]:'其他业务记录';}
export function auditAvailableActions(actions:unknown){
  return Array.isArray(actions)?[...new Set(actions.filter((action):action is string=>typeof action==='string'&&Object.hasOwn(actionLabels,action)))].sort((a,b)=>auditActionLabel(a).localeCompare(auditActionLabel(b),'zh-CN')):[];
}
export function auditKind(item:AuditEvent):Exclude<AuditKind,'all'>|'other'{
  return readActions.has(item.action)?'reads':Object.hasOwn(actionLabels,item.action)?'business':'other';
}
export function auditRoleLabel(role:string){return role==='administrator'?'管理员':role==='reader'?'管理成员':'未记录';}
export function auditTime(value:string|null|undefined,full=false){
  const time=value?new Date(value):null;
  if(!time||!Number.isFinite(time.getTime()))return '未记录';
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(full?{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}:{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}),hour12:false}).format(time);
}
export function auditDay(value:string){
  const time=new Date(value);
  return Number.isFinite(time.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(time):'';
}
export function auditShortId(value:string|null|undefined){return value?value.length>18?value.slice(0,8)+'…'+value.slice(-6):value:'未记录';}
export function auditCursor(value:string){return /^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=maxCursor?value:'';}
export function auditTrail(value:string){const parts=value?value.split('.'):[];return parts.length<=32&&parts.every(item=>item==='0'||!!auditCursor(item))?parts:[];}
export function normalizeAuditFilters(input:AuditFilterInput):AuditFilters{
  const day=input.day??'';
  const page=Number(input.page),size=Number(input.pageSize);
  return {account:uuid.test(input.account??'')?input.account!:'',resource:uuid.test(input.resource??'')?input.resource!:'',
    after:auditCursor(input.after??''),trail:auditTrail(input.trail??'').join('.'),selected:uuid.test(input.selected??'')?input.selected!:'',
    query:(input.query??'').trim().slice(0,160),kind:input.kind==='business'||input.kind==='reads'?input.kind:'all',
    action:/^[a-z][a-z0-9-]{0,79}$/.test(input.action??'')||dottedAuditActions.has(input.action??'')?input.action!:'',
    day:/^\d{4}-\d{2}-\d{2}$/.test(day)&&!day.startsWith('0000-')&&!Number.isNaN(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().startsWith(day)?day:'',
    page:Number.isSafeInteger(page)&&page>=1&&page<=1000000?page:1,pageSize:([20,30,50,100].includes(size)?size:30) as AuditPageSize,
    snapshot:uuid.test(input.snapshot??'')?input.snapshot!.toLowerCase():'',sort:input.sort==='oldest'?'oldest':'newest'};
}
export function auditHref(filters:AuditFilters,updates:Partial<AuditFilters>={}){
  const next=normalizeAuditFilters({...filters,...updates}),params=new URLSearchParams();
  for(const [key,value]of Object.entries({accountId:next.account,resource:next.resource,after:next.after,trail:next.trail,id:next.selected,q:next.query,kind:next.kind==='all'?'':next.kind,action:next.action,day:next.day,page:next.page>1?String(next.page):'',pageSize:next.pageSize!==30?String(next.pageSize):'',snapshot:next.snapshot,sort:next.sort==='oldest'?'oldest':''})){
    if(value)params.set(key,value);
  }
  return route+(params.size?'?'+params.toString():'');
}
export function auditReadPath(filters:AuditFilters){
  const params=filters.after?new URLSearchParams({limit:String(filters.pageSize)}):new URLSearchParams({page:String(filters.page),pageSize:String(filters.pageSize),sort:filters.sort});
  if(filters.account)params.set('accountId',filters.account);
  if(filters.resource)params.set('resourceId',filters.resource);
  if(filters.after)params.set('after',filters.after);
  else if(filters.snapshot)params.set('snapshot',filters.snapshot);
  if(filters.query)params.set('query',filters.query);
  if(filters.kind!=='all')params.set('kind',filters.kind);
  if(filters.action)params.set('action',filters.action);
  if(filters.day)params.set('day',filters.day);
  return '/v1/operations/audit?'+params.toString();
}
export function auditFilterHref(filters:AuditFilters,updates:Partial<AuditFilters>){
  const next=normalizeAuditFilters({...filters,...updates});
  const changed=(['account','resource','query','kind','action','day','pageSize','sort'] as const).some(key=>filters[key]!==next[key]);
  return auditHref(next,changed?{after:'',trail:'',selected:'',page:1,snapshot:''}:{});
}
export function auditObjectRecordsHref(filters:AuditFilters,object:AuditObject){
  if(object.kind==='registered-user'||object.kind==='permission-personnel')return auditFilterHref(filters,{account:'',resource:'',query:object.id,action:'',day:'',kind:'all'});
  return auditFilterHref(filters,{account:object.kind==='account'?object.id:filters.account,resource:object.kind==='account'||object.kind==='management-account'?'':object.id,query:object.kind==='management-account'?object.id:'',action:'',day:'',kind:'all'});
}
export function auditPageHref(filters:AuditFilters,page:number,snapshot:string){
  return auditHref(filters,{page,snapshot,after:'',trail:'',selected:''});
}
export function auditPageNumbers(page:number,totalPages:number):Array<number|null>{
  return paginationPageNumbers(page,totalPages);
}
export function auditNextHref(filters:AuditFilters,nextAfter:string){
  const trail=[...auditTrail(filters.trail),filters.after||'0'].slice(-32);
  return auditHref(filters,{after:nextAfter,trail:trail.join('.'),selected:''});
}
export function auditPreviousHref(filters:AuditFilters){
  const trail=auditTrail(filters.trail),previous=trail.pop();
  return previous===undefined?null:auditHref(filters,{after:previous==='0'?'':previous,trail:trail.join('.'),selected:''});
}

function metadataValue(key:string,kind:ValueKind,value:unknown,action=''):string|null{
  if(kind==='id')return typeof value==='string'&&(uuid.test(value)||key==='targetOperatorId'&&(managementAccountActions.has(action)||action==='permission-assignment-save')&&/^[0-9a-f]{64}$/.test(value))?value:null;
  if(kind==='number')return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value.toLocaleString('zh-CN'):null;
  if(kind==='boolean')return typeof value==='boolean'?value?'是':'否':null;
  if(kind==='time'){
    if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0){const date=new Date(value*1000);return Number.isFinite(date.getTime())?auditTime(date.toISOString(),true):null;}
    return typeof value==='string'&&value.length<=64&&Number.isFinite(new Date(value).getTime())?auditTime(value,true):null;
  }
  if(kind==='token'){
    const labels=key==='kind'&&systemSettingsActions.has(action)?systemSettingsKindLabels:key==='kind'&&action.startsWith('notice-')?messageKindLabels:key==='kind'&&managementAccountActions.has(action)?managementAccountKindLabels:key==='kind'&&aiWorkActions.has(action)?aiWorkKindLabels:Object.hasOwn(tokenLabels,key)?tokenLabels[key]:null;
    return typeof value==='string'&&labels&&Object.hasOwn(labels,value)?labels[value]:null;
  }
  if(kind==='fields'&&Array.isArray(value)){
    const labels=[...new Set(value.filter((item):item is string=>typeof item==='string'&&Object.hasOwn(changeLabels,item)))].map(item=>changeLabels[item]);
    return labels.length?labels.join('、'):null;
  }
  if(kind==='management-phases'&&managementAccountActions.has(action)&&Array.isArray(value)&&value.length>0&&value.length<=7){
    const labels:string[]=[];
    for(const phase of value){
      if(!phase||typeof phase!=='object'||Array.isArray(phase)||typeof phase.kind!=='string'||typeof phase.state!=='string'
        ||!Object.hasOwn(managementPhaseLabels,phase.kind)||!Object.hasOwn(managementPhaseStateLabels,phase.state))return null;
      labels.push(managementPhaseLabels[phase.kind]+'：'+managementPhaseStateLabels[phase.state]);
    }
    return labels.join('；');
  }
  return null;
}
export function auditMetadata(value:Record<string,unknown>,action=''):AuditMetadata[]{
  const pairs:AuditMetadata[]=[];
  for(const [key,item]of Object.entries(value)){
    if(!Object.hasOwn(fields,key))continue;
    const field=fields[key],text=metadataValue(key,field.kind,item,action);
    if(text!==null)pairs.push({key,label:action==='permission-assignment-save'&&key==='enabled'?'记录时分配有效':action==='permission-assignment-save'&&key==='targetOperatorId'?'记录中的管理人员编号':field.label,value:text});
  }
  for(const [container,keys]of Object.entries(containers)){
    const nested=value[container];
    if(!nested||typeof nested!=='object'||Array.isArray(nested))continue;
    for(const key of keys){
      const field=fields[key],text=metadataValue(key,field.kind,(nested as Record<string,unknown>)[key],action);
      if(text!==null)pairs.push({key:container+'.'+key,label:field.label,value:text});
    }
  }
  return pairs;
}
export function auditOutcome(item:AuditEvent):AuditOutcome{
  for(const key of ['state','applicationState'] as const){
    const state=item.result[key];
    if(typeof state==='string'&&Object.hasOwn(stateLabels,state)){
      return {key:state,label:stateLabels[state],tone:['failed','denied'].includes(state)?'negative':['partial','pending','processing','queued','waiting','paused','unavailable','not-applied','unknown','submitting','delivering','retry','testing','reviewing','appealed','awaiting-approval','preparing','restoring','validating','ready-to-open','opening'].includes(state)?'warning':['complete','completed','succeeded','delivered','published','effective','active','ready','allowed','connected','checked','approved'].includes(state)?'positive':'neutral'};
    }
  }
  if(typeof item.result.stopped==='boolean')return {key:item.result.stopped?'access-stopped':'access-restored',label:item.result.stopped?'访问已停止':'已解除访问停止',tone:'neutral'};
  if(typeof item.result.hidden==='boolean')return {key:item.result.hidden?'hidden':'visible',label:item.result.hidden?'已隐藏':'可显示',tone:'neutral'};
  if(auditKind(item)==='reads'&&typeof item.result.count==='number'&&Number.isSafeInteger(item.result.count)&&item.result.count>=0)return {key:'recorded',label:'返回'+item.result.count+'条',tone:'neutral'};
  return auditMetadata(item.result).length?{key:'recorded',label:'结果已记录',tone:'neutral'}:{key:'unknown',label:'未记录',tone:'neutral'};
}
export function auditIsReception(item:AuditEvent){return item.result.state==='accepted'&&(registeredUserActions.has(item.action)||systemSettingsActions.has(item.action));}
const aiDomainNames={overview:'总控',governance:'治理',messaging:'消息',discovery:'数据与发现',maintenance:'运维'};
export function auditActorLabel(item:AuditEvent){
 if(item.actorKind==='operations-ai-service')return item.attribution?.aiAccountName||(item.attribution?.domain?aiDomainNames[item.attribution.domain]+' AI':'AI 工作账户');
 if(item.actorKind==='operations-executor')return '受控执行器';
 return item.actorKind==='unknown'?'执行账户未知':item.operatorDisplayName?.trim()||'管理账户';
}
export function auditActorRole(item:AuditEvent){return item.actorKind==='operations-ai-service'?'AI 工作账户':item.actorKind==='operations-executor'?'受控执行器':item.actorKind==='unknown'?'身份来源未知':auditRoleLabel(item.operatorRole??'');}
export function auditDecision(item:AuditEvent){return ({human:'人工操作','human-confirmed':'人工确认操作卡',ai:'AI 工具判断',code:'程序规则',unknown:'未记录'})[item.attribution?.decisionSource??'unknown'];}
export function auditInitiator(item:AuditEvent){
 const source=item.attribution;if(!source)return '未记录';
 return source.initiatorKind==='human'?source.initiatorDisplayName||item.actorKind==='business-operator'&&item.operatorDisplayName?.trim()||'管理账户':
  ({schedule:'值守计划','business-event':'业务事件',recovery:'恢复接续',unknown:'未记录'})[source.initiatorKind];
}
export function auditExecution(item:AuditEvent){return item.selection.execution==='worker'?'后台Worker':item.actorKind==='operations-ai-service'?'AI 服务账户':item.actorKind==='operations-executor'?'受控执行器':item.attribution?.cardId?'工作台确认执行':'未记录';}
export function auditObjects(item:AuditEvent):AuditObject[]{
  const objects:AuditObject[]=[],seen=new Set<string>();
  const add=(id:unknown,kind:string,label:string,href:string|null=null)=>{
    if(typeof id!=='string'||!uuid.test(id)||seen.has(id))return;
    seen.add(id);objects.push({id,kind,label,href});
  };
  if(item.accountId)add(item.accountId,'account','账户','/admin/operations/users?account='+encodeURIComponent(item.accountId));
  const selection=item.selection;
  // The audit action supplies the object type; an assignment UUID is not a person.
  if(item.action==='permission-role-save')add(selection.resourceId,'business-role','业务角色',typeof selection.resourceId==='string'?'/admin/operations/permissions?tab=roles&id='+encodeURIComponent(selection.resourceId):null);
  else if(item.action==='permission-automation-save')add(selection.resourceId,'automation-grant','自动执行授权',typeof selection.resourceId==='string'?'/admin/operations/permissions?tab=automatic&id='+encodeURIComponent(selection.resourceId):null);
  else if(item.action==='permission-assignment-save'){
    add(selection.resourceId,'role-assignment','角色分配记录');
    add(selection.roleId,'business-role','记录中的业务角色',typeof selection.roleId==='string'?'/admin/operations/permissions?tab=roles&id='+encodeURIComponent(selection.roleId):null);
    if(typeof selection.targetOperatorId==='string'&&/^[a-f0-9]{64}$/.test(selection.targetOperatorId)){
      seen.add(selection.targetOperatorId);objects.push({id:selection.targetOperatorId,kind:'permission-personnel',label:'记录中的管理人员',href:'/admin/operations/permissions?tab=personnel&id='+encodeURIComponent(selection.targetOperatorId)});
    }
  }
  if(registeredUserActions.has(item.action)){
    const registrationId=selection.registrationId;
    add(registrationId,'registered-user','用户账户',typeof registrationId==='string'?'/admin/operations/users?registration='+encodeURIComponent(registrationId)+'&view=detail&tab=history':null);
  }
  const operatorTarget=selection.targetOperatorId;
  if(managementAccountActions.has(item.action)&&typeof operatorTarget==='string'&&/^[a-f0-9]{64}$/.test(operatorTarget)){
    seen.add(operatorTarget);objects.push({id:operatorTarget,kind:'management-account',label:'管理账户',href:'/admin/operations/management-accounts?operator='+encodeURIComponent(operatorTarget)});
  }
  if(systemSettingsActions.has(item.action)&&typeof selection.section==='string'&&['general','mail','service-connections'].includes(selection.section)){
    const originalHref=systemSettingsOriginalHref({operationId:item.operationId,section:selection.section,kind:selection.kind,versionId:selection.versionId,revision:selection.revision});
    add(selection.versionId,originalHref?'system-settings-operation':'system-settings','系统设置版本',originalHref??'/admin/operations/system-settings?tab='+encodeURIComponent(selection.section));
  }
  const fileHref=(id:unknown)=>typeof id==='string'&&uuid.test(id)&&(selection.kind==='chat'||selection.kind==='forum')
    ?'/admin/operations/files?fileKind='+selection.kind+'&id='+encodeURIComponent(id):null;
  // A shared resourceId cannot consume the same typed file locator first.
  // The source kind is required; an unqualified UUID never guesses chat.
  if(item.action.startsWith('file-'))add(selection.id,'file','文件',fileHref(selection.id));
  const references=[
    ['feedbackId','feedback','使用反馈','/admin/operations/feedback?id='],
    ['sectionId','section','版块','/admin/operations/community?tab=sections&id='],
    ['reportId','report','举报',item.action==='community-report-resolve'||item.action==='forum-report-resolve'?'/admin/operations/community?tab=reports&id=':null],
    ['projectId','project','项目','/admin/operations/resources?kind=projects&id='],
    ['methodId','method','方法','/admin/operations/resources?kind=methods&id='],
    ['fileId','file','文件',null],
    ['noticeId','notice','通知','/admin/operations/notices?notice='],
    ['runId','run','运行',null],['jobId','job','任务',null],['resourceId','resource','对象',null],
  ] as const;
  for(const [key,kind,label,base]of references){const id=selection[key];add(id,kind,label,key==='fileId'?fileHref(id):base&&typeof id==='string'?base+encodeURIComponent(id):null);}
  if(typeof selection.id==='string'){
    if(aiWorkActions.has(item.action)&&typeof selection.domain==='string'&&Object.hasOwn(tokenLabels.domain,selection.domain))add(selection.id,'ai-account','AI 工作账户','/admin/operations/ai-work-accounts?domain='+encodeURIComponent(selection.domain));
    else if(item.action.startsWith('feedback-'))add(selection.id,'feedback','使用反馈','/admin/operations/feedback?id='+encodeURIComponent(selection.id));
    else if(item.action.startsWith('file-'))add(selection.id,'file','文件',fileHref(selection.id));
    else if(item.action==='resource-visibility'&&(selection.kind==='projects'||selection.kind==='methods'))add(selection.id,selection.kind,selection.kind==='methods'?'方法':'项目','/admin/operations/resources?kind='+selection.kind+'&id='+encodeURIComponent(selection.id));
    else add(selection.id,'resource','对象');
  }
  if(item.attribution?.taskId)add(item.attribution.taskId,'autonomy-task','共同任务',item.attribution.taskReadable?'/admin/operations/ai-runs?task='+encodeURIComponent(item.attribution.taskId):null);
  return objects;
}
export function auditRelations(item:AuditEvent,items:AuditEvent[]):AuditRelation[]{
  const objects=new Set(auditObjects(item).filter(object=>!['account','autonomy-task'].includes(object.kind)).map(object=>object.id));
  return items.filter(other=>other.id!==item.id).flatMap(other=>{
    const basis:string[]=[];
    if(item.operationId&&item.operationId===other.operationId)basis.push('同一操作');
    if(item.httpRequestId&&item.httpRequestId===other.httpRequestId)basis.push('同一请求');
    if(item.attribution?.taskId&&item.attribution.taskId===other.attribution?.taskId)basis.push('同一任务');
    if(auditObjects(other).some(object=>!['account','autonomy-task'].includes(object.kind)&&objects.has(object.id)))basis.push('同一对象');
    return basis.length?[{item:other,basis}]:[];
  });
}
