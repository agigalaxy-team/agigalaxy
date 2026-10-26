'use client';

import {useId} from 'react';
import dynamic from 'next/dynamic';
import type {AnalyticsSeriesPoint} from "./analytics-types";
import {analyticsDate,analyticsNumber} from "../../lib/analytics/analytics-view-model";
import {AdminChartLoading,AdminChartSurface} from '../AdminChartSurface';
import './analytics-charts.css';

const UsageTrendPlot=dynamic(()=>import('./UsageTrendPlot').then(module=>module.UsageTrendPlot),{ssr:true,loading:AdminChartLoading});

export function UsageTrendChart({data,compact=false}:{data:readonly AnalyticsSeriesPoint[];compact?:boolean}){
 const id=useId().replace(/:/g,'');
 if(!data.length||!data.some(row=>row.total_screen_views!==null||row.unique_visitors!==null||row.total_sessions!==null))return <div className="analytics-chart-empty">暂无访问趋势</div>;
 return <div className={'analytics-trend'+(compact?' analytics-trend--compact':'')}>
  <div className="analytics-chart-caption"><span>每日数量</span><div className="analytics-chart-legend"><span><i style={{background:'#5487d9'}}/>页面浏览</span><span><i style={{background:'#df4f8a'}}/>去重访客</span><span><i style={{background:'#8f76c6'}}/>会话</span></div></div>
  <div className="analytics-trend-canvas" role="img" aria-label="每日页面浏览、去重访客与会话趋势，详细数值见表格">
   <AdminChartSurface><UsageTrendPlot data={data} gradientId={id}/></AdminChartSurface>
  </div>
  <div className="analytics-chart-table-scroll" tabIndex={0} role="region" aria-label="每日访问数值"><table className="analytics-chart-table"><thead><tr><th scope="col">日期</th>{data.map(row=><th key={row.date} scope="col">{analyticsDate(row.date)}</th>)}</tr></thead><tbody>{([['total_screen_views','页面浏览'],['unique_visitors','去重访客'],['total_sessions','会话']] as const).map(([key,label])=><tr key={key}><th scope="row">{label}</th>{data.map(row=><td key={row.date}>{analyticsNumber(row[key])}</td>)}</tr>)}</tbody></table></div>
 </div>;
}

