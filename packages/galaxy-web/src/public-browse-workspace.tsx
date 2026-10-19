import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowRight,ArrowUpRight,BookOpen,Layers,MessagesSquare,Search,UsersRound} from 'lucide-react';
import type {createWebRuntime} from './runtime.mjs';
import {discoveryTarget} from './discovery-navigation';
import {TaskCurrentCard,TaskMaterialNotice,taskViewTitle} from './task-material-view';
import './discovery-home.css';
import {SaveForLaterButton} from './reading-bookmarks-workspace';
import {CommunityHighlights} from './community-highlights';
import {ContentPreview} from './community-content-visuals';
import {CommunityExampleGallery} from './community-example-workspace';
import {profileSubject} from './profile-navigation.mjs';
import {directoryReadingState,rememberDirectoryReading,restoreDirectoryReading} from './directory-reading-state.mjs';

type Props={runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void};
type Kind='tasks'|'capsules'|'projects';
export type TaskBrowseItem={taskId:string;state:string;request:{title:string;summary:string};synthetic?:boolean};
export type CapsuleBrowseItem={capsuleId:string;versionId:string;sourceVersion:number;title:string;problemPattern:string;sourceStatus:string;deprecated:boolean;securityIssue:boolean;synthetic?:boolean};
export type ProjectBrowseItem={projectId:string;document:{title:string;summary:string;kind:string;functions:string[]};synthetic?:boolean};
export type BrowsePage<T>={items:T[];nextAfter:string|null};
type ContentEntry={kind:'tasks';item:TaskBrowseItem}|{kind:'capsules';item:CapsuleBrowseItem}|{kind:'projects';item:ProjectBrowseItem};
const directories={tasks:{title:'正在找帮助',subtitle:'看看有哪些你能参与的事。',path:'/app/participate',endpoint:'/v2/tasks/query'},capsules:{title:'方法与经验',subtitle:'读一份做法，带回自己的工作。',path:'/app/capsules',endpoint:'/v2/capsules/query'},projects:{title:'项目与模块',subtitle:'了解大家正在做什么。',path:'/app/projects',endpoint:'/v2/projects/directory/query'}};
const labels:Record<string,string>={open:'正在征集',closed:'已结束',canceled:'已取消',current:'来源当前可用','source-unavailable':'来源目前不可用','source-result-superseded':'来源已有纠正版本','source-currentness-unavailable':'来源结果的当前支持状态未知'};
export function browseReturnPath(fallback:string){
 const value=history.state?.browseReturn;if(typeof value!=='string')return fallback;
  try{const url=new URL(value,location.origin);return url.origin===location.origin&&(['/app/','/app/work','/app/find','/app/search','/app/match','/app/history','/app/participate','/app/capsules','/app/projects','/app/community','/app/rooms','/app/notifications','/app/information','/app/bookmarks'].includes(url.pathname)||!!profileSubject(url.pathname))?url.pathname+url.search+url.hash:fallback;}catch{return fallback;}
}
export function browseReturnLabel(fallback:string){const url=new URL(browseReturnPath(fallback),location.origin),path=url.pathname;if(profileSubject(path))return url.searchParams.get('section')==='experience'?'人物完整经历':'人物资料';if(path==='/app/participate'&&url.searchParams.get('view')==='requested')return '我发布的求助';if(path==='/app/participate'&&url.searchParams.get('view')==='participating')return '我参与的工作';return ({'/app/':'发现','/app/work':'我的工作','/app/find':'查找结果','/app/search':'方法与工具','/app/match':'寻找同行','/app/history':'经历与贡献','/app/participate':'求助目录','/app/capsules':'方法目录','/app/projects':'项目目录','/app/community':'社区','/app/rooms':'对话列表','/app/notifications':'通知','/app/information':'资料与关注','/app/bookmarks':'我的收藏'} as Record<string,string>)[path]??'上一页';}
function contentKey(entry:ContentEntry){return entry.kind==='tasks'?entry.item.taskId:entry.kind==='capsules'?entry.item.capsuleId:entry.item.projectId;}
export function ContentCard(props:ContentEntry&{navigate:(path:string)=>void;runtime?:Props['runtime'];saveForLater?:React.ReactNode}){
 return props.kind==='tasks'?<TaskCurrentCard runtime={props.runtime} task={props.item}>{item=><ReadableContentCard {...props} item={item}/>}</TaskCurrentCard>:<ReadableContentCard {...props}/>;
}
function ReadableContentCard(props:ContentEntry&{navigate:(path:string)=>void;saveForLater?:React.ReactNode}){
 const {navigate}=props;
 const data=props.kind==='tasks'?{title:taskViewTitle(props.item),description:props.item.request.summary,url:`/app/tasks/${props.item.taskId}`,meta:labels[props.item.state]??props.item.state}
  :props.kind==='capsules'?{title:props.item.title,description:props.item.problemPattern,url:`/app/capsules/${props.item.capsuleId}/versions/${props.item.versionId}`,meta:'Capsule · v'+props.item.sourceVersion}
  :{title:props.item.document.title,description:props.item.document.summary,url:`/app/projects/${props.item.projectId}`,meta:props.item.document.kind==='module'?'功能模块':'项目'};
  return <article className={'content-card content-card-'+props.kind} id={'directory-'+props.kind+'-'+contentKey(props)}>{props.kind!=='tasks'&&<a className="content-card-cover" href={data.url} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(data.url);}}} aria-label={'阅读：'+data.title}><ContentPreview kind={props.kind==='projects'?'project':'method'} title={data.title} excerpt={data.description}/></a>}<div className="content-card-copy"><div className="content-card-meta"><span>{data.meta}</span>{props.item.synthetic&&<span>合成演示</span>}</div><h3><a href={data.url} onClick={e=>{e.preventDefault();navigate(data.url);}}>{data.title}<ArrowUpRight size={16}/></a></h3><p>{data.description}</p>{props.kind==='tasks'&&<TaskMaterialNotice task={props.item}/>}{props.kind==='capsules'&&<span className="content-card-foot">{labels[props.item.sourceStatus]??props.item.sourceStatus}{props.item.deprecated?' · 已停用':''}{props.item.securityIssue?' · 有安全事项':''}</span>}{props.kind==='projects'&&<div className="content-tags">{props.item.document.functions.slice(0,3).map(f=><a key={f} href={'/app/projects?q='+encodeURIComponent(f)} aria-label={'查找与'+f+'有关的项目'} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate('/app/projects?q='+encodeURIComponent(f));}}}><span>{f}</span></a>)}</div>}<a className="content-read" href={data.url} onClick={e=>{e.preventDefault();navigate(data.url);}}>阅读详情 <ArrowRight size={14}/></a>{props.saveForLater}</div></article>;
}
function BrowseSection({runtime,navigate,kind}:Props&{kind:Kind}){
 const [attempt,setAttempt]=useState(0);
 return <BrowseSectionRead key={JSON.stringify([runtime?.api.endpoint,kind,attempt])} runtime={runtime} navigate={navigate} kind={kind} retry={()=>setAttempt(value=>value+1)}/>;
}
async function readHighlights(runtime:NonNullable<Props['runtime']>,kind:Kind):Promise<BrowsePage<ContentEntry>>{
 const endpoint=directories[kind].endpoint,options={query:'',limit:3};
 if(kind==='tasks'){const page:BrowsePage<TaskBrowseItem>=await runtime.api.call(endpoint,{...options,view:'open'},{authenticated:false});return{items:page.items.map(item=>({kind,item})),nextAfter:page.nextAfter};}
 if(kind==='capsules'){const page:BrowsePage<CapsuleBrowseItem>=await runtime.api.call(endpoint,options,{authenticated:false});return{items:page.items.map(item=>({kind,item})),nextAfter:page.nextAfter};}
 const page:BrowsePage<ProjectBrowseItem>=await runtime.api.call(endpoint,options,{authenticated:false});return{items:page.items.map(item=>({kind,item})),nextAfter:page.nextAfter};
}
function BrowseHighlight(props:ContentEntry&{navigate:(path:string)=>void;runtime:Props['runtime']}){
 return props.kind==='tasks'?<TaskCurrentCard runtime={props.runtime} task={props.item}>{item=><ReadableBrowseHighlight {...props} item={item}/>}</TaskCurrentCard>:<ReadableBrowseHighlight {...props}/>;
}
function ReadableBrowseHighlight(props:ContentEntry&{navigate:(path:string)=>void}){
 const {navigate}=props;
 const title=props.kind==='tasks'?taskViewTitle(props.item):props.kind==='capsules'?props.item.title:props.item.document.title;
 const summary=props.kind==='tasks'?props.item.request.summary:props.kind==='capsules'?props.item.problemPattern:props.item.document.summary;
 const target=props.kind==='tasks'?'/app/tasks/'+props.item.taskId:props.kind==='capsules'?'/app/capsules/'+props.item.capsuleId+'/versions/'+props.item.versionId:'/app/projects/'+props.item.projectId;
 return <article className={'browse-highlight browse-highlight-'+props.kind}>
  {props.kind==='projects'&&<a href={target} className="browse-highlight-cover" aria-label={'阅读：'+title} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(target);}}}><ContentPreview kind="project" title={title} excerpt={summary}/></a>}
  {props.kind==='capsules'&&<BookOpen className="method-bookmark" size={21} aria-hidden="true"/>}
  <div>{props.kind==='tasks'&&<p className="browse-highlight-meta">{labels[props.item.state]??props.item.state}</p>}<h3><a href={target} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(target);}}}>{title}<ArrowUpRight size={15}/></a></h3><p className="browse-highlight-summary">{summary}</p>{props.kind==='tasks'&&<TaskMaterialNotice task={props.item}/>}
   {props.kind==='projects'&&!!props.item.document.functions.length&&<p className="browse-highlight-meta">{props.item.document.functions.slice(0,3).join(' · ')}</p>}
   {props.kind==='capsules'&&(props.item.sourceStatus!=='current'||props.item.deprecated||props.item.securityIssue)&&<p className="browse-highlight-meta">{props.item.deprecated?'已停用':props.item.securityIssue?'有安全事项':labels[props.item.sourceStatus]??props.item.sourceStatus}</p>}
   {props.item.synthetic&&<span className="browse-highlight-meta">合成演示</span>}
  </div>
 </article>;
}
function BrowseSectionRead({runtime,navigate,kind,retry}:Props&{kind:Kind;retry:()=>void}){
 const d=directories[kind],[items,setItems]=useState<ContentEntry[]>([]),[state,setState]=useState('loading'),[hasMore,setHasMore]=useState(false);
 useEffect(()=>{let current=true;if(runtime)void readHighlights(runtime,kind).then(value=>{if(current){setItems(value.items);setHasMore(!!value.nextAfter);setState('ready');}}).catch(()=>{if(current)setState('error');});return()=>{current=false;};},[runtime,kind]);
 const emptyText=kind==='tasks'?'当前还没有公开的求助。':kind==='capsules'?'当前还没有公开的方法。':'当前还没有可浏览的公开项目。';
 return <section className={'browse-section browse-section-'+kind} aria-labelledby={'browse-'+kind}><header><div><h2 id={'browse-'+kind}>{d.title}</h2><p>{d.subtitle}</p></div><a href={d.path} onClick={event=>{event.preventDefault();navigate(d.path);}}>查看全部 <ArrowRight size={15}/></a></header>
  {state==='loading'?<div className="browse-loading"><output>正在读取公开内容…</output></div>:state==='error'?<div className="browse-empty"><p>暂时无法读取这部分内容。</p><button onClick={retry}>重新读取</button></div>:items.length?<div className={'browse-highlights browse-highlights-'+kind}>{items.map(entry=><BrowseHighlight key={contentKey(entry)} {...entry} navigate={navigate} runtime={runtime}/>)}</div>:<div className="browse-empty"><p>{hasMore?'这一范围暂未发现可浏览内容。':emptyText}</p>{kind==='tasks'?<a href="/app/publish" onClick={event=>{event.preventDefault();navigate('/app/publish');}}>发起自己的求助 <ArrowRight size={14}/></a>:<a href={kind==='projects'?'/app/match':'/app/search'} onClick={event=>{event.preventDefault();navigate(kind==='projects'?'/app/match':'/app/search');}}>{kind==='projects'?'按方向寻找同行':'查找其他经验'} <ArrowRight size={14}/></a>}</div>}
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
  <header className="explore-intro"><p className="eyebrow">银河 · 发现</p><h1>让好奇心，<br/>遇见正在发生的事。</h1><p>看看大家的想法与作品，找到一份经验，或一个可以一起做事的人。</p>
   <search><form className="explore-search" onSubmit={event=>{event.preventDefault();navigate(discoveryTarget('/app/find',query));}}><label className="sr-only" htmlFor="explore-query">查找银河内容</label><Search size={20}/><input id="explore-query" type="search" maxLength={160} placeholder="搜索讨论、做法、项目或求助" value={query} onChange={event=>{setQuery(event.target.value);try{sessionStorage.setItem('galaxy-discovery-query',event.target.value);}catch{/* Typing remains available without browser storage. */}}}/><button type="submit">查找内容 <ArrowRight size={16}/></button></form></search>
   <div className="explore-next"><span>想从人开始？</span><a href={peopleTarget} onClick={event=>go(event,peopleTarget)}>寻找同行与项目 <ArrowRight size={14}/></a></div>
  </header>
  <nav className="explore-places" aria-label="浏览内容类别">{([['/app/community','社区讨论',MessagesSquare],['/app/capsules','方法与经验',BookOpen],['/app/participate','正在找帮助',UsersRound],['/app/projects','项目与模块',Layers]] as const).map(([target,title,Icon])=><a key={target} href={target} onClick={event=>go(event,target)}><Icon size={19}/>{title}<ArrowUpRight size={14}/></a>)}</nav>
  <div className="explore-content"><CommunityHighlights {...{runtime,navigate}}/><BrowseSection {...{runtime,navigate}} kind="capsules"/></div>
  <CommunityExampleGallery navigate={navigate}/>
  <BrowseSection {...{runtime,navigate}} kind="projects"/>
  <BrowseSection {...{runtime,navigate}} kind="tasks"/>
  <aside className="explore-continue"><div><h2>带着自己的问题来，也可以。</h2><p>利用已有的背景找帮助，收到回应后继续交流和工作。</p></div><a href="/app/publish" onClick={event=>go(event,'/app/publish')}>发起求助 <ArrowRight size={16}/></a></aside>
  <nav className="explore-reading-links" aria-label="了解银河"><a href="/how-it-works/">怎样使用银河 <ArrowUpRight size={14}/></a><a href="/downloads/">在自己的 AI 中继续 <ArrowUpRight size={14}/></a><a href="/privacy/">资料与隐私 <ArrowUpRight size={14}/></a></nav>
 </section>;
}

const readProjectQuery=()=>new URLSearchParams(location.search).get('q')??'';
export function ProjectDirectoryWorkspace({runtime,navigate}:Props){
 return <ProjectDirectorySession key={readProjectQuery()} runtime={runtime} navigate={navigate} query={readProjectQuery()}/>;
}
function ProjectDirectorySession({runtime,navigate,query}:Props&{query:string}){
 const [draft,setDraft]=useState(query),[attempt,setAttempt]=useState(0);
 const search=(value:string)=>{if(value===query)setAttempt(current=>current+1);else navigate('/app/projects'+(value?'?q='+encodeURIComponent(value):''));};
 const clear=()=>navigate('/app/projects');
 return <ProjectDirectoryRead key={JSON.stringify([runtime?.api.endpoint,query,attempt])} runtime={runtime} navigate={navigate} draft={draft} query={query} onDraft={setDraft} onSearch={search} onClear={clear} retry={()=>setAttempt(value=>value+1)}/>;
}
function ProjectDirectoryRead({runtime,navigate,draft,query,onDraft,onSearch,onClear,retry}:Props&{draft:string;query:string;onDraft:(value:string)=>void;onSearch:(value:string)=>void;onClear:()=>void;retry:()=>void}){
 const [items,setItems]=useState<ProjectBrowseItem[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(!!runtime),[error,setError]=useState('');
  const scope=JSON.stringify(['projects',runtime?.api.endpoint,query]),initial=directoryReadingState(scope);
  const epoch=useRef(0),working=useRef(false),depth=useRef(initial.depth),loadedDepth=useRef(0),restoring=useRef(!!initial.anchorId);
 const request=useCallback((after?:string)=>{
  if(!runtime||working.current)return;const token=epoch.current;working.current=true;
  return (async()=>{let cursor=after??null,pages=0;const rows:ProjectBrowseItem[]=[];
    for(let index=0;index<(after?1:depth.current);index++){
      const value:BrowsePage<ProjectBrowseItem>=await runtime.api.call(directories.projects.endpoint,{query,limit:12,...(cursor?{after:cursor}:{})},{authenticated:false});
      if(token!==epoch.current)return null;rows.push(...value.items);cursor=value.nextAfter;pages++;if(!cursor)break;
    }return{items:rows,nextAfter:cursor,pages};
  })().then(value=>{
   if(token!==epoch.current||!value)return;
   loadedDepth.current=after?loadedDepth.current+value.pages:value.pages;depth.current=loadedDepth.current;
   setItems(old=>[...new Map((after?[...old,...value.items]:value.items).map(item=>[item.projectId,item])).values()]);setNext(value.nextAfter);setLoaded(true);
   rememberDirectoryReading(scope,Math.max(1,loadedDepth.current),directoryReadingState(scope).anchorId);
  }).catch((reason:unknown)=>{
   if(token!==epoch.current)return;
   const code=reason&&typeof reason==='object'&&'code' in reason?reason.code:null;
   const changed=code==='project_directory_cursor_unavailable_restart'||code==='project_directory_sources_changed_retry';
    if(changed){setItems([]);setNext(null);setLoaded(false);depth.current=1;rememberDirectoryReading(scope,1);}
   setError(changed?'目录范围已变化，请重新读取后继续浏览。':'暂时无法读取项目目录，请重试。');
  }).finally(()=>{if(token===epoch.current){working.current=false;setBusy(false);}});
  },[runtime,query,scope]);
 useEffect(()=>{const lifecycle=epoch;lifecycle.current++;void request();return()=>{lifecycle.current++;working.current=false;};},[request]);
  useLayoutEffect(()=>{if(!loaded||!restoring.current)return;restoring.current=false;return restoreDirectoryReading(scope);},[loaded,scope]);
  const open=(item:ProjectBrowseItem,path:string)=>{rememberDirectoryReading(scope,Math.max(1,loadedDepth.current),'directory-projects-'+item.projectId);navigate(path);};
  const session=runtime?.api.snapshot();
  return <section className="directory-page"><header className="directory-heading"><div><p className="eyebrow">找到共同的方向</p><h1 className="small">项目与模块</h1><p className="lead">了解项目正在做什么，再决定是否进一步交流。</p></div><a href="/app/projects?section=projects" onClick={e=>{e.preventDefault();navigate('/app/projects?section=projects');}}>我的项目 <ArrowRight size={15}/></a></header><div className="directory-toolbar"><form onSubmit={e=>{e.preventDefault();onSearch(draft.trim());}}><Search size={18}/><input aria-label="搜索公开项目" placeholder="搜索项目名称或功能" value={draft} onChange={e=>onDraft(e.target.value)} maxLength={200}/><button disabled={busy||!runtime}>搜索</button></form><a href="/app/match" onClick={e=>{e.preventDefault();navigate('/app/match');}}>按目标寻找同行 →</a></div>{query&&<p className="browse-note">当前查找：{query} <button type="button" onClick={onClear}>清除，浏览全部项目</button></p>}{error&&<div className="message error" role="alert">{error}<button onClick={retry}>重新读取目录</button></div>}{busy&&!loaded&&<p><output>正在读取公开项目…</output></p>}<div className="content-grid">{items.map(item=><ContentCard key={item.projectId} kind="projects" item={item} navigate={path=>open(item,path)} saveForLater={<SaveForLaterButton runtime={runtime} connected={!!session} subjectId={session?.subjectId} reference={{kind:'project',projectId:item.projectId}} onNeedIdentity={()=>navigate('/app/settings/identity')}/>}/>)}</div>{loaded&&!busy&&!error&&!items.length&&<div className="directory-empty"><Layers size={30}/><h2>{next?'这一范围暂未发现可浏览项目':query?'没有找到符合条件的项目':'还没有可浏览的公开项目'}</h2><p>{next?'还有范围尚未读取。可以继续浏览，或调整搜索条件。':query?'换一个功能或项目名称试试。':'目录只展示当前允许被发现、并愿意交流的项目。你也可以从自己的目标开始寻找相关机会。'}</p>{query?<button onClick={onClear}>清除搜索</button>:<a href="/app/match" onClick={e=>{e.preventDefault();navigate('/app/match');}}>从我的目标寻找 →</a>}</div>}{next&&<button className="load-more" disabled={busy} onClick={()=>{setBusy(true);setError('');void request(next);}}>{busy?'正在读取…':'继续浏览项目'}</button>}<p className="directory-note">项目介绍来自发布者。当前公开资料和参与意愿决定能否出现在目录，浏览不会联系任何人。</p></section>;
}
