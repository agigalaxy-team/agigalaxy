'use client';

import {Area,AreaChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import type {WorkbenchDailyActivity} from './WorkbenchCharts';

const numberFormat=new Intl.NumberFormat('zh-CN');
const workbenchNumber=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?numberFormat.format(value):'—';
const shortDate=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date)?date.slice(5).replace('-','.'):date;

export function WorkbenchActivityPlot({daily,fillId}:{daily:WorkbenchDailyActivity[];fillId:string}){
 return <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{width:640,height:230}}>
          <AreaChart data={daily} margin={{top:14,right:12,bottom:0,left:0}} accessibilityLayer>
            <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#e84c8c" stopOpacity={.18}/><stop offset="100%" stopColor="#e84c8c" stopOpacity={.02}/></linearGradient></defs>
            <CartesianGrid stroke="#e9edf4" vertical={false}/>
            <XAxis dataKey="date" tickFormatter={shortDate} axisLine={false} tickLine={false} minTickGap={18} tick={{fill:'#79859c',fontSize:11}}/>
            <YAxis axisLine={false} tickLine={false} allowDecimals={false} width={34} domain={[0,(maximum:number)=>Math.max(maximum,4)]} tick={{fill:'#79859c',fontSize:11}}/>
            <Tooltip isAnimationActive={false} labelFormatter={label=>String(label??'')} formatter={(value,name)=>[typeof value==='number'?workbenchNumber(value)+' 条':'—',String(name??'')]} contentStyle={{border:'1px solid #e6eaf1',borderRadius:10,fontSize:12,boxShadow:'0 6px 24px #14203d12'}} cursor={{stroke:'#d3dbe7',strokeDasharray:'3 3'}}/>
            <Area type="monotone" dataKey="replies" name="回复" stroke="#4f8df7" strokeWidth={2} fill="transparent" dot={{r:3,fill:'#4f8df7',strokeWidth:0}} activeDot={{r:5}} isAnimationActive={false}/>
            <Area type="monotone" dataKey="posts" name="帖子" stroke="#e84c8c" strokeWidth={2} fill={'url(#'+fillId+')'} dot={{r:3,fill:'#e84c8c',strokeWidth:0}} activeDot={{r:5}} isAnimationActive={false}/>
          </AreaChart>
        </ResponsiveContainer>;
}
