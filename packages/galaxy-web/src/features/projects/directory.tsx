import {useCallback,useEffect,useLayoutEffect,useRef,useState} from "react";
import {Layers,Search} from "lucide-react";
import "../discovery/home.css";
import {SaveForLaterButton} from "../bookmarks/controls";
import {directoryReadingState,rememberDirectoryReading,restoreDirectoryReading} from "../../shared/reading/directory-reading-state.mjs";
import {directories} from "../discovery/contracts";
import type {Props,ProjectBrowseItem,BrowsePage} from "../discovery/contracts";
import {ContentCard} from "../discovery/content-card";


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
  return <section className="directory-page"><header className="directory-heading"><div><p className="eyebrow">找到共同的方向</p><h1 className="small">项目与模块</h1><p className="lead">了解项目正在做什么，再决定是否进一步交流。</p></div><a href="/app/projects?section=projects" onClick={e=>{e.preventDefault();navigate('/app/projects?section=projects');}}>我的项目 </a></header><div className="directory-toolbar"><form onSubmit={e=>{e.preventDefault();onSearch(draft.trim());}}><Search size={18}/><input aria-label="搜索公开项目" placeholder="搜索项目名称或功能" value={draft} onChange={e=>onDraft(e.target.value)} maxLength={200}/><button disabled={busy||!runtime}>搜索</button></form><a href="/app/match" onClick={e=>{e.preventDefault();navigate('/app/match');}}>按目标寻找同行 </a></div>{query&&<p className="browse-note">当前查找：{query} <button type="button" onClick={onClear}>清除，浏览全部项目</button></p>}{error&&<div className="message error" role="alert">{error}<button onClick={retry}>重新读取目录</button></div>}{busy&&!loaded&&<p><output>正在读取公开项目…</output></p>}<div className="content-grid">{items.map(item=><ContentCard key={item.projectId} kind="projects" item={item} navigate={path=>open(item,path)} saveForLater={<SaveForLaterButton runtime={runtime} connected={!!session} subjectId={session?.subjectId} reference={{kind:'project',projectId:item.projectId}} onNeedIdentity={()=>navigate('/app/settings/identity')}/>}/>)}</div>{loaded&&!busy&&!error&&!items.length&&<div className="directory-empty"><Layers size={30}/><h2>{next?'这一范围暂未发现可浏览项目':query?'没有找到符合条件的项目':'还没有可浏览的公开项目'}</h2><p>{next?'还有范围尚未读取。可以继续浏览，或调整搜索条件。':query?'换一个功能或项目名称试试。':'目录只展示当前允许被发现、并愿意交流的项目。你也可以从自己的目标开始寻找相关机会。'}</p>{query?<button onClick={onClear}>清除搜索</button>:<a href="/app/match" onClick={e=>{e.preventDefault();navigate('/app/match');}}>从我的目标寻找 </a>}</div>}{next&&<button className="load-more" disabled={busy} onClick={()=>{setBusy(true);setError('');void request(next);}}>{busy?'正在读取…':'继续浏览项目'}</button>}<p className="directory-note">项目介绍来自发布者。当前公开资料和参与意愿决定能否出现在目录，浏览不会联系任何人。</p></section>;
}
