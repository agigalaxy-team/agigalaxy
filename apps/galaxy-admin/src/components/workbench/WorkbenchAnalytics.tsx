'use client';

import {useEffect,useRef} from 'react';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {useOperationsRead} from '../../lib/use-operations-read';
import {analyticsDate,analyticsLocation,analyticsNumber,analyticsOverview,analyticsPath,analyticsPercent,analyticsRetention} from "../../lib/analytics/analytics-view-model";
import type {OperationsSummary} from "../../lib/analytics/admin-analytics-types";
import {workbenchTime} from "../../lib/workbench/workbench-view-model";
import {AdminTabs} from '../AdminTabs';
import {ReadStatus} from '../OperationControls';
import {AnalyticsDaysControl,RetentionGrid} from '../analytics/AnalyticsChartPrimitives';
import {UsageTrendChart} from '../analytics/UsageTrendChart';
import type {AnalyticsEnvelope} from "../analytics/analytics-types";
import {WorkbenchActivityChart,WorkbenchEmpty,WorkbenchInventoryChart,WorkbenchMetrics} from './WorkbenchCharts';
import type {WorkbenchInventory,WorkbenchMetric} from './WorkbenchCharts';

type Access='authorized'|'denied'|'unverified';
type Props={access:Access;publicAccess:Access;operatorId:string|null;summaryLoading:boolean;refreshKey:number;refreshSummary:()=>Promise<unknown>;inventory:WorkbenchInventory[]};

function useUsageRead(path:string|null,failureMessage:string){
 const read=useOperationsRead<AnalyticsEnvelope>({path,clearOnOffline:true,failureMessage});
 return {...read,value:read.value&&Number.isFinite(read.value.checkedAt)&&read.value.checkedAt*1000+30000>Date.now()?read.value:null};
}

function PublicActivityRead({operatorId,refreshKey,refreshSummary}:{operatorId:string;refreshKey:number;refreshSummary:()=>Promise<unknown>}){
 const read=useOperationsRead<OperationsSummary>({path:'/v1/operations/summary',clearOnOffline:true,failureMessage:'公开贡献暂时无法取得。'});
 const lastRefresh=useRef(refreshKey);
 useEffect(()=>{if(lastRefresh.current===refreshKey)return;lastRefresh.current=refreshKey;void read.read();},[refreshKey,read.read]);
 const value=read.value,matching=value?.operator.id===operatorId;
 if(value&&!matching)return <div className="wb-public-activity" role="status"><WorkbenchEmpty title="管理身份已变化，请更新工作台"/><button type="button" className="wb-text-button" onClick={()=>void refreshSummary()}>更新工作台</button></div>;
 const denied=!!value&&matching&&(value.availability.businessActivity==='not-authorized'||!value.operator.businessAuthorization.permissions.includes('content.read'));
 const activity=value&&matching&&!denied&&value.availability.businessActivity==='available'?value.businessActivity:null;
 return <><div className="wb-public-activity"><ReadStatus loading={read.loading} error={read.error} retry={read.read}/></div><WorkbenchActivityChart daily={activity?.daily??[]} available={activity?.available===true&&!!activity.daily.length} denied={denied} loading={!read.ready||read.loading} basis={activity?.available?'按首次发表日期统计当前仍可公开阅读的内容 · 近'+activity.days+'日。':undefined}/></>;
}

export function WorkbenchAnalytics({access,publicAccess,operatorId,summaryLoading,refreshKey,refreshSummary,inventory}:Props){
 const router=useRouter(),search=useSearchParams();
 const rawDays=search.getAll('days'),days=analyticsLocation({days:rawDays.length===1?rawDays[0]:''}).days;
 const chart=search.get('chart')==='public'?'public':'usage';
 const read=useUsageRead(access==='authorized'?analyticsPath('overview',days):null,'访问数据暂时无法取得。');
 const retention=useUsageRead(access==='authorized'?analyticsPath('retention'):null,'使用留存暂时无法取得。');
 const current=read.value;
 const overview=current?.kind==='overview'?analyticsOverview(current.data):null;
 const cohorts=retention.value?.kind==='retention'?analyticsRetention(retention.value.data,retention.value.checkedAt):null;
 const lastRefresh=useRef(refreshKey);
 useEffect(()=>{if(lastRefresh.current===refreshKey)return;lastRefresh.current=refreshKey;if(access==='authorized'){void read.read();void retention.read();}},[refreshKey,access,read.read,retention.read]);
 function navigate(patch:{days?:number;chart?:string}){
  const query=new URLSearchParams(search.toString());
  if(patch.days!==undefined){if(patch.days===7)query.delete('days');else query.set('days',String(patch.days));}
  if(patch.chart!==undefined){if(patch.chart==='usage')query.delete('chart');else query.set('chart',patch.chart);}
  router.push('/admin'+(query.size?'?'+query:''),{scroll:false});
 }
 const metrics:WorkbenchMetric[]=[
  {id:'visitors',label:'访客',value:overview?.summary.unique_visitors??null,displayValue:analyticsNumber(overview?.summary.unique_visitors??null),icon:'users'},
  {id:'page-views',label:'页面访问',value:overview?.summary.total_screen_views??null,displayValue:analyticsNumber(overview?.summary.total_screen_views??null),icon:'content'},
  {id:'accounts',label:'会话',value:overview?.summary.total_sessions??null,displayValue:analyticsNumber(overview?.summary.total_sessions??null),icon:'activity'},
  {id:'retention',label:'跳出率',value:overview?.summary.bounce_rate??null,displayValue:analyticsPercent(overview?.summary.bounce_rate??null),icon:'analytics'},
 ];
 const href='/admin/operations/analytics?days='+days;
 const basis=typeof current?.basis.from==='string'&&typeof current.basis.to==='string'?analyticsDate(current.basis.from)+' – '+analyticsDate(current.basis.to)+' · UTC日期':'近'+days+'日';
 return <div className="wb-usage-block">
  <div className="wb-usage-controls"><AnalyticsDaysControl days={days} onChange={value=>navigate({days:value})}/><Link href={href} prefetch={false} className="wb-text-link">完整使用分析</Link></div>
  <WorkbenchMetrics items={metrics}/>
  <div className="wb-usage-status" aria-live="polite">{access==='denied'?<span>没有使用分析的查看权限</span>:access==='unverified'?<span>{summaryLoading?'正在核对查看权限…':'查看权限暂时无法核对'}</span>:<><span>{basis}</span><span>网站使用 · OpenPanel{current?' · '+workbenchTime(current.checkedAt):''}</span></>}</div>
  <div className="wb-charts"><section className="wb-trend wb-usage-trend"><header className="wb-section-heading"><AdminTabs items={[{id:'usage',label:'访问趋势'},{id:'public',label:'公开贡献'}]} active={chart} onChange={value=>navigate({chart:value})} ariaLabel="工作台趋势"/></header>
   {chart==='public'?publicAccess==='authorized'&&operatorId?<PublicActivityRead key={operatorId} operatorId={operatorId} refreshKey={refreshKey} refreshSummary={refreshSummary}/>:publicAccess==='denied'?<WorkbenchActivityChart daily={[]} available={false} denied loading={false}/>:<WorkbenchEmpty title={summaryLoading?'正在核对公开贡献查看权限':'公开贡献查看权限暂时无法核对'}/>:access==='denied'?<WorkbenchEmpty title="没有使用分析的查看权限"/>:access==='unverified'?<WorkbenchEmpty title={summaryLoading?'正在读取查看权限':'查看权限暂时无法核对'}/>:<><ReadStatus loading={read.loading} error={read.error} retry={read.read}/>{overview?<UsageTrendChart data={overview.series} compact/>:!read.loading&&!read.error&&<WorkbenchEmpty title="访问数据暂时无法取得"/>}</>}
  </section><div className="wb-chart-side"><WorkbenchInventoryChart items={inventory}/><section className="wb-retention"><header className="wb-section-heading"><h2>使用留存</h2></header><p className="wb-usage-retention-basis">近12周 · 最近4组／前4周</p>{access==='denied'?<WorkbenchEmpty title="没有使用分析的查看权限"/>:access==='unverified'?<WorkbenchEmpty title={summaryLoading?'正在读取查看权限':'查看权限暂时无法核对'}/>:<><ReadStatus loading={retention.loading} error={retention.error} retry={retention.read}/>{cohorts?<RetentionGrid data={cohorts} compact/>:!retention.loading&&!retention.error&&<WorkbenchEmpty title="使用留存暂时无法取得"/>}<Link href={href+'#retention'} prefetch={false} className="wb-text-link">查看完整留存</Link></>}<p className="wb-usage-retention-note">独立于所选访问日期范围</p></section></div></div>
 </div>;
}
