'use client';

import {useMemo} from 'react';
import type {AccountUsageAnalysisValue} from './account-usage-analysis-types';
import {RetentionGrid} from './analytics/AnalyticsChartPrimitives';
import {UsageFlowChart} from './analytics/AnalyticsCharts';
import {AdminIcon} from './AdminIcons';
import {accountUsageAnalysis,accountUsageUnavailable} from '../lib/account-usage-analysis-view-model';
import {analyticsDurationSeconds,analyticsNumber,analyticsPercent} from '../lib/analytics-view-model';
import {dateTime} from '../lib/account-summary';
import './account-usage-analysis.css';

export function AccountUsageAnalysis({value,accountId,loading=false}:{value:AccountUsageAnalysisValue|null|undefined;accountId:string;loading?:boolean}){
 const current=useMemo(()=>accountUsageAnalysis(value,accountId),[value,accountId]);
 if(!current)return loading?null:<section className="galaxy-account-panel galaxy-account-usage-analysis"><h2>使用分析</h2><p className="account-usage-empty">使用分析尚未取得</p></section>;
 const lifetime=current.lifetime.data,paths=current.paths.data,retention=current.retention.data;
 const totals=[{key:'sessions',label:'会话',icon:'comment',unit:'次'},{key:'screenViews',label:'页面访问',icon:'activity',unit:'次'},{key:'totalEvents',label:'使用事件',icon:'analytics',unit:'次'},{key:'uniqueDaysActive',label:'活跃',icon:'calendar',unit:'天'}] as const;
 const facts=[
  ['平均会话时长',analyticsDurationSeconds(lifetime?.avgSessionDurationMin==null?null:lifetime.avgSessionDurationMin*60)],
  ['90分位会话时长',analyticsDurationSeconds(lifetime?.p90SessionDurationMin==null?null:lifetime.p90SessionDurationMin*60)],
  ['每次会话事件',analyticsNumber(lifetime?.avgEventsPerSession)],
  ['会话平均间隔',analyticsDurationSeconds(lifetime?.avgTimeBetweenSessionsSec)],
  ['跳出率',analyticsPercent(lifetime?.bounceRate)],
  ['其他事件',analyticsNumber(lifetime?.conversionEvents)],
 ];
 return <div className="galaxy-account-usage-analysis" aria-label="账户使用分析">
  <section className="galaxy-account-panel account-usage-lifetime" aria-label="累计使用">
   <header><h2>累计使用</h2><span>全部已记录时间</span></header>
   {lifetime?<>
    <dl className="account-usage-totals">{totals.map(item=><div key={item.key}><AdminIcon name={item.icon} size={22}/><div><dt>{item.label}</dt><dd>{analyticsNumber(lifetime[item.key])}{lifetime[item.key]!==null&&<small>{item.unit}</small>}</dd></div></div>)}</dl>
    <dl className="account-usage-facts">{facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="account-usage-record-range"><span>首次记录 {dateTime(lifetime.firstSeen)}</span><span>最近记录 {dateTime(lifetime.lastSeen)}</span><span>上海时间</span></div>
    <p className="account-usage-note">其他事件：除页面访问、会话开始和结束之外的使用事件。</p>
   </>:<p className="account-usage-empty">{accountUsageUnavailable(current.lifetime)}</p>}
  </section>
  <section className="galaxy-account-panel account-usage-paths" aria-label="此账户主要使用路径">
   <header><h2>主要使用路径</h2><span>此账户 · 会话路径</span></header>
   {paths?<><p className="account-usage-period">{dateTime(current.paths.basis?.from)} 至 {dateTime(current.paths.basis?.to)} · 上海时间</p><UsageFlowChart data={paths} unit="account-session-path-transitions"/><p className="account-usage-note">主要使用事件之间的转移，仅显示 Top 路径。{current.paths.basis?.timezone?.name?'按 '+current.paths.basis.timezone.name+' 归组。':'归组时区未提供。'}</p></>:<p className="account-usage-empty">{accountUsageUnavailable(current.paths)}</p>}
  </section>
  <section className="galaxy-account-panel account-usage-retention" aria-label="此账户近12周使用留存">
   <header><h2>使用留存</h2><span>此账户 · 固定近12周</span></header>
   {retention?<><RetentionGrid data={retention} unit="accounts"/><p className="account-usage-note">按窗口内首次活动周分组，查看第N周及以后是否仍有活动。{current.retention.basis?.timezone?.name?'按 '+current.retention.basis.timezone.name+' 周界。':'周界沿用分析服务默认时区。'}</p></>:<p className="account-usage-empty">{accountUsageUnavailable(current.retention)}</p>}
  </section>
 </div>;
}
