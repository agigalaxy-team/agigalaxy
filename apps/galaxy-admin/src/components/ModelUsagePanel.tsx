'use client';

import {useMemo,useState} from 'react';
import type {ModelSettingsUsage} from './model-settings-types';
import {AdminIcon} from './AdminIcons';
import {AdminTabs} from './AdminTabs';
import {modelUsageCallLabels,modelUsageCallSegments,modelUsageCoverage,modelUsageNumber,modelUsageRows,modelUsageTokenLabels} from '../lib/model-usage-view-model';
import './model-usage.css';

export function ModelUsagePanel({value,modelNames}:{value:ModelSettingsUsage|null;modelNames:Readonly<Record<string,string>>}){
 const [group,setGroup]=useState<'scenario'|'model'>('scenario');
 const rows=useMemo(()=>value?.availability.state==='available'?modelUsageRows(value,group,modelNames):[],[value,group,modelNames]);
 if(!value)return <section className="galaxy-model-usage"><p className="model-usage-empty">尚未取得用量记录</p></section>;
 const available=value.availability.state==='available',coverage=modelUsageCoverage(value),segments=available?modelUsageCallSegments(value.calls):null;
 return <section className="galaxy-model-usage" aria-label="模型基础用量">
  <header className="model-usage-heading"><h2>基础用量</h2><span>{available?'调用账本':'用量暂不可读取'}</span></header>
  <div className="model-usage-coverage"><span>{coverage.range} · 上海时间</span>{available&&(coverage.complete===true?<span>完整覆盖所选{value.days}天</span>:<span>{coverage.start?'开始记录于 '+coverage.start:'记录起点尚未取得'}，{coverage.complete===false?'尚未覆盖完整'+value.days+'天':'覆盖完整情况未取得'}</span>)}</div>
  <dl className="model-usage-calls" aria-label="模型调用统计">{(['total','completed','failed','unknown'] as const).map((key,index)=><div key={key}><span className={'model-usage-icon model-usage-icon--'+key}><AdminIcon name={(['activity','check','warning','clock'] as const)[index]} size={19}/></span><div><dt>{modelUsageCallLabels[key]}</dt><dd>{modelUsageNumber(available?value.calls[key]:null)}{available&&value.calls[key]!==null&&<small>次</small>}</dd></div></div>)}</dl>
  {segments&&<div className="model-usage-distribution" role="img" aria-label={segments.map(row=>row.label+' '+modelUsageNumber(row.value)+' 次').join('；')}><div aria-hidden="true">{segments.filter(row=>row.value>0).map(row=><i key={row.key} className={'model-usage-segment--'+row.key} style={{width:row.percent+'%'}}/>)}</div><p>{segments.map(row=><span key={row.key}><i className={'model-usage-segment--'+row.key}/>{row.label} {modelUsageNumber(row.value)}</span>)}</p></div>}
  <section className="model-usage-tokens" aria-label="已报告模型Token"><div className="model-usage-section-heading"><h3>已报告 Token</h3><span>{available&&value.unknownUsageCalls!==null?value.unknownUsageCalls>0?modelUsageNumber(value.unknownUsageCalls)+' 次调用未完整报告用量':'输入、输出与总量均有记录':'用量完整情况未取得'}</span></div><dl>{(['input','output','cachedInput','reasoning','total'] as const).map(key=><div key={key}><dt>{modelUsageTokenLabels[key]}</dt><dd>{modelUsageNumber(available?value.tokens[key]:null)}</dd></div>)}</dl>{available&&value.unknownUsageCalls!==null&&value.unknownUsageCalls>0&&<p className="model-usage-note">数值为已有回执合计，缺少的用量保持未知。</p>}</section>
  <section className="model-usage-groups"><div className="model-usage-section-heading"><h3>基础汇总</h3><AdminTabs items={[{id:'scenario',label:'按领域'},{id:'model',label:'按模型'}]} active={group} onChange={value=>setGroup(value as 'scenario'|'model')} ariaLabel="用量汇总维度" className="model-usage-group-tabs"/></div><div className="model-usage-table-scroll" role="region" tabIndex={0} aria-label={group==='scenario'?'各领域基础用量':'各模型基础用量'}><table><thead><tr><th>{group==='scenario'?'领域':'模型'}</th><th>调用</th><th>完成</th><th>失败</th><th>结果未知</th><th>输入／输出 Token</th><th>缓存／思考 Token</th><th>总 Token</th><th>用量缺失调用</th></tr></thead><tbody>{rows.map(row=><tr key={row.key}><th scope="row">{row.label}{group==='model'&&row.label==='模型名称未记录'&&<small title={row.key}>{row.key.slice(0,8)}</small>}</th><td>{modelUsageNumber(row.calls.total)}</td><td>{modelUsageNumber(row.calls.completed)}</td><td>{modelUsageNumber(row.calls.failed)}</td><td>{modelUsageNumber(row.calls.unknown)}</td><td><span>输入 {modelUsageNumber(row.tokens.input)}</span><span>输出 {modelUsageNumber(row.tokens.output)}</span></td><td><span>缓存 {modelUsageNumber(row.tokens.cachedInput)}</span><span>思考 {modelUsageNumber(row.tokens.reasoning)}</span></td><td>{modelUsageNumber(row.tokens.total)}</td><td>{modelUsageNumber(row.unknownUsageCalls)}</td></tr>)}</tbody></table>{rows.length===0&&<p className="model-usage-empty">{available?value.calls.total===0?'当前统计范围没有调用记录':'当前没有'+(group==='scenario'?'领域':'模型')+'汇总':'用量账本暂不可读取'}</p>}</div></section>
 </section>;
}
