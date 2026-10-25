import type {AutonomyAccount,AutonomyConfig,AutonomyDomain,AutonomyDutyDraft,AutonomyMode,AutonomySource,AutonomyTask} from '../components/autonomy-types';

export const autonomyBase='/v1/operations/autonomy';
export const autonomyRoute='/admin/operations/autonomy';
export const autonomyDomains:Record<AutonomyDomain,string>={overview:'总控',governance:'治理',messaging:'消息',discovery:'数据与发现',maintenance:'运维'};
export const autonomyModes:Record<AutonomyMode,string>={code:'程序自动',ai:'AI自主','ai-human':'AI与人工协作','human-ai':'人工主导'};
export const autonomySources:Record<AutonomySource,string>={workbench:'工作台',routine:'例行值守',event:'业务事件',recovery:'恢复接续'};
export const autonomyStates:Record<string,string>={pending:'等待处理',queued:'排队中',ready:'就绪',running:'处理中','waiting-human':'等待人工','awaiting-human':'等待人工',paused:'已暂停',stopped:'已停止',cancelled:'已停止',completed:'处理结束',failed:'运行失败',unknown:'结果待核对','no-action':'维持现状',blocked:'处理受阻',reconciling:'核对原结果'};
export const autonomyBusinessStates:Record<string,string>={completed:'已取得业务结果',applied:'已生效',confirmed:'已确认',changed:'已更新',unchanged:'维持现状','no-action':'维持现状',pending:'尚未办理','not-started':'尚未办理','waiting-human':'等待人工','awaiting-human':'等待人工',failed:'办理失败',unknown:'结果待核对',none:'无业务动作','not-applicable':'无业务动作',recorded:'已记录',accepted:'已受理'};
export const autonomyModelStates:Record<string,string>={dispatching:'正在发起模型',accepted:'模型已受理',pending:'等待模型',queued:'等待模型',running:'模型运行中',completed:'模型已答复',failed:'模型调用失败',unknown:'模型结果未确认','not-required':'无需模型','not-started':'尚未调用','not-configured':'模型未配置',unavailable:'模型暂不可用',PENDING:'等待模型',RUNNING:'模型运行中',COMPLETED:'模型已答复',ERROR:'模型调用失败',PAUSED:'模型已暂停',CANCELLED:'模型已停止'};
export const autonomyHealthNames:Record<string,string>={healthy:'正常值守',ready:'已就绪',disabled:'待启用',pending:'待启用','not-enabled':'待启用',running:'正在值守',late:'巡检逾期',overdue:'巡检逾期',attention:'需要处理',degraded:'需要处理',blocked:'未就绪',unavailable:'暂不可用',unknown:'健康未确认'};
export const autonomyResultNames:Record<string,string>={completed:'完成',applied:'完成',unchanged:'维持现状','no-action':'维持现状','waiting-human':'等待人工','awaiting-human':'等待人工',failed:'失败',unknown:'结果未知',pending:'尚未完成'};
export function autonomyNumber(value:number|null|undefined){return typeof value==='number'&&Number.isFinite(value)&&value>=0?value.toLocaleString('zh-CN'):'—';}
export function autonomyPercent(value:number|null|undefined){return typeof value==='number'&&Number.isFinite(value)&&value>=0?new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1}).format(value>1?value/100:value):'无样本';}
export function autonomyDate(value:string|null|undefined,short=false){return value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(short?{}:{year:'numeric'}),month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'未记录';}
export function autonomySchedule(config:Pick<AutonomyConfig,'schedule'>){return config.schedule.kind==='daily'?config.schedule.at?'每日 '+config.schedule.at:'每日 · 时刻待选':'每 '+config.schedule.minutes+' 分钟';}
export function autonomyAccountState(account:AutonomyAccount){return !account.config.enabled?'待启用':autonomyHealthNames[account.health]??'健康未确认';}
export function autonomyTaskHref(task:Pick<AutonomyTask,'id'>|string){return '/admin/operations/ai-runs?task='+encodeURIComponent(typeof task==='string'?task:task.id);}
export function autonomyAccountHref(domain:AutonomyDomain,tab='overview'){return '/admin/operations/ai-work-accounts?'+new URLSearchParams({domain,tab});}
export function autonomyTaskTitle(task:AutonomyTask){return task.title?.trim()||autonomyDomains[task.domain]+' · '+autonomySources[task.source];}
export function autonomyTaskTone(task:AutonomyTask){return ['failed','unknown','blocked'].includes(task.state)||['failed','unknown'].includes(task.businessState??'')?'attention':['waiting-human','awaiting-human'].includes(task.state)?'human':task.state==='running'?'active':'neutral';}
export function autonomyWait(task:AutonomyTask,now=Date.now()){const start=Date.parse(task.updatedAt);if(!Number.isFinite(start))return '未记录';const minutes=Math.max(0,Math.floor((now-start)/60000));return minutes<60?minutes+' 分钟':Math.floor(minutes/60)+' 小时'+(minutes%60?' '+minutes%60+' 分钟':'');}
export function autonomyConfigBody(config:AutonomyConfig){return {expectedRevision:config.revision,enabled:config.enabled,mode:config.mode,schedule:structuredClone(config.schedule),purpose:config.purpose.trim(),goal:config.goal.trim(),prompt:config.prompt,plan:structuredClone(config.plan)};}
export function autonomyConfigMerge(draft:AutonomyDutyDraft,current:AutonomyConfig,choices:Record<string,'mine'|'current'>={}){
 const configuration=structuredClone(current),conflicts:{key:string;label:string;mine:string;current:string}[]=[];
 const labels={enabled:'值守状态',mode:'处理方式',schedule:'值守时间',purpose:'岗位职责',goal:'工作目标',prompt:'岗位提示词',plan:'关联策略和自主范围'};
 const display=(value:unknown)=>typeof value==='boolean'?value?'已启用':'已暂停':typeof value==='string'?autonomyModes[value as AutonomyMode]??value:JSON.stringify(value);
 for(const field of Object.keys(labels) as (keyof typeof labels)[]){const base=draft.base[field],mine=draft.configuration[field],remote=current[field];let result=remote;
  if(JSON.stringify(base)===JSON.stringify(mine))result=remote;
  else if(JSON.stringify(base)===JSON.stringify(remote)||JSON.stringify(mine)===JSON.stringify(remote))result=mine;
  else{conflicts.push({key:field,label:labels[field],mine:display(mine),current:display(remote)});result=choices[field]==='current'?remote:mine;}
  (configuration as unknown as Record<string,unknown>)[field]=structuredClone(result);
 }
 return {configuration,conflicts,ready:conflicts.every(row=>!!choices[row.key])};
}
export const autonomyErrors:Record<string,string>={operations_autonomy_version_changed:'设置已有更新，你的修改已保留。',operations_autonomy_revision_changed:'设置已有更新，你的修改已保留。',operations_autonomy_not_ready:'所选岗位尚未就绪，请补齐列出的条件。',operations_autonomy_schedule_required:'请先为运维选择每日巡检时刻。',operations_autonomy_daily_time_required:'请先为运维选择每日巡检时刻。',operations_autonomy_task_changed:'任务已有变化，已读取当前状态。',operations_autonomy_task_control_denied:'当前任务不能执行这个操作。',operations_permission_denied:'当前权限不允许这项操作。',invalid_operations_autonomy_request:'请检查填写内容后再保存。'};
