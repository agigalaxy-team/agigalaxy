import type {OperationsSummary,RecentOperation} from "../analytics/admin-analytics-types";
import type {AdminIconName} from "../../components/AdminIcons";
import type {WorkbenchInventory,WorkbenchMetric} from "../../components/workbench/WorkbenchCharts";

export type WorkbenchPending={id:string;group:'reports'|'feedback'|'files'|'delivery'|'system';label:string;count:number;unit:string;href:string;icon:AdminIconName};
export type WorkbenchRecord={id:string;label:string;createdAt:string;href:string;source:string};
export type WorkbenchShortcut={id:string;label:string;href:string;icon:AdminIconName};

export const workbenchShortcuts:WorkbenchShortcut[]=[
  {id:'users',label:'用户查询',href:'/admin/operations/users',icon:'users'},
  {id:'public-content',label:'公开内容',href:'/admin/operations/community?tab=posts',icon:'content'},
  {id:'notices',label:'消息计划',href:'/admin/operations/messaging',icon:'messages'},
  {id:'autonomy',label:'自动运行',href:'/admin/operations/autonomy',icon:'strategy'},
  {id:'ai-runs',label:'任务与运行',href:'/admin/operations/ai-runs',icon:'activity'},
  {id:'reports',label:'社区举报',href:'/admin/operations/community?tab=reports&state=pending',icon:'governance'},
  {id:'chat-reports',label:'私聊举报',href:'/admin/operations/chat-reports',icon:'permissions'},
  {id:'files',label:'文件处理',href:'/admin/operations/files',icon:'file'},
  {id:'resources',label:'项目与方法',href:'/admin/operations/resources',icon:'briefcase'},
  {id:'rules',label:'业务规则',href:'/admin/operations/rules',icon:'settings'},
  {id:'jobs',label:'后台任务',href:'/admin/operations/jobs',icon:'maintenance'},
  {id:'audit',label:'业务审计',href:'/admin/operations/audit',icon:'history'},
];
export const defaultWorkbenchShortcuts=['users','public-content','notices'];

const actionLabels:Record<string,string>={
  'community-section-classify':'调整版块分类','community-section-visibility':'处理版块显示','community-report-resolve':'处理社区举报',
  'restriction-set':'暂停社区参与','restriction-release':'解除社区参与限制','type-change':'更正账户类型',
  'rule-save':'保存业务规则','notice-create':'创建通知','notice-save':'修改通知','notice-publish':'发布通知','notice-withdraw':'撤回通知','notice-delivery':'执行通知投递',
  'retention-request':'安排到期清理','retention-complete':'到期清理完成','retention-failed':'到期清理失败',
  'section-classification':'调整版块分类','section-visibility':'处理版块显示','forum-report-resolve':'处理社区举报','resource-visibility':'处理资料显示',
  'file-retry':'重新安排文件处理','operations-job-cancel':'取消后台任务','operations-job-retry':'重试后台任务','search-recovery-retry':'安排检索恢复',
};

export function workbenchTime(value:string|number|null|undefined,mode:'time'|'day'='time'){
  if(value===null||value===undefined)return '未记录';
  const date=new Date(typeof value==='number'?value*1000:value);
  if(!Number.isFinite(date.getTime()))return '未记录';
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(mode==='day'?{month:'2-digit',day:'2-digit'}:{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}).format(date);
}

function operationHref(operation:RecentOperation){
  if(operation.action.startsWith('notice-'))return '/admin/operations/notices';
  if(operation.action==='rule-save')return '/admin/operations/rules';
  if(operation.action.startsWith('retention-'))return '/admin/operations/retention';
  if(operation.action.startsWith('file-'))return '/admin/operations/files';
  if(operation.action.startsWith('search-'))return '/admin/operations/search-recovery';
  if(operation.action.includes('job-'))return '/admin/operations/jobs';
  if(operation.accountId)return '/admin/operations/users?account='+encodeURIComponent(operation.accountId);
  return '/admin/operations/audit';
}

export function workbenchRecords(summary:OperationsSummary|null):WorkbenchRecord[]{
  return (summary?.recentOperations??[]).map(operation=>({id:operation.id,label:actionLabels[operation.action]??'业务处理',createdAt:operation.createdAt,href:operationHref(operation),source:'管理操作'}));
}

export function workbenchMetrics(summary:OperationsSummary|null):WorkbenchMetric[]{
  return [
    {id:'visitors',label:'访客',value:summary?.analytics?.visitors??null,icon:'users'},
    {id:'page-views',label:'页面访问',value:summary?.analytics?.pageViews??null,icon:'content'},
    {id:'accounts',label:'活跃账户',value:summary?.analytics?.activeAccounts??null,icon:'user'},
    {id:'retention',label:'7日回访',value:summary?.analytics?.returnRate??null,unit:'%',icon:'analytics'},
  ];
}

export function workbenchInventory(summary:OperationsSummary|null):WorkbenchInventory[]{
  return [
    {id:'sections',label:'活动版块',value:summary?.sections?.active??null,denied:summary?.availability?.sections==='not-authorized',href:'/admin/operations/community?tab=sections&state=active',icon:'content'},
    {id:'projects',label:'活动项目',value:summary?.resources?.projects??null,denied:summary?.availability?.resources==='not-authorized',href:'/admin/operations/resources?kind=projects&state=active',icon:'briefcase'},
    {id:'methods',label:'方法',value:summary?.resources?.methods??null,denied:summary?.availability?.resources==='not-authorized',href:'/admin/operations/resources?kind=methods',icon:'content'},
  ];
}

export function workbenchPending(summary:OperationsSummary|null):WorkbenchPending[]{
  if(!summary)return [];
  const items:WorkbenchPending[]=[];
  if(summary.communityReports)items.push({id:'community-reports',group:'reports',label:'社区举报',count:summary.communityReports.pending,unit:'条待处理',href:'/admin/operations/community?tab=reports&state=pending',icon:'governance'});
  if(summary.chatReports)items.push({id:'chat-reports',group:'reports',label:'私聊举报',count:summary.chatReports.pending,unit:'条待处理',href:'/admin/operations/chat-reports',icon:'permissions'});
  if(summary.files)items.push(
    {id:'scan-failed',group:'files',label:'文件扫描异常',count:summary.files.scanFailed,unit:'个文件',href:'/admin/operations/files?issue=scan',icon:'file'},
    {id:'cleanup-unknown',group:'files',label:'文件清理结果待核对',count:summary.files.cleanupResultUnknown,unit:'个文件',href:'/admin/operations/files?issue=cleanup',icon:'file'},
  );
  if(summary.search)items.push({id:'search',group:'system',label:'检索待恢复',count:summary.search.failed,unit:'项任务',href:'/admin/operations/search-recovery',icon:'search'});
  if(summary.feedback){
    items.push(
      {id:'feedback-pending',group:'feedback',label:'反馈待处理',count:summary.feedback.pending,unit:'条待处理',href:'/admin/operations/feedback?state=pending',icon:'comment'},
      {id:'feedback-processing',group:'feedback',label:'反馈处理中',count:summary.feedback.processing,unit:'条处理中',href:'/admin/operations/feedback?state=processing',icon:'comment'},
    );
  }
  for(const job of (summary.jobs?.byQueue??[]).filter(job=>job.state==='failed'&&job.queue!=='search-recovery')){
    const label=job.queue==='account-notice'?'站内通知投递失败':job.queue==='retention-cleanup'?'到期清理失败':job.queue==='information-watch'?'资料关注执行失败':job.queue==='content-publication'?'官网发布失败':'后台任务失败';
    items.push({id:'job-'+job.queue,group:job.queue==='account-notice'?'delivery':'system',label,count:job.count,unit:'项任务',href:'/admin/operations/jobs?queue='+encodeURIComponent(job.queue),icon:job.queue==='account-notice'?'messages':'maintenance'});
  }
  return items.filter(item=>Number.isFinite(item.count)&&item.count>0);
}

export function workbenchJobState(summary:OperationsSummary|null){
  if(!summary?.jobs)return null;
  return {running:summary.jobs.byQueue.filter(item=>item.state==='active').reduce((total,item)=>total+item.count,0),waiting:summary.jobs.byQueue.filter(item=>item.state==='created'||item.state==='retry').reduce((total,item)=>total+item.count,0)};
}
