import type {SummaryDays,SummaryPeriod} from './admin-analytics-types';
export type {AccountDirectorySummary,AccountSummary,SummaryDays,SummaryPeriod,ActivityDay,SummaryTopic,AnalysisState} from './admin-analytics-types';

export function summaryDays(value:string|null|undefined):SummaryDays{return value==='28'?28:7;}
export function countLabel(value:number|null|undefined){return typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('zh-CN').format(value):'—';}
export function shortDate(value:string|null|undefined){
  if(!value)return '未记录';
  const date=new Date(value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'}).format(date):'未记录';
}
export function dateTime(value:string|number|null|undefined){
  if(value==null)return '未记录';
  const date=new Date(typeof value==='number'&&value<1e12?value*1000:value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date):'未记录';
}
export function periodLabel(period:SummaryPeriod|null|undefined){return period?`${shortDate(period.from)} – ${shortDate(period.to)}`:'';}
