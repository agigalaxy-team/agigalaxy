'use client';

import {useId} from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {AdminChartLoading,AdminChartSurface} from '../AdminChartSurface';
import {AdminIcon,type AdminIconName} from '../AdminIcons';

const WorkbenchActivityPlot=dynamic(()=>import('./WorkbenchActivityPlot').then(module=>module.WorkbenchActivityPlot),{ssr:true,loading:AdminChartLoading});

export type WorkbenchMetric={id:string;label:string;value:number|null;displayValue?:string;unit?:string;icon:AdminIconName;href?:string};
export type WorkbenchDailyActivity={date:string;posts:number;replies:number};
export type WorkbenchInventory={id:string;label:string;value:number|null;href:string;icon:AdminIconName;denied?:boolean};

const numberFormat=new Intl.NumberFormat('zh-CN');
export const workbenchNumber=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?numberFormat.format(value):'—';
const shortDate=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date)?date.slice(5).replace('-','.'):date;

export function WorkbenchMetrics({items}:{items:WorkbenchMetric[]}){
  return <dl className="wb-metrics">{items.map(item=><div key={item.id} className={'wb-metric wb-metric--'+item.id}>
    <span className="wb-metric-icon"><AdminIcon name={item.icon} size={23}/></span>
    <div><dt>{item.label}</dt><dd>{item.href?<Link href={item.href} prefetch={false}>{item.displayValue??workbenchNumber(item.value)}</Link>:item.displayValue??workbenchNumber(item.value)}{item.value!==null&&item.unit&&<small>{item.unit}</small>}</dd></div>
  </div>)}</dl>;
}

export function WorkbenchEmpty({title,detail,icon='analytics'}:{title:string;detail?:string;icon?:AdminIconName}){
  return <div className="wb-empty"><span className="wb-empty-icon"><AdminIcon name={icon} size={28}/></span><p>{title}</p>{detail&&<small>{detail}</small>}</div>;
}

export function WorkbenchActivityChart({daily,loading=false,available,basis,denied=false}:{daily:WorkbenchDailyActivity[];loading?:boolean;available:boolean;basis?:string;denied?:boolean}){
  const titleId=useId(),fillId=useId().replace(/:/g,'')+'-activity-fill';
  return <section className="wb-trend" aria-labelledby={titleId}>
    <header className="wb-section-heading"><h2 id={titleId}>公开内容趋势</h2><div className="wb-chart-legend"><span><i className="wb-dot wb-dot--pink"/>帖子</span><span><i className="wb-dot wb-dot--blue"/>回复</span></div></header>
    {denied?<WorkbenchEmpty title="没有公开内容数据的查看权限"/>:loading&&!available?<WorkbenchEmpty title="正在读取业务动态"/>:!available?<WorkbenchEmpty title="业务动态暂时无法取得" detail=""/>:<>
      <div className="wb-chart-unit">首次发表（条）</div>
      <div className="wb-activity-chart" role="img" aria-label={'近'+daily.length+'日公开帖子与回复数量，详细数值见下表'}>
        <AdminChartSurface><WorkbenchActivityPlot daily={daily} fillId={fillId}/></AdminChartSurface>
      </div>
      <div className="wb-chart-table-scroll" tabIndex={0} role="region" aria-label="公开内容每日数量"><table className="wb-chart-table"><thead><tr><th scope="col">日期</th>{daily.map(item=><th scope="col" key={item.date}>{shortDate(item.date)}</th>)}</tr></thead><tbody><tr><th scope="row"><i className="wb-dot wb-dot--pink"/>帖子</th>{daily.map(item=><td key={item.date}>{workbenchNumber(item.posts)}</td>)}</tr><tr><th scope="row"><i className="wb-dot wb-dot--blue"/>回复</th>{daily.map(item=><td key={item.date}>{workbenchNumber(item.replies)}</td>)}</tr></tbody></table></div>
      {basis&&<p className="wb-chart-basis">{basis}</p>}
    </>}
  </section>;
}

export function WorkbenchInventoryChart({items}:{items:WorkbenchInventory[]}){
  const titleId=useId(),maximum=Math.max(...items.map(item=>item.value??0),1);
  return <section className="wb-inventory" aria-labelledby={titleId}><header className="wb-section-heading"><h2 id={titleId}>当前业务存量</h2></header><div className="wb-inventory-bars">{items.map(item=><Link key={item.id} href={item.href} prefetch={false} className={'wb-inventory-column wb-inventory-column--'+item.id}>
    <strong>{workbenchNumber(item.value)}</strong><span className="wb-inventory-track"><span style={{height:item.value===null?'0%':Math.max(0,item.value)/maximum*100+'%'}}/></span><span className="wb-inventory-name"><AdminIcon name={item.icon} size={15}/>{item.label}</span>{item.denied&&<small>无查看权限</small>}
  </Link>)}</div></section>;
}

export function WorkbenchRetention({state}:{state:'not-collected'|'unavailable'|'loading'}){
  return <section className="wb-retention"><header className="wb-section-heading"><h2>用户回访</h2></header><WorkbenchEmpty title={state==='loading'?'正在读取回访数据':state==='not-collected'?'尚无回访数据':'回访数据暂时无法取得'} detail={state==='not-collected'?'使用数据采集尚未接通。':undefined} icon="users"/></section>;
}
