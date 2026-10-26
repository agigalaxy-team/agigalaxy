'use client';

import {Bar,BarChart,CartesianGrid,ResponsiveContainer,Sankey,Tooltip,XAxis,YAxis} from 'recharts';
import type {SankeyNodeProps} from 'recharts';
import type {AnalyticsBusinessData,AnalyticsBusinessKey,AnalyticsFlowData} from "./analytics-types";
import {analyticsBusinessLabels,analyticsNumber} from "../../lib/analytics/analytics-view-model";
import './analytics-charts.css';

export {AnalyticsDaysControl,AnalyticsObjectControl,RetentionGrid} from './AnalyticsChartPrimitives';
export {UsageTrendChart} from './UsageTrendChart';

function FlowNode({x,y,width,height,payload}:SankeyNodeProps){
 const nativeValue='nativeValue'in payload?payload.nativeValue:null;
 return <g><title>{String(payload.name??'事件')+' · '+analyticsNumber(nativeValue)}</title><rect x={x} y={y} width={width} height={height} fill="#dc77a0" rx={2}/><text x={x+width+6} y={y+Math.max(height/2,5)} fill="#526079" fontSize={10} dominantBaseline="middle">{String(payload.name??'事件')}</text></g>;
}
export function UsageFlowChart({data,unit='session-path-transitions'}:{data:AnalyticsFlowData;unit?:'account-session-path-transitions'|'session-path-transitions'}){
 const byId=new Map(data.nodes.map((row,index)=>[row.id,index])),nodes=data.nodes.map(row=>({name:row.label,...row,nativeValue:row.value})),links=data.links.flatMap(row=>row.value!==null&&row.value>0?[{source:byId.get(row.source)!,target:byId.get(row.target)!,value:row.value}]:[]);
 if(!nodes.length&&!data.links.length)return <div className="analytics-chart-empty">当前范围暂无使用路径</div>;
 return <div className="analytics-flow">{links.length?<div className="analytics-flow-canvas-scroll" tabIndex={0} role="region" aria-label="页面访问后的使用路径图"><div className="analytics-flow-canvas"><ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{width:650,height:240}}><Sankey data={{nodes,links}} node={FlowNode} nodePadding={24} nodeWidth={9} iterations={32} link={{stroke:'#e7a7c1',strokeOpacity:.37}} margin={{top:15,right:115,bottom:15,left:10}}/></ResponsiveContainer></div></div>:<div className="analytics-chart-empty">路径数量尚未取得</div>}<div className="analytics-flow-table-scroll" tabIndex={0} role="region" aria-label={unit==='account-session-path-transitions'?'账户会话路径转移数值':'会话路径转移数值'}><table className="analytics-chart-table"><thead><tr><th scope="col">起始事件</th><th scope="col">后续事件</th><th scope="col">{unit==='account-session-path-transitions'?'账户会话路径转移数':'会话路径转移数'}</th></tr></thead><tbody>{data.links.map((row,index)=><tr key={row.source+':'+row.target+':'+index}><td>第{data.nodes.find(item=>item.id===row.source)?.step}步 · {data.nodes.find(item=>item.id===row.source)?.label}</td><td>第{data.nodes.find(item=>item.id===row.target)?.step}步 · {data.nodes.find(item=>item.id===row.target)?.label}</td><td>{analyticsNumber(row.value)}</td></tr>)}</tbody></table></div></div>;
}

export function BusinessVolumeChart({data}:{data:AnalyticsBusinessData}){
 const rows=(Object.keys(analyticsBusinessLabels) as AnalyticsBusinessKey[]).map(key=>({id:key,name:analyticsBusinessLabels[key],current:data.current[key],previous:data.previous[key]}));
 if(rows.every(row=>row.current===null&&row.previous===null))return <div className="analytics-chart-empty">业务使用次数尚未取得</div>;
 return <div className="analytics-business"><div className="analytics-chart-caption"><span>事件次数</span><div className="analytics-chart-legend"><span><i style={{background:'#5487d9'}}/>本期</span><span><i style={{background:'#b18ad7'}}/>前一等长时段</span></div></div><div className="analytics-business-canvas" role="img" aria-label="本期与前一等长时段阅读、搜索、收藏及发表回复次数，详细数值见下表"><ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{width:570,height:220}}><BarChart data={rows} margin={{top:15,right:10,bottom:0,left:0}} accessibilityLayer><CartesianGrid stroke="#e9edf4" vertical={false}/><XAxis dataKey="name" axisLine={false} tickLine={false} interval={0} tick={{fill:'#758099',fontSize:10}} tickFormatter={value=>String(value).replace('公开内容','')}/><YAxis axisLine={false} tickLine={false} allowDecimals={false} width={42} tick={{fill:'#758099',fontSize:10}}/><Tooltip isAnimationActive={false} formatter={(value,name)=>[analyticsNumber(value)+' 次',String(name??'')]} contentStyle={{border:'1px solid #e6eaf1',borderRadius:7,fontSize:11}} cursor={{fill:'#f8f9fc'}}/><Bar dataKey="current" name="本期" fill="#5487d9" maxBarSize={28} radius={[3,3,0,0]} isAnimationActive={false}/><Bar dataKey="previous" name="前一等长时段" fill="#b18ad7" maxBarSize={28} radius={[3,3,0,0]} isAnimationActive={false}/></BarChart></ResponsiveContainer></div><div className="analytics-chart-table-scroll" tabIndex={0} role="region" aria-label="业务使用次数"><table className="analytics-chart-table"><thead><tr><th scope="col">使用</th>{rows.map(row=><th key={row.id} scope="col">{row.name}</th>)}</tr></thead><tbody><tr><th scope="row">本期</th>{rows.map(row=><td key={row.id}>{analyticsNumber(row.current)}</td>)}</tr><tr><th scope="row">前一等长时段</th>{rows.map(row=><td key={row.id}>{analyticsNumber(row.previous)}</td>)}</tr></tbody></table></div></div>;
}
