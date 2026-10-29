import {useQuery} from "@tanstack/react-query";
import {galaxyQueryKey} from "../../shared/runtime/query-client";
import {forumBodyExcerpt} from "../community-forum/community-forum-browse.mjs";
import React,{useEffect,useState} from 'react';
import {Search} from 'lucide-react';
import {ContentCard} from './content-card';
import type {TaskBrowseItem,CapsuleBrowseItem,ProjectBrowseItem,BrowsePage} from './contracts';
import {availableForumContent,type ForumPostView} from "../community-forum/community-forum-view-types";
import {forumVersionPath} from "../community-forum/community-forum-origin.mjs";
import {forumTopics} from '../../../../galaxy-contracts/src/community-forum-topics-v1.mjs';
import {discoveryTarget} from './navigation';
import {PublicIdentityAccounts,PublicAccountMatch} from "../accounts/public-account-relations";
import {NativeCommunitySearch} from '../public-reading/native-content';
import type {createWebRuntime} from '../../runtime.mjs';
import './content-search.css';

type Runtime=Awaited<ReturnType<typeof createWebRuntime>>;
type Props={runtime:Runtime;navigate:(path:string)=>void;search:string};
type Kind='community'|'capsules'|'projects'|'tasks';
type Content={community:ForumPostView;capsules:CapsuleBrowseItem;projects:ProjectBrowseItem;tasks:TaskBrowseItem};
const kinds:Kind[]=['community','capsules','projects','tasks'];
const directories={
 community:{label:'社区讨论',path:'/app/community',endpoint:'/v2/community/posts/query'},
 capsules:{label:'方法与经验',path:'/app/capsules',endpoint:'/v2/capsules/query'},
 projects:{label:'项目与模块',path:'/app/projects',endpoint:'/v2/projects/directory/query'},
 tasks:{label:'正在找帮助',path:'/app/participate',endpoint:'/v2/tasks/query'},
};
const follow=(event:React.MouseEvent<HTMLAnchorElement>,path:string,navigate:Props['navigate'])=>{
 if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}
};
function directoryPath(kind:Kind,query:string){return directories[kind].path+(query?'?q='+encodeURIComponent(query):'');}

export function ForumSearchRow({item,navigate,clock}:{item:ForumPostView;navigate:Props['navigate'];clock:number}){
 if(!availableForumContent(item,clock))return null;
 const path=forumVersionPath(item.locator.postId,item.locator.versionId??item.currentVersionId)??'/app/community';
 return <article className="content-search-row"><p className="content-search-meta">{forumTopics.find(topic=>topic.id===item.topic)?.label??'未分类'}</p><h3><a href={path} onClick={event=>follow(event,path,navigate)}>{item.payload.title}</a></h3><p className="content-search-excerpt">{forumBodyExcerpt(item.payload.body)}</p></article>;
}
function SearchGroup<K extends Kind>({runtime,navigate,kind,query}:{runtime:Runtime;navigate:Props['navigate'];kind:K;query:string}){
 if(kind==='community')return <NativeCommunitySearch endpoint={runtime.api.endpoint} query={query} navigate={navigate}/>;
 return <ExistingSearchGroup {...{runtime,navigate,kind,query}}/>;
}
function ExistingSearchGroup<K extends Kind>({runtime,navigate,kind,query}:{runtime:Runtime;navigate:Props['navigate'];kind:K;query:string}){
 const [clock,setClock]=useState(()=>Date.now()/1000);
 const read=useQuery<BrowsePage<Content[K]>>({queryKey:galaxyQueryKey({endpoint:runtime.api.endpoint,identity:'anonymous',surface:'web'},kind==='community'?'forum':kind,'search',query),queryFn:({signal})=>runtime.api.call(directories[kind].endpoint,{query,limit:3,...(kind==='tasks'?{view:'open'}:{}),...(kind==='community'?{order:'published'}:{})},{authenticated:false,signal})});
 const page=read.data??null,busy=read.isFetching,error=read.isError;
 const expiry=kind==='community'?Math.min(...(page?.items??[]).flatMap(value=>{const item=value as ForumPostView;return typeof item.publishedUntil==='number'&&item.publishedUntil>clock?[item.publishedUntil]:[];})):Infinity;
 useEffect(()=>{if(!Number.isFinite(expiry))return;const timer=window.setTimeout(()=>setClock(Date.now()/1000),Math.min(2147483647,Math.max(0,expiry*1000-Date.now()+1)));return()=>window.clearTimeout(timer);},[expiry]);
 const items=kind==='community'?(page?.items??[]).filter(value=>availableForumContent(value as ForumPostView,clock)):page?.items??[];
 const target=directoryPath(kind,query);
 return <section className="content-search-group" id={'search-'+kind} aria-labelledby={'search-heading-'+kind} aria-busy={busy}><header><h2 id={'search-heading-'+kind}>{directories[kind].label}</h2><a href={target} onClick={event=>follow(event,target,navigate)}>查看全部</a></header>
  {busy&&!page?<output>正在查找…</output>:error?<output className="content-search-empty">暂时无法读取这部分内容。<button type="button" onClick={()=>{void read.refetch();}}>重试</button></output>:!items.length?<p className="content-search-empty">{page?.nextAfter?'当前读取范围没有可展示的结果，可进入目录继续查找。':'没有找到相符的公开内容。'}</p>:<div className="content-search-results">{items.map(value=>kind==='community'?<ForumSearchRow key={(value as ForumPostView).locator.postId} item={value as ForumPostView} navigate={navigate} clock={clock}/>:kind==='tasks'?<ContentCard key={(value as TaskBrowseItem).taskId} kind="tasks" item={value as TaskBrowseItem} runtime={runtime} navigate={navigate}/>:kind==='capsules'?<ContentCard key={(value as CapsuleBrowseItem).capsuleId} kind="capsules" item={value as CapsuleBrowseItem} navigate={navigate}/>:<ContentCard key={(value as ProjectBrowseItem).projectId} kind="projects" item={value as ProjectBrowseItem} navigate={navigate}/>)}</div>}
 </section>;
}

export function ContentSearchWorkspace({runtime,navigate,search}:Props){
 const query=(new URLSearchParams(search).get('q')??'').trim().slice(0,160),[draft,setDraft]=useState(query);
 const people=discoveryTarget('/app/match',query);
 return <section className="content-search-page"><a className="back-link" href="/app/" onClick={event=>follow(event,'/app/',navigate)}>返回发现</a><header><h1 className="small">查找银河内容</h1><p>从讨论、做法、项目和求助中找回你关心的内容。</p></header>
  <search><form className="explore-search" onSubmit={event=>{event.preventDefault();navigate('/app/find'+(draft.trim()?'?q='+encodeURIComponent(draft.trim()):''));}}><label className="sr-only" htmlFor="galaxy-content-query">查找银河内容</label><Search size={19} aria-hidden/><input id="galaxy-content-query" type="search" maxLength={160} required value={draft} onChange={event=>setDraft(event.target.value)} placeholder="搜索标题、内容或方向"/><button type="submit">查找</button></form></search>
  {/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(query)&&<PublicIdentityAccounts key={query} subjectId={query} endpoint={runtime.api.endpoint} navigate={navigate} showProfileLink/>}
  {/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query)&&<PublicAccountMatch key={query} accountId={query} endpoint={runtime.api.endpoint} navigate={navigate}/>}
  {/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,16}$/.test(query)&&<PublicAccountMatch key={'uid:'+query.toUpperCase()} uid={query} endpoint={runtime.api.endpoint} navigate={navigate}/>}
  {query?<><p className="content-search-current">查找“{query}” <a href="/app/find" onClick={event=>follow(event,'/app/find',navigate)}>清除查找</a></p><nav className="content-search-jump" aria-label="结果类型">{kinds.map(kind=><a key={kind} href={'#search-'+kind}>{directories[kind].label}</a>)}</nav><div className="content-search-sections">{kinds.map(kind=><SearchGroup key={kind+query} runtime={runtime} navigate={navigate} kind={kind} query={query}/>)}</div></>:<div className="content-search-start"><p>输入一个关键词，也可以直接浏览。</p><nav aria-label="浏览内容">{kinds.map(kind=><a key={kind} href={directories[kind].path} onClick={event=>follow(event,directories[kind].path,navigate)}>{directories[kind].label}</a>)}</nav></div>}
  <aside className="content-search-other"><p>想找可以交流的人，或适合当前问题的帮助？</p><a href={people} onClick={event=>follow(event,people,navigate)}>寻找同行与项目</a><a href={discoveryTarget('/app/search',query)} onClick={event=>follow(event,discoveryTarget('/app/search',query),navigate)}>按问题找方法与工具</a></aside>
 </section>;
}
