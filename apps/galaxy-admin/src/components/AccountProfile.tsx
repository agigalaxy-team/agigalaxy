'use client';

import type {ReactNode} from 'react';
import type {AccountSummary,ActivityDay,SummaryDays,SummaryTopic} from '../lib/account-summary';
import {countLabel,dateTime,periodLabel,shortDate} from '../lib/account-summary';
import {AdminIcon} from './AdminIcons';
import './account-topic-analysis.css';

type Props={summary:AccountSummary|null;days:SummaryDays;loading:boolean;error:string;onRetry:()=>void;usageAnalysis?:ReactNode};

function MetricIcon({name}:{name:'days'|'search'|'bookmark'|'contribution'}){
  const names={days:'calendar',search:'search',bookmark:'bookmark',contribution:'comment'} as const;
  return <AdminIcon name={names[name]} size={25}/>;
}

export function AccountActivityChart({items,compact=false}:{items:ActivityDay[];compact?:boolean}){
  const known=items.filter(item=>item.count!==null),maximum=Math.max(1,...known.map(item=>item.count??0));
  if(!known.length)return <div className={'galaxy-account-chart-empty'+(compact?' is-compact':'')}><p>尚未取得公开参与统计</p></div>;
  return <figure className={'galaxy-account-activity-chart'+(compact?' is-compact':'')}>
    <div className="galaxy-account-chart-scale" aria-hidden="true"><span>{countLabel(maximum)}</span><span>{countLabel(Math.round(maximum/2))}</span><span>0</span></div>
    <ol className="galaxy-account-chart-bars" style={{gridTemplateColumns:`repeat(${items.length}, minmax(0, 1fr))`}}>
      {items.map((item,index)=><li key={item.date} aria-label={`${shortDate(item.date)}，${item.count===null?'未取得统计':countLabel(item.count)+' 条'}`} title={`${shortDate(item.date)} · ${item.count===null?'未取得统计':countLabel(item.count)+' 条'}`}>
        <div className="galaxy-account-bar-area"><span className="galaxy-account-bar-value" style={{bottom:`calc(${((item.count??0)/maximum)*100}% + 3px)`}}>{item.count===null?'':countLabel(item.count)}</span>{item.count!==null&&<span className={'galaxy-account-bar'+(item.count===0?' is-zero':'')} style={{height:`${Math.max(item.count>0?2:0,(item.count/maximum)*100)}%`}}/>}{item.count===null&&<span className="galaxy-account-bar-missing"/>}</div>
        <span className="galaxy-account-bar-date" aria-hidden="true">{items.length<=7||index%4===0||index===items.length-1?shortDate(item.date):''}</span>
      </li>)}
    </ol>
    <figcaption className="galaxy-account-sr-only">按首次发表日期统计当前仍公开可读的帖子与回复；空缺日期未取得统计。</figcaption>
  </figure>;
}

const sourceLabels:Record<string,string>={'public-content-use':'公开内容使用','public-authoring':'公开发言','public-search':'站内搜索','gorse-returned-candidates':'推荐候选记录','recommendation-attribution':'推荐后续使用'};
const interestSignals={views:'阅读',clicks:'点击',bookmarks:'收藏',participations:'参与',publicPosts:'公开发帖',publicReplies:'公开回复',searches:'搜索',notInterested:'不感兴趣'};
const recommendationSignals={returnedCandidates:'候选返回',exposures:'实际曝光',clicks:'点击',bookmarks:'收藏',participations:'参与',notInterested:'不感兴趣'};
function sources(values:string[]|undefined){return[...new Set((values??[]).map(value=>sourceLabels[value]).filter(Boolean))].join('、');}
function analysisEmpty(state:AccountSummary['profile']['state']|AccountSummary['recommendations']['state']|undefined,kind:'interest'|'need'|'recommendation'){
 if(state==='unavailable')return '这部分分析暂时无法读取。';
 if(state==='not-connected')return '这部分分析来源尚未接通。';
 if(state==='not-authorized')return '当前没有查看这部分分析的权限。';
 if(state==='partial')return '当前可核对的记录尚不足以归类，部分来源暂未取得。';
 if(state==='empty')return kind==='recommendation'?'当前窗口没有可归类的推荐记录。':kind==='need'?'当前窗口没有可归类的检索主题。':'当前窗口没有可归类的公开主题线索。';
 return kind==='recommendation'?'尚未形成推荐类目':kind==='need'?'尚未形成需求汇总':'尚未形成兴趣汇总';
}
function Topics({items,empty,recommendation=false}:{items:SummaryTopic[];empty:string;recommendation?:boolean}){
  return items.length?<ul className="galaxy-account-topics">{items.map((item,index)=>{
   const counts:Readonly<Record<string,number|null|undefined>>|undefined=recommendation?item.counts:item.signalCounts;
   const labels=recommendation?recommendationSignals:interestSignals;
   const entries=Object.entries(labels).filter(([key])=>recommendation||typeof counts?.[key]==='number'&&(counts[key]??0)>0);
   return <li key={item.key??item.label+index}><strong>{item.label}</strong>{item.summary&&<p>{item.summary}</p>}
    {counts&&entries.length>0&&<dl className="galaxy-account-topic-counts">{entries.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{countLabel(counts[key])}<small>{counts[key]==null?'':key==='returnedCandidates'?'项':'次'}</small></dd></div>)}</dl>}
    {(item.firstObservedAt||item.lastObservedAt)&&<p className="galaxy-account-topic-observed">观察时间 {dateTime(item.firstObservedAt||item.lastObservedAt)}{item.firstObservedAt&&item.lastObservedAt&&item.lastObservedAt!==item.firstObservedAt?' — '+dateTime(item.lastObservedAt):''}</p>}
    {sources(item.sourceTypes)&&<p className="galaxy-account-topic-source">来源：{sources(item.sourceTypes)}</p>}
   </li>;
  })}</ul>:<p className="galaxy-account-empty-copy">{empty}</p>;
}

function Prediction({title,value}:{title:string;value:AccountSummary['predictions']['needs']|undefined}){
  return <div className="galaxy-account-prediction"><span>{title}</span><div><strong>{value?.state==='available'&&value.label?value.label:value?.state==='insufficient-data'?'样本不足':'暂无分析'}</strong>{value?.summary&&<p>{value.summary}</p>}</div></div>;
}

export function AccountProfile({summary,days,loading,error,onRetry,usageAnalysis}:Props){
  if(!summary)return <div className="galaxy-account-profile" aria-busy={loading}><div className="galaxy-account-profile-main"><section className="galaxy-account-panel">
    <header><h2>画像与使用</h2></header>
    {error?<div className="galaxy-error" role="alert">{error}<button type="button" onClick={onRetry} disabled={loading}>重新读取</button></div>:<p className="galaxy-account-read-status" role="status">{loading?'正在读取画像与使用数据…':'尚未取得画像与使用数据。'}</p>}
  </section></div></div>;
  const facts=[
    {key:'days' as const,label:'活跃',value:summary?.usage.activeDays,unit:'天'},
    {key:'search' as const,label:'搜索',value:summary?.usage.searches,unit:'次'},
    {key:'bookmark' as const,label:'收藏',value:summary?.usage.bookmarks,unit:'项'},
    {key:'contribution' as const,label:'公开发言',value:summary?.usage.publicContributions,unit:'条'},
  ];
  return <div className="galaxy-account-profile" aria-busy={loading}>
    <div className="galaxy-account-profile-main">
      {error&&<div className="galaxy-error" role="alert">{error}<button type="button" onClick={onRetry} disabled={loading}>重新读取</button></div>}
      {usageAnalysis}
      <section className="galaxy-account-panel galaxy-account-usage"><header><h2>使用事实</h2><span>近{days}天 {periodLabel(summary?.period)}</span></header><dl className="galaxy-account-usage-metrics">{facts.map(item=><div key={item.key}><MetricIcon name={item.key}/><dt>{item.label}</dt><dd>{countLabel(item.value)}<small>{item.value==null?'':item.unit}</small></dd></div>)}</dl></section>
      <section className="galaxy-account-panel"><header><h2>近{days}天公开参与</h2><span>公开帖子与回复 · 条</span></header><AccountActivityChart items={summary?.usage.dailyActivity??[]}/><p className="galaxy-account-chart-basis">按首次发表日期统计当前公开内容</p></section>
      <div className="galaxy-account-analysis-grid">
        <section className="galaxy-account-panel"><header><h2>公开主题与近期需求</h2><span className="galaxy-account-inference">行为线索</span></header><div className="galaxy-account-topic-group"><h3>近期检索主题</h3><Topics items={summary?.profile.needs??[]} empty={analysisEmpty(summary?.profile.state,'need')}/></div><div className="galaxy-account-topic-group"><h3>当前窗口关注</h3><Topics items={summary?.profile.interests??[]} empty={analysisEmpty(summary?.profile.state,'interest')}/></div>{summary?.profile.state==='partial'&&(summary.profile.needs.length>0||summary.profile.interests.length>0)&&<p className="galaxy-account-analysis-source">部分来源暂未取得；这里只显示已核对的线索。</p>}{sources(summary?.profile.sourceTypes)&&<p className="galaxy-account-analysis-source">来源：{sources(summary?.profile.sourceTypes)}</p>}</section>
        <section className="galaxy-account-panel"><header><h2>预测</h2></header><Prediction title="参与变化" value={summary?.predictions.participation}/><Prediction title="潜在需求" value={summary?.predictions.needs}/></section>
      </div>
      <section className="galaxy-account-panel"><header><h2>推荐类目</h2><span>近{days}天</span></header><Topics items={summary?.recommendations.categories??[]} recommendation empty={analysisEmpty(summary?.recommendations.state,'recommendation')}/>{!!summary?.recommendations.categories.length&&<p className="galaxy-account-analysis-source">候选返回与实际曝光分别统计，表示已记录的推荐过程。</p>}{summary?.recommendations.state==='partial'&&<p className="galaxy-account-analysis-source">部分来源暂未取得，当前统计可能不完整。</p>}</section>
    </div>
    <aside className="galaxy-account-profile-aside">
      <section className="galaxy-account-panel"><h2>近期使用</h2><dl className="galaxy-account-facts"><dt>最近公开参与</dt><dd>{summary.usage.publicActivityState!=='available'?'尚未取得':summary.usage.lastActivityAt?dateTime(summary.usage.lastActivityAt):'当前窗口无公开参与'}</dd><dt>活跃天数</dt><dd>{summary?.usage.activeDays==null?'未采集':countLabel(summary.usage.activeDays)+' 天'}</dd><dt>统计范围</dt><dd>近{days}天</dd></dl></section>
      <section className="galaxy-account-panel"><h2>分析与更新</h2><dl className="galaxy-account-facts"><dt>主题更新</dt><dd>{summary?.profile.updatedAt?dateTime(summary.profile.updatedAt):'尚未取得'}</dd><dt>分析范围</dt><dd>按当前窗口记录重算</dd><dt>推荐更新</dt><dd>{summary?.recommendations.updatedAt?dateTime(summary.recommendations.updatedAt):'尚未取得'}</dd></dl></section>
    </aside>
  </div>;
}
