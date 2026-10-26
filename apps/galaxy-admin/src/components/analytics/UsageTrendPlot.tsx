'use client';

import {Area,AreaChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import type {AnalyticsSeriesPoint} from "./analytics-types";
import {analyticsDate,analyticsNumber} from "../../lib/analytics/analytics-view-model";

export function UsageTrendPlot({data,gradientId:id}:{data:readonly AnalyticsSeriesPoint[];gradientId:string}){
 return <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{width:640,height:230}}>
    <AreaChart data={[...data]} margin={{top:12,right:12,bottom:0,left:0}} accessibilityLayer>
     <defs><linearGradient id={'usage-'+id} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#5487d9" stopOpacity={.14}/><stop offset="100%" stopColor="#5487d9" stopOpacity={.01}/></linearGradient></defs>
     <CartesianGrid stroke="#e9edf4" vertical={false}/>
     <XAxis dataKey="date" tickFormatter={value=>analyticsDate(value)} axisLine={false} tickLine={false} minTickGap={24} tick={{fill:'#758099',fontSize:11}}/>
     <YAxis axisLine={false} tickLine={false} allowDecimals={false} width={42} tick={{fill:'#758099',fontSize:11}}/>
     <Tooltip isAnimationActive={false} labelFormatter={label=>analyticsDate(String(label),true)} formatter={(value,name)=>[analyticsNumber(value),String(name??'')]} contentStyle={{border:'1px solid #e6eaf1',borderRadius:8,fontSize:12}}/>
     <Area type="linear" dataKey="total_screen_views" name="页面浏览" stroke="#5487d9" strokeWidth={2} fill={'url(#usage-'+id+')'} connectNulls={false} isAnimationActive={false} activeDot={{r:4}}/>
     <Area type="linear" dataKey="unique_visitors" name="去重访客" stroke="#df4f8a" strokeWidth={2} fill="transparent" connectNulls={false} isAnimationActive={false} activeDot={{r:4}}/>
     <Area type="linear" dataKey="total_sessions" name="会话" stroke="#8f76c6" strokeWidth={1.7} strokeDasharray="4 3" fill="transparent" connectNulls={false} isAnimationActive={false} activeDot={{r:4}}/>
    </AreaChart>
   </ResponsiveContainer>;
}
