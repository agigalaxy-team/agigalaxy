import React,{useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,ArrowUpRight,BookOpen,Compass,Layers,Search} from 'lucide-react';
import type {createWebRuntime} from './runtime.mjs';

type Props={runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void};
type Kind='tasks'|'capsules'|'projects';
export type TaskBrowseItem={taskId:string;state:string;request:{title:string;summary:string};synthetic?:boolean};
type CapsuleBrowseItem={capsuleId:string;versionId:string;sourceVersion:number;title:string;problemPattern:string;sourceStatus:string;deprecated:boolean;securityIssue:boolean;synthetic?:boolean};
type ProjectBrowseItem={projectId:string;document:{title:string;summary:string;kind:string;functions:string[]};synthetic?:boolean};
export type BrowsePage<T>={items:T[];nextAfter:string|null};
type ContentEntry={kind:'tasks';item:TaskBrowseItem}|{kind:'capsules';item:CapsuleBrowseItem}|{kind:'projects';item:ProjectBrowseItem};
const directories={tasks:{title:'开放任务',subtitle:'看看哪些真实目标正在寻找协助。',path:'/app/participate',endpoint:'/v2/tasks/query'},capsules:{title:'可复用的方法',subtitle:'阅读做法、适用环境和实际来源。',path:'/app/capsules',endpoint:'/v2/capsules/query'},projects:{title:'项目与模块',subtitle:'了解当前愿意交流与协作的项目。',path:'/app/projects',endpoint:'/v2/projects/directory/query'}};
const labels:Record<string,string>={open:'正在征集',closed:'已结束',canceled:'已取消',current:'来源当前可用','source-unavailable':'来源目前不可用','source-result-superseded':'来源已有纠正版本','source-currentness-unavailable':'来源结果的当前支持状态未知'};
export function browseReturnPath(fallback:string){
 const value=history.state?.browseReturn;if(typeof value!=='string')return fallback;
 try{const url=new URL(value,location.origin);return url.origin===location.origin&&['/app/','/app/participate','/app/capsules','/app/projects','/app/community','/app/rooms','/app/notifications','/app/information'].includes(url.pathname)?url.pathname+url.search+url.hash:fallback;}catch{return fallback;}
}
export function browseReturnLabel(fallback:string){const path=new URL(browseReturnPath(fallback),location.origin).pathname;return ({'/app/':'发现','/app/participate':'求助目录','/app/capsules':'方法目录','/app/projects':'项目目录','/app/community':'社区','/app/rooms':'对话列表','/app/notifications':'通知','/app/information':'资料与关注'} as Record<string,string>)[path]??'上一页';}
function contentKey(entry:ContentEntry){return entry.kind==='tasks'?entry.item.taskId:entry.kind==='capsules'?entry.item.capsuleId:entry.item.projectId;}
export function ContentCard(props:ContentEntry&{navigate:(path:string)=>void}){
 const {navigate}=props;
 const data=props.kind==='tasks'?{title:props.item.request.title,description:props.item.request.summary,url:`/app/tasks/${props.item.taskId}`,meta:labels[props.item.state]??props.item.state}
  :props.kind==='capsules'?{title:props.item.title,description:props.item.problemPattern,url:`/app/capsules/${props.item.capsuleId}/versions/${props.item.versionId}`,meta:'Capsule · v'+props.item.sourceVersion}
  :{title:props.item.document.title,description:props.item.document.summary,url:`/app/projects/${props.item.projectId}`,meta:props.item.document.kind==='module'?'功能模块':'项目'};
 return <article className="content-card"><div className="content-card-meta"><span>{data.meta}</span>{props.item.synthetic&&<span>合成演示</span>}</div><h3><a href={data.url} onClick={e=>{e.preventDefault();navigate(data.url);}}>{data.title}<ArrowUpRight size={16}/></a></h3><p>{data.description}</p>{props.kind==='capsules'&&<span className="content-card-foot">{labels[props.item.sourceStatus]??props.item.sourceStatus}{props.item.deprecated?' · 已停用':''}{props.item.securityIssue?' · 有安全事项':''}</span>}{props.kind==='projects'&&<div className="content-tags">{props.item.document.functions.slice(0,3).map(f=><span key={f}>{f}</span>)}</div>}<a className="content-read" href={data.url} onClick={e=>{e.preventDefault();navigate(data.url);}}>阅读详情 <ArrowRight size={14}/></a></article>;
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
function BrowseSectionRead({runtime,navigate,kind,retry}:Props&{kind:Kind;retry:()=>void}){
 const d=directories[kind],[items,setItems]=useState<ContentEntry[]>([]),[state,setState]=useState('loading'),[hasMore,setHasMore]=useState(false);
 useEffect(()=>{let current=true;if(runtime)void readHighlights(runtime,kind).then(value=>{if(current){setItems(value.items);setHasMore(!!value.nextAfter);setState('ready');}}).catch(()=>{if(current)setState('error');});return()=>{current=false;};},[runtime,kind]);
 return <section className="browse-section" aria-labelledby={'browse-'+kind}><header><div><h2 id={'browse-'+kind}>{d.title}</h2><p>{d.subtitle}</p></div><a href={d.path} onClick={e=>{e.preventDefault();navigate(d.path);}}>全部浏览 <ArrowRight size={15}/></a></header>{state==='loading'?<div className="browse-loading"><output>正在读取公开内容…</output></div>:state==='error'?<div className="browse-empty"><p><output>暂时无法读取{d.title}。</output></p><button onClick={retry}>重新读取</button></div>:items.length?<div className="content-grid">{items.map(entry=><ContentCard key={contentKey(entry)} {...entry} navigate={navigate}/>)}</div>:<div className="browse-empty"><BookOpen size={23}/><div><h3>{hasMore?'这一范围暂未发现可浏览内容。':<>这里还没有可浏览的{kind==='tasks'?'开放任务':kind==='capsules'?'公开方法':'公开项目'}。</>}</h3><p>{kind==='tasks'?'你可以发起自己的目标，也可以先了解协作如何进行。':kind==='capsules'?'方法在作者整理并公开后出现。现在可以先了解它如何保留做法与来源。':'当前目录只展示资料和参与意愿都允许被发现的项目。'}</p></div><a href={kind==='tasks'?'/app/publish':'/how-it-works/'} onClick={kind==='tasks'?e=>{e.preventDefault();navigate('/app/publish');}:undefined}>{kind==='tasks'?'发起请求':'了解如何协作'} <ArrowRight size={14}/></a></div>}</section>;
}
export function PublicBrowseWorkspace({runtime,navigate}:Props){return <section className="explore-page"><header className="explore-intro"><p className="eyebrow">从真实工作中，找到下一步</p><h1>探索银河</h1><p>浏览正在推进的目标、可借鉴的方法，以及愿意交流的项目。</p><div className="explore-actions"><a className="primary-action" href="/app/search" onClick={e=>{e.preventDefault();navigate('/app/search');}}><Search size={16}/>找具体帮助</a><a href="/app/publish" onClick={e=>{e.preventDefault();navigate('/app/publish');}}>发起自己的请求 <ArrowUpRight size={15}/></a></div></header><nav className="explore-index" aria-label="浏览内容类别">{([['tasks','开放任务','参与真实协作',Compass],['capsules','方法与经验','了解可复用做法',BookOpen],['projects','项目与模块','发现共同方向',Layers]] as const).map(([id,title,desc,Icon])=><a key={id} href={'#browse-'+id}><Icon size={22}/><div><strong>{title}</strong><span>{desc}</span></div><ArrowRight size={16}/></a>)}</nav><BrowseSection {...{runtime,navigate}} kind="tasks"/><BrowseSection {...{runtime,navigate}} kind="capsules"/><BrowseSection {...{runtime,navigate}} kind="projects"/><section className="reading-guides"><div><p className="eyebrow">先读一点，再决定下一步</p><h2>每一份帮助，都有来处。</h2><p>你可以直接使用网页，也可以连接正在使用的 AI。选择何时参与、分享多少资料，始终由你决定。</p></div><nav><a href="/how-it-works/"><span>01</span><div><h3>一次协作如何开始</h3><p>从目标、回应到实际交付。</p></div><ArrowUpRight size={18}/></a><a href="/privacy/"><span>02</span><div><h3>分享之前，了解你的控制权</h3><p>身份、授权和数据范围。</p></div><ArrowUpRight size={18}/></a><a href="/downloads/"><span>03</span><div><h3>把银河连接到自己的 AI</h3><p>在熟悉的工作中继续。</p></div><ArrowUpRight size={18}/></a></nav></section></section>;}

const readProjectQuery=()=>new URLSearchParams(location.search).get('q')??'';
export function ProjectDirectoryWorkspace({runtime,navigate}:Props){
 const [draft,setDraft]=useState(readProjectQuery),[query,setQuery]=useState(readProjectQuery),[attempt,setAttempt]=useState(0);
 useEffect(()=>{const pop=()=>{const value=readProjectQuery();setQuery(value);setDraft(value);};addEventListener('popstate',pop);return()=>removeEventListener('popstate',pop);},[]);
 const search=(value:string)=>{history.pushState(history.state,'','/app/projects'+(value?'?q='+encodeURIComponent(value):''));if(value===query)setAttempt(current=>current+1);else setQuery(value);};
 const clear=()=>{setDraft('');setQuery('');history.replaceState(history.state,'','/app/projects');};
 return <ProjectDirectoryRead key={JSON.stringify([runtime?.api.endpoint,query,attempt])} runtime={runtime} navigate={navigate} draft={draft} query={query} onDraft={setDraft} onSearch={search} onClear={clear} retry={()=>setAttempt(value=>value+1)}/>;
}
function ProjectDirectoryRead({runtime,navigate,draft,query,onDraft,onSearch,onClear,retry}:Props&{draft:string;query:string;onDraft:(value:string)=>void;onSearch:(value:string)=>void;onClear:()=>void;retry:()=>void}){
 const [items,setItems]=useState<ProjectBrowseItem[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(!!runtime),[error,setError]=useState('');
 const epoch=useRef(0),working=useRef(false);
 const request=useCallback((after?:string)=>{
  if(!runtime||working.current)return;const token=epoch.current;working.current=true;
  return runtime.api.call(directories.projects.endpoint,{query,limit:12,...(after?{after}:{})},{authenticated:false}).then((value:BrowsePage<ProjectBrowseItem>)=>{
   if(token!==epoch.current)return;
   setItems(old=>after?[...old,...value.items.filter(row=>!old.some(known=>known.projectId===row.projectId))]:value.items);setNext(value.nextAfter);setLoaded(true);
  }).catch((reason:unknown)=>{
   if(token!==epoch.current)return;
   const code=reason&&typeof reason==='object'&&'code' in reason?reason.code:null;
   const changed=code==='project_directory_cursor_unavailable_restart'||code==='project_directory_sources_changed_retry';
   if(changed){setItems([]);setNext(null);setLoaded(false);}
   setError(changed?'目录范围已变化，请重新读取后继续浏览。':'暂时无法读取项目目录，请重试。');
  }).finally(()=>{if(token===epoch.current){working.current=false;setBusy(false);}});
 },[runtime,query]);
 useEffect(()=>{const lifecycle=epoch;lifecycle.current++;void request();return()=>{lifecycle.current++;working.current=false;};},[request]);
 return <section className="directory-page"><header className="directory-heading"><div><p className="eyebrow">找到共同的方向</p><h1 className="small">项目与模块</h1><p className="lead">了解项目正在做什么，再决定是否进一步交流。</p></div><a href="/app/projects?section=projects" onClick={e=>{e.preventDefault();navigate('/app/projects?section=projects');}}>我的项目 <ArrowRight size={15}/></a></header><div className="directory-toolbar"><form onSubmit={e=>{e.preventDefault();onSearch(draft.trim());}}><Search size={18}/><input aria-label="搜索公开项目" placeholder="搜索项目名称或功能" value={draft} onChange={e=>onDraft(e.target.value)} maxLength={200}/><button disabled={busy||!runtime}>搜索</button></form><a href="/app/match" onClick={e=>{e.preventDefault();navigate('/app/match');}}>按目标寻找同行 →</a></div>{error&&<div className="message error" role="alert">{error}<button onClick={retry}>重新读取目录</button></div>}{busy&&!loaded&&<p><output>正在读取公开项目…</output></p>}<div className="content-grid">{items.map(item=><ContentCard key={item.projectId} kind="projects" item={item} navigate={navigate}/>)}</div>{loaded&&!busy&&!error&&!items.length&&<div className="directory-empty"><Layers size={30}/><h2>{next?'这一范围暂未发现可浏览项目':query?'没有找到符合条件的项目':'还没有可浏览的公开项目'}</h2><p>{next?'还有范围尚未读取。可以继续浏览，或调整搜索条件。':query?'换一个功能或项目名称试试。':'目录只展示当前允许被发现、并愿意交流的项目。你也可以从自己的目标开始寻找相关机会。'}</p>{query?<button onClick={onClear}>清除搜索</button>:<a href="/app/match" onClick={e=>{e.preventDefault();navigate('/app/match');}}>从我的目标寻找 →</a>}</div>}{next&&<button className="load-more" disabled={busy} onClick={()=>{setBusy(true);setError('');void request(next);}}>{busy?'正在读取…':'继续浏览项目'}</button>}<p className="directory-note">项目介绍来自发布者。当前公开资料和参与意愿决定能否出现在目录，浏览不会联系任何人。</p></section>;
}
