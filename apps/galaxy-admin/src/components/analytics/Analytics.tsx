'use client';

import {useEffect,useMemo,useState} from 'react';
import type {ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useOperationsRead} from '../../lib/use-operations-read';
import {analyticsAudienceBasis,analyticsBusiness,analyticsDurationSeconds,analyticsFlow,analyticsHref,analyticsNumber,analyticsOverview,analyticsPath,analyticsPercent,analyticsRetention} from '../../lib/analytics-view-model';
import {AdminIcon} from '../AdminIcons';
import type {AdminIconName} from '../AdminIcons';
import {AnalyticsDaysControl,AnalyticsObjectControl,BusinessVolumeChart,RetentionGrid,UsageFlowChart,UsageTrendChart} from './AnalyticsCharts';
import type {AnalyticsEnvelope,AnalyticsLocation} from '../analytics-types';
import './analytics.css';

type AnalyticsRead={loading:boolean;error:string;value:AnalyticsEnvelope|null;read:()=>Promise<unknown>};
function PanelState({resource,valid,children}:{resource:AnalyticsRead;valid:boolean;children:ReactNode}){
 if(resource.error)return <div className="analytics-region-state" role="alert"><p>{resource.error}</p><button type="button" disabled={resource.loading} onClick={()=>void resource.read()}>重新读取</button></div>;
 if(resource.loading&&!resource.value)return <div className="analytics-region-state" role="status">正在读取…</div>;
 if(!resource.value)return <div className="analytics-region-state">数据需要重新读取。<button type="button" onClick={()=>void resource.read()}>读取数据</button></div>;
 if(!valid)return <div className="analytics-region-state" role="status">当前统计暂时无法呈现。<button type="button" disabled={resource.loading} onClick={()=>void resource.read()}>重新读取</button></div>;
 return <>{resource.loading&&<span className="analytics-region-updating" role="status">正在更新…</span>}{children}</>;
}
function Metric({label,value,unit,icon}:{label:string;value:ReactNode;unit?:string;icon:AdminIconName}){return <div className="analytics-metric"><span className="analytics-metric-icon"><AdminIcon name={icon} size={23}/></span><div><dt>{label}</dt><dd>{value}{unit&&value!=='—'&&<small>{unit}</small>}</dd></div></div>;}

function overviewTimeZone(value:unknown):string|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const basis=value as Record<string,unknown>;
 if(basis.source!=='native-project-settings'||typeof basis.name!=='string'||basis.name.length>100)return null;
 try{new Intl.DateTimeFormat('en',{timeZone:basis.name}).format(0);return basis.name;}catch{return null;}
}
function overviewRangeDate(value:string,timeZone:string|null){
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return '未记录';
 return timeZone?new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date):date.toISOString();
}

export function Analytics({location}:{location:AnalyticsLocation}){
 const router=useRouter(),[knownAccount,setKnownAccount]=useState(location.accountId);
 useEffect(()=>{if(location.accountId)setKnownAccount(location.accountId);},[location.accountId]);
 const contextAccount=location.accountId??knownAccount,object=location.scope==='accounts'?(location.accountId?'account':'accounts'):'all',objectLabel=object==='account'?'此账户':object==='accounts'?'登录账户':'全部访问';
 const overview=useOperationsRead<AnalyticsEnvelope>({path:analyticsPath('overview',location.days),failureMessage:'访问统计暂时无法取得。',clearOnOffline:true}),retention=useOperationsRead<AnalyticsEnvelope>({path:analyticsPath('retention',7,location.accountId??'',location.scope),failureMessage:'留存统计暂时无法取得。',clearOnOffline:true}),paths=useOperationsRead<AnalyticsEnvelope>({path:analyticsPath('paths',location.days,location.accountId??'',location.scope),failureMessage:'使用路径暂时无法取得。',clearOnOffline:true}),business=useOperationsRead<AnalyticsEnvelope>({path:analyticsPath('business',location.days),failureMessage:'业务使用次数暂时无法取得。',clearOnOffline:true});
 const retentionBasis=useMemo(()=>retention.value?.kind==='retention'?analyticsAudienceBasis(retention.value.basis,'retention',location):null,[retention.value,location.scope,location.accountId]),pathsBasis=useMemo(()=>paths.value?.kind==='paths'?analyticsAudienceBasis(paths.value.basis,'paths',location):null,[paths.value,location.scope,location.accountId]);
 const usage=useMemo(()=>overview.value?.kind==='overview'?analyticsOverview(overview.value.data):null,[overview.value]),cohorts=useMemo(()=>retention.value&&retentionBasis?analyticsRetention(retention.value.data,retention.value.checkedAt,location.scope?retentionBasis.timeZone:undefined):null,[retention.value,retentionBasis,location.scope]),flow=useMemo(()=>paths.value&&pathsBasis?analyticsFlow(paths.value.data):null,[paths.value,pathsBasis]),volume=useMemo(()=>business.value?.kind==='business'?analyticsBusiness(business.value.data):null,[business.value]);
 const anyLoading=overview.loading||retention.loading||paths.loading||business.loading;
 const range=overview.value?.basis,from=typeof range?.from==='string'?range.from:null,to=typeof range?.to==='string'?range.to:null,timeZone=overviewTimeZone(range?.timezone),timeZoneLabel=timeZone?'项目时区 '+timeZone:'原生时区未提供';
 function changeDays(days:number){router.push(analyticsHref(location,{days}),{scroll:false});}
 function changeObject(value:'all'|'accounts'|'account'){
  if(value==='account'&&!contextAccount)return;
  router.push(analyticsHref(location,{scope:value==='all'?undefined:'accounts',accountId:value==='account'?contextAccount:undefined}),{scroll:false});
 }
 return <section className="galaxy-analytics" aria-label="核心使用分析">
  <header className="analytics-page-header"><div><h1>访问与参与概览</h1><p>{from&&to?overviewRangeDate(from,timeZone)+' — '+overviewRangeDate(to,timeZone)+' · '+timeZoneLabel:'访问范围：首页、社区、发现、账户、帮助、下载'}</p></div><div className="analytics-page-actions"><AnalyticsObjectControl value={object} hasAccount={!!contextAccount} onChange={changeObject}/><AnalyticsDaysControl days={location.days} onChange={changeDays}/><button type="button" disabled={anyLoading} onClick={()=>{void overview.read();void retention.read();void paths.read();void business.read();}}><AdminIcon name="refresh" size={15}/>刷新</button></div></header>
  <dl className="analytics-metrics" aria-label="访问统计"><Metric label="去重访客" value={analyticsNumber(usage?.summary.unique_visitors)} unit="个分析标识" icon="users"/><Metric label="页面浏览" value={analyticsNumber(usage?.summary.total_screen_views)} unit="次" icon="content"/><Metric label="会话" value={analyticsNumber(usage?.summary.total_sessions)} unit="次" icon="activity"/><Metric label="跳出率" value={analyticsPercent(usage?.summary.bounce_rate)} icon="analytics"/></dl>
  <div className="analytics-overview-grid">
   <section className="analytics-panel analytics-panel--trend" aria-labelledby="analytics-trend-title"><header><div><h2 id="analytics-trend-title">访问趋势</h2><p>每日 · {timeZoneLabel}</p></div><span>{usage&&<>平均会话 {analyticsDurationSeconds(usage.summary.avg_session_duration)}</>}</span></header><div className="analytics-panel-scroll"><PanelState resource={overview} valid={!!usage}>{usage&&<><UsageTrendChart data={usage.series}/><p className="analytics-basis">访客按分析标识去重，包含匿名访问；未回填历史。</p></>}</PanelState></div></section>
   <section className="analytics-panel analytics-panel--paths" aria-labelledby="analytics-paths-title"><header><div><h2 id="analytics-paths-title">使用路径</h2><p>{objectLabel} · 主要路径Top子集 · 最多5步</p></div></header><div className="analytics-panel-scroll"><PanelState resource={paths} valid={!!flow}>{flow&&<><UsageFlowChart data={flow} unit={pathsBasis?.object==='all'?'session-path-transitions':'account-session-path-transitions'}/><p className="analytics-basis">按{location.scope?'账户会话':'会话'}统计主要路径的转移次数。{location.scope&&(pathsBasis?.timeZone?'时区：'+pathsBasis.timeZone+'。':'原生时区未提供。')}</p></>}</PanelState></div></section>
   <section id="retention" className="analytics-panel analytics-panel--retention" aria-labelledby="analytics-retention-title"><header><div><h2 id="analytics-retention-title">使用留存</h2><p>近12周 · 窗口内首次活动周</p></div><span>{objectLabel} · 固定周口径</span></header><div className="analytics-panel-scroll"><PanelState resource={retention} valid={!!cohorts}>{cohorts&&<><RetentionGrid data={cohorts} unit={retentionBasis?.object==='all'?'analysis-identifiers':'accounts'}/><p className="analytics-basis">{location.scope?objectLabel:'含匿名与账户分析标识'}；第N周起仍有活动的占比，点号表示尚未到达该周。{location.scope&&(retentionBasis?.timeZone?'原生周界 · 时区：'+retentionBasis.timeZone+'。':'原生周界，时区未提供；临近周界的值暂不显示。')}{retentionBasis?.componentSourceUrl&&<> <a href={retentionBasis.componentSourceUrl}>分析组件源码</a></>}</p></>}</PanelState></div></section>
   <section className="analytics-panel analytics-panel--business" aria-labelledby="analytics-business-title"><header><div><h2 id="analytics-business-title">主要业务使用</h2><p>已采集公开内容使用 · 事件次数</p></div></header><div className="analytics-panel-scroll"><PanelState resource={business} valid={!!volume}>{volume&&<><BusinessVolumeChart data={volume}/><p className="analytics-basis">发表包括新版本和回复；仅统计已采集且已进入分析引擎的事件。</p></>}</PanelState></div></section>
  </div>
 </section>;
}
