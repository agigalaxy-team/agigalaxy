'use client';

import type {AnalyticsRetentionData} from '../analytics-types';
import {useClientReady} from '../../lib/use-client-ready';
import {analyticsDate,analyticsNumber,analyticsPercent} from '../../lib/analytics-view-model';
import './analytics-charts.css';

export function AnalyticsDaysControl({days,onChange,disabled=false}:{days:number;onChange:(days:number)=>void;disabled?:boolean}){
 const ready=useClientReady();
 const values=[7,30,90];if(!values.includes(days))values.push(days);values.sort((a,b)=>a-b);
 return <label className="analytics-days-control">统计范围<select value={days} disabled={!ready||disabled} onChange={event=>onChange(Number(event.target.value))}>{values.map(value=><option value={value} key={value}>近{value}天</option>)}</select></label>;
}

export function AnalyticsObjectControl({value,hasAccount,onChange}:{value:'all'|'accounts'|'account';hasAccount:boolean;onChange:(value:'all'|'accounts'|'account')=>void}){
 const ready=useClientReady();
 return <label className="analytics-object-control">路径与留存对象<select value={value} disabled={!ready} onChange={event=>{const next=event.target.value;if(next==='all'||next==='accounts'||next==='account')onChange(next);}}><option value="all">全部访问</option><option value="accounts">登录账户</option>{hasAccount&&<option value="account">此账户</option>}</select></label>;
}

export function RetentionGrid({data,compact=false,unit='analysis-identifiers'}:{data:AnalyticsRetentionData;compact?:boolean;unit?:'accounts'|'analysis-identifiers'}){
 const rows=compact?data.rows.filter(row=>!row.average).slice(-4):data.rows;
 const weeks=compact?data.weeks.slice(0,4):data.weeks;
 if(!rows.length||rows.every(row=>row.size===0))return <div className="analytics-chart-empty">暂无使用留存样本</div>;
 if(!rows.some(row=>row.size!==null&&row.size>0))return <div className="analytics-chart-empty">留存样本规模尚未取得</div>;
 return <div className={'analytics-retention-scroll'+(compact?' analytics-retention-scroll--compact':'')} tabIndex={0} role="region" aria-label={unit==='accounts'?'近12周账户使用留存表':'近12周使用留存表'}><table className="analytics-retention-table"><thead><tr><th scope="col">首次活动周</th><th scope="col">{compact?'规模':unit==='accounts'?'账户数':'群组规模'}</th>{weeks.map(week=><th scope="col" key={week}>第{week}周{week>0?'起':''}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.cohort} className={row.average?'analytics-retention-average':undefined}><th scope="row">{row.average?'加权平均':analyticsDate(row.cohort)}{!compact&&row.average&&<small>代表性平均规模</small>}</th><td>{analyticsNumber(row.size)}</td>{weeks.map(week=>{const cell=row.cells.find(item=>item.week===week),ratio=cell?.ratio??null;return <td key={week} className={cell?.state==='not-reached'?'analytics-retention-future':undefined} style={ratio===null?undefined:{backgroundColor:'rgba(223,79,138,'+(.06+ratio*.47)+')'}} title={cell?.state==='not-reached'?'尚未到达该周':cell?.state==='recorded'?'留存 '+analyticsPercent(ratio,'ratio')+' · '+analyticsNumber(cell.count)+(row.average?'（代表性规模）':unit==='accounts'?' 个账户':' 个分析标识'):'未记录'}>{cell?.state==='not-reached'?<span className="analytics-retention-unreached" aria-label="尚未到达">·</span>:analyticsPercent(ratio,'ratio')}</td>;})}</tr>)}</tbody></table></div>;
}

