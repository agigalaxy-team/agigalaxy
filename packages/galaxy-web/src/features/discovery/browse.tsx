import {useQuery} from "@tanstack/react-query";
import {galaxyQueryKey} from "../../shared/runtime/query-client";
import React,{useEffect,useState} from "react";
import {PublicRecommendations} from "../public-reading/native-content";
import {BookOpen,Layers,MessagesSquare,Search,UsersRound} from "lucide-react";
import {discoveryTarget} from "./navigation";
import "./home.css";
import {CommunityHighlights} from "../community-forum/community-highlights";
import {directories} from "./contracts";
import type {Props,Kind,TaskBrowseItem,CapsuleBrowseItem,ProjectBrowseItem,BrowsePage,ContentEntry} from "./contracts";
import {contentKey,BrowseHighlight} from "./content-card";

function BrowseSection({runtime,navigate,kind}:Props&{kind:Kind}){
 const [attempt,setAttempt]=useState(0);
 return <BrowseSectionRead key={JSON.stringify([runtime?.api.endpoint,kind,attempt])} runtime={runtime} navigate={navigate} kind={kind} retry={()=>setAttempt(value=>value+1)}/>;
}
async function readHighlights(runtime:NonNullable<Props['runtime']>,kind:Kind,signal?:AbortSignal):Promise<BrowsePage<ContentEntry>>{
 const endpoint=directories[kind].endpoint,options={query:'',limit:3};
 if(kind==='tasks'){const page:BrowsePage<TaskBrowseItem>=await runtime.api.call(endpoint,{...options,view:'open'},{authenticated:false,signal});return{items:page.items.map(item=>({kind,item})),nextAfter:page.nextAfter};}
 if(kind==='capsules'){const page:BrowsePage<CapsuleBrowseItem>=await runtime.api.call(endpoint,options,{authenticated:false,signal});return{items:page.items.map(item=>({kind,item})),nextAfter:page.nextAfter};}
 const page:BrowsePage<ProjectBrowseItem>=await runtime.api.call(endpoint,options,{authenticated:false,signal});return{items:page.items.map(item=>({kind,item})),nextAfter:page.nextAfter};
}
function BrowseSectionRead({runtime,navigate,kind}:Props&{kind:Kind;retry:()=>void}){
 const d=directories[kind];
 const read=useQuery({queryKey:galaxyQueryKey({endpoint:runtime?.api.endpoint??'',identity:'anonymous',surface:'web'},kind,'highlights'),enabled:!!runtime,queryFn:({signal})=>readHighlights(runtime!,kind,signal)});
 const items=read.data?.items??[],hasMore=!!read.data?.nextAfter,state=read.isError?'error':read.isPending?'loading':'ready';
 const emptyText=kind==='tasks'?'当前还没有公开的求助。':kind==='capsules'?'当前还没有公开的方法。':'当前还没有可浏览的公开项目。';
 return <section className={'browse-section browse-section-'+kind} aria-labelledby={'browse-'+kind}><header><div><h2 id={'browse-'+kind}>{d.title}</h2><p>{d.subtitle}</p></div><a href={d.path} onClick={event=>{event.preventDefault();navigate(d.path);}}>查看全部 </a></header>
  {state==='loading'?<div className="browse-loading"><output>正在读取公开内容…</output></div>:state==='error'?<div className="browse-empty"><p>暂时无法读取这部分内容。</p><button onClick={()=>void read.refetch()}>重新读取</button></div>:items.length?<div className={'browse-highlights browse-highlights-'+kind}>{items.map(entry=><BrowseHighlight key={contentKey(entry)} {...entry} navigate={navigate} runtime={runtime}/>)}</div>:<div className="browse-empty"><p>{hasMore?'这一范围暂未发现可浏览内容。':emptyText}</p>{kind==='tasks'?<a href="/app/publish" onClick={event=>{event.preventDefault();navigate('/app/publish');}}>发起自己的求助 </a>:<a href={kind==='projects'?'/app/match':'/app/search'} onClick={event=>{event.preventDefault();navigate(kind==='projects'?'/app/match':'/app/search');}}>{kind==='projects'?'按方向寻找同行':'查找其他经验'} </a>}</div>}
 </section>;
}
export function PublicBrowseWorkspace({runtime,navigate}:Props){
 const [query,setQuery]=useState(()=>{try{return sessionStorage.getItem('galaxy-discovery-query')??'';}catch{return '';}});
 const requestedQuery=new URLSearchParams(location.search).get('q');
 useEffect(()=>{if(requestedQuery?.trim())navigate(discoveryTarget('/app/find',requestedQuery));},[requestedQuery,navigate]);
 const go=(event:React.MouseEvent<HTMLAnchorElement>,target:string)=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(target);}};
 if(requestedQuery?.trim())return <output className="reading-status">正在打开这次查找…</output>;
 const peopleTarget=discoveryTarget('/app/match',query);
 return <section className="explore-page">
  <header className="explore-intro"><p className="eyebrow">从感兴趣的事开始</p><h1>发现内容，也发现同行。</h1><p>找一份可借鉴的经验，认识同路的人，或继续一件具体的事。</p>
   <search><form className="explore-search" onSubmit={event=>{event.preventDefault();navigate(discoveryTarget('/app/find',query));}}><label className="sr-only" htmlFor="explore-query">查找银河内容</label><Search size={20}/><input id="explore-query" type="search" maxLength={160} placeholder="搜索讨论、做法、项目或求助" value={query} onChange={event=>{setQuery(event.target.value);try{sessionStorage.setItem('galaxy-discovery-query',event.target.value);}catch{/* Typing remains available without browser storage. */}}}/><button type="submit">查找内容 </button></form></search>
   <div className="explore-next"><span>想从人开始？</span><a href={peopleTarget} onClick={event=>go(event,peopleTarget)}>寻找同行与项目 </a></div>
  </header>
  <nav className="explore-places" aria-label="浏览内容类别">{([['/app/community','社区讨论',MessagesSquare],['/app/capsules','方法与经验',BookOpen],['/app/participate','正在找帮助',UsersRound],['/app/projects','项目与模块',Layers]] as const).map(([target,title,Icon])=><a key={target} href={target} onClick={event=>go(event,target)}><Icon size={19}/>{title}</a>)}</nav>
  <div className="explore-content"><CommunityHighlights {...{runtime,navigate}}/><BrowseSection {...{runtime,navigate}} kind="capsules"/></div>
  {runtime&&<PublicRecommendations endpoint={runtime.api.endpoint} navigate={navigate}/>}
  <BrowseSection {...{runtime,navigate}} kind="projects"/>
  <BrowseSection {...{runtime,navigate}} kind="tasks"/>
  <aside className="explore-continue"><div><h2>带着自己的问题来，也可以。</h2><p>利用已有的背景找帮助，收到回应后继续交流和工作。</p></div><a href="/app/publish" onClick={event=>go(event,'/app/publish')}>发起求助 </a></aside>
  <nav className="explore-reading-links" aria-label="了解银河"><a href="/how-it-works/">怎样使用银河 </a><a href="/downloads/">在自己的 AI 中继续 </a><a href="/privacy/">资料与隐私 </a></nav>
 </section>;
}

// Existing type-only consumer; implementation and canonical contracts are not duplicated.
export type {TaskBrowseItem} from './contracts';
