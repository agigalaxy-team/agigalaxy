import {nativeQueryScope} from "../../application/query-scope";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {galaxyQueryKey} from "../../shared/runtime/query-client";
import React,{useEffect,useState} from 'react';
import {Compass,Search} from 'lucide-react';
import {ContentCard} from "../discovery/content-card";
import type {BrowsePage,TaskBrowseItem} from "../discovery/contracts";
import type {createWebRuntime} from "../../runtime.mjs";

type View='open'|'requested'|'participating';
type Props={runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void;needIdentity:()=>void;search?:string};
const views:Record<View,string>={open:'开放任务',requested:'我发布的',participating:'我参与的'};
const locationState=(search=location.search):{view:View;query:string}=>{const p=new URLSearchParams(search),value=p.get('view');return{view:value==='requested'||value==='participating'?value:'open',query:p.get('q')??''};};
export function TaskDirectoryWorkspace(props:Props){
 const queryClient=useQueryClient();
 const [locationValue,setLocationValue]=useState(()=>locationState(props.search)),[visit]=useState(0);
 const connection=props.runtime?.api.snapshot();
 const scope=JSON.stringify([props.runtime?.api.endpoint,props.subjectId,props.connected,connection?.bindingId,connection?.generation,locationValue.view,locationValue.query,visit]);
 const refresh=()=>{void queryClient.invalidateQueries({queryKey:galaxyQueryKey(nativeQueryScope(props.runtime,props.subjectId),'tasks','directory')});};
 function update(value:View,q:string){const p=new URLSearchParams();if(value!=='open')p.set('view',value);if(q)p.set('q',q);props.navigate('/app/participate'+(p.size?'?'+p.toString():''));setLocationValue({view:value,query:q});refresh();}
 useEffect(()=>{setLocationValue(locationState(props.search));},[props.search]);
 return <TaskDirectoryRead key={scope} {...props} {...locationValue} update={update} refresh={refresh}/>;
}
function TaskDirectoryRead({runtime,subjectId,connected,navigate,needIdentity,view,query,update,refresh}:Props&{view:View;query:string;update:(view:View,query:string)=>void;refresh:()=>void}){
 const inputKey='galaxy-task-search:'+JSON.stringify([runtime?.api.endpoint,subjectId??'anonymous',view]);
 const [draft,setDraft]=useState(()=>{
  try{const saved:unknown=JSON.parse(sessionStorage.getItem(inputKey)??'null');return saved&&typeof saved==='object'&&'query' in saved&&saved.query===query&&'input' in saved&&typeof saved.input==='string'?saved.input:query;}catch{return query;}
 });
 const canRead=!!runtime&&(view==='open'||connected)&&nativeQueryScope(runtime,subjectId).identity!=='unavailable';
 const [pages,setPages]=useState(1);
 function remember(input:string,executed=query){try{sessionStorage.setItem(inputKey,JSON.stringify({query:executed,input}));}catch{}}
 const read=useQuery({queryKey:galaxyQueryKey(nativeQueryScope(runtime,subjectId),'tasks','directory',view,query,pages,runtime?.api.snapshot()?.bindingId,runtime?.api.snapshot()?.generation),enabled:canRead,queryFn:async({signal})=>{
  let after:string|undefined;const rows:TaskBrowseItem[]=[];
  for(let page=0;page<pages;page++){
   const value:BrowsePage<TaskBrowseItem>=await runtime!.api.call('/v2/tasks/query',{view,query,limit:12,...(after?{after}:{})},{signal,authenticated:view!=='open'});
   for(const item of value.items)if(!rows.some(known=>known.taskId===item.taskId))rows.push(item);
   after=value.nextAfter??undefined;if(!after)break;
  }
  return {items:rows,nextAfter:after??null};
 }});
 const items=read.data?.items??[],next=read.data?.nextAfter??null,busy=read.isFetching,loaded=read.isSuccess||read.isError;
 const error=read.error?'暂时无法读取任务，连接恢复后可以重试。':'';
 return <section className="directory-page" aria-busy={busy}><header className="directory-heading"><div><h1 className="small">任务</h1><p className="lead">看看大家正在做什么。</p></div><a href="/app/publish" onClick={e=>{e.preventDefault();navigate('/app/publish');}}>发起求助 </a></header>
 <nav className="directory-tabs" aria-label="任务范围">{(Object.keys(views) as View[]).map(value=><a key={value} href={value==='open'?'/app/participate':'/app/participate?view='+value} aria-current={view===value?'page':undefined} onClick={e=>{e.preventDefault();update(value,'');}}>{views[value]}</a>)}</nav>
 {!connected&&view!=='open'?<div className="directory-empty"><Compass size={30}/><h2>继续自己的工作</h2><p>连接身份，查看你的任务与参与记录。</p><button className="primary-action" onClick={needIdentity}>连接身份 </button></div>:<>
 <div className="directory-toolbar"><form onSubmit={e=>{e.preventDefault();const q=draft.trim();remember(q,q);if(query===q)refresh();else update(view,q);}}><Search size={18}/><input aria-label="搜索当前范围任务" value={draft} maxLength={200} onChange={e=>{setDraft(e.target.value);remember(e.target.value);}} placeholder="搜索任务" /><button disabled={!canRead||busy}>搜索</button></form></div>
 {error&&<div className="message error" role="alert">{error}<button disabled={busy} onClick={()=>refresh()}>再试一次</button></div>}
 {(!runtime||busy&&!loaded)&&<p><output>正在读取任务…</output></p>}
 <div className="content-grid">{items.map(item=><ContentCard key={item.taskId} kind="tasks" item={item} navigate={navigate} runtime={runtime}/>)}</div>
 {loaded&&!busy&&!error&&!items.length&&<div className="directory-empty"><Compass size={30}/><h2>{query?'没有找到相关任务':view==='open'?'还没有开放的任务':view==='requested'?'你还没有发布任务':'还没有参与记录'}</h2><p>{query?'换个关键词试试。':view==='participating'?'看看有没有你感兴趣的任务。':'可以从你想完成的一件事开始。'}</p>{query?<button onClick={()=>{remember('','');update(view,'');}}>清除搜索</button>:<a href={view==='participating'?'/app/participate':'/app/publish'} onClick={e=>{e.preventDefault();if(view==='participating')update('open','');else navigate('/app/publish');}}>{view==='participating'?'浏览开放任务':'发起求助'} </a>}</div>}
 {next&&<button className="load-more" disabled={busy} onClick={()=>{setPages(value=>value+1);}}>{busy?'正在读取…':'更多任务'}</button>}</>}
 </section>;
}
