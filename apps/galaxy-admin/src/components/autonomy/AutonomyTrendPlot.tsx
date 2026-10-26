'use client';

import {CartesianGrid,Line,LineChart,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {autonomyDate,autonomyNumber} from "../../lib/autonomy/autonomy-view-model";

export type AutonomyChartSeries={key:string;label:string;color:string};
export function AutonomyTrendPlot({points,series}:{points:Record<string,string|number|null>[];series:AutonomyChartSeries[]}){
 return <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{width:600,height:200}}><LineChart data={points} margin={{top:12,right:12,bottom:0,left:0}} accessibilityLayer><CartesianGrid vertical={false} stroke="#e9edf4"/><XAxis dataKey="at" tickFormatter={at=>autonomyDate(String(at),true).slice(0,5)} axisLine={false} tickLine={false} minTickGap={32} tick={{fill:'#748095',fontSize:11}}/><YAxis width={48} axisLine={false} tickLine={false} allowDecimals={false} tick={{fill:'#748095',fontSize:11}}/><Tooltip isAnimationActive={false} labelFormatter={at=>autonomyDate(String(at),true)} formatter={(value,name)=>[autonomyNumber(typeof value==='number'?value:null),String(name??'')]} contentStyle={{fontSize:12,border:'1px solid #e6eaf1',borderRadius:8}}/>{series.map(row=><Line key={row.key} dataKey={row.key} name={row.label} stroke={row.color} strokeWidth={2} type="linear" connectNulls={false} dot={points.length===1?{r:3}:false} activeDot={{r:4}} isAnimationActive={false}/>)}</LineChart></ResponsiveContainer>;
}
