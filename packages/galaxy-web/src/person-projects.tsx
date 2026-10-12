import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowRight,ArrowUpRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {directoryReadingState,rememberDirectoryReading,restoreDirectoryReading} from './directory-reading-state.mjs';
import type {AccountRuntime,ProfileProject} from './account-workspace-types';
import './person-projects.css';

type PortfolioItem={projectId:string;ownerId:string;document:{title:string;summary:string;kind:string;functions:string[];technologies?:string[];sourceUrl?:string}};
type PortfolioPage={items:PortfolioItem[];nextAfter:string|null};
type Props={runtime:AccountRuntime;connected:boolean;ownerId:string;legacy:ProfileProject[];preview?:boolean;refresh:number;check:()=>Promise<unknown>;navigate:(path:string)=>void;allPath:string};
function brief(value:string){const paragraph=value.split(/\n\s*\n/)[0];return paragraph.length>240?paragraph.slice(0,239)+'…':paragraph;}
function OpenLink({to,navigate,children,...props}:{to:string;navigate:(path:string)=>void;children:React.ReactNode}&Omit<React.ComponentPropsWithoutRef<'a'>,'href'|'onClick'>){return <a href={to} {...props} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&!event.shiftKey){event.preventDefault();navigate(to);}}}>{children}</a>;}
export function PersonProjects({runtime,ownerId,legacy,preview=false,refresh,check,navigate,allPath}:Props){
 const scope=JSON.stringify(['person-portfolio',runtime.api.endpoint,ownerId,preview]);
 const [items,setItems]=useState<PortfolioItem[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const control=useRef({alive:true,reading:false,sequence:0,depth:1}),restoring=useRef(true);
 const [remembered]=useState(()=>directoryReadingState(scope));
 const load=useCallback(async(after?:string,replace=false)=>{
  const state=control.current;if(state.reading&&!replace)return;state.reading=true;const sequence=++state.sequence;setBusy(true);
  try{
   const rows:PortfolioItem[]=[],seen=new Set<string>();let cursor=after??null,depth=0;
   const wanted=after||preview?1:Math.max(state.depth,Math.min(100,remembered.depth));
   do{
    await check();if(navigator.onLine===false)throw Error('offline');
    const page:PortfolioPage=await runtime.api.call('/v2/projects/portfolio/query',{ownerId,limit:preview?2:12,...(cursor?{after:cursor}:{})},{authenticated:false});await check();
    if(!state.alive||sequence!==state.sequence)return;
    if(page.items.some(item=>item.ownerId!==ownerId))throw Error('portfolio_owner_changed');
    rows.push(...page.items);depth++;
    if(page.nextAfter&&seen.has(page.nextAfter))throw Error('portfolio_cursor_repeated');
    if(page.nextAfter)seen.add(page.nextAfter);cursor=page.nextAfter;
   }while(cursor&&depth<wanted);
   if(!state.alive||sequence!==state.sequence)return;
   setItems(old=>[...new Map([...(after?old:[]),...rows].map(item=>[item.projectId,item])).values()]);setNext(cursor);setLoaded(true);setError('');state.depth=after?state.depth+1:depth;
   if(!preview)rememberDirectoryReading(scope,state.depth,remembered.anchorId);
  }catch(reason){if(state.alive&&sequence===state.sequence){setItems([]);setNext(null);setLoaded(true);const code=reason&&typeof reason==='object'&&'code' in reason?String(reason.code):'';setError(code.includes('sources_changed')?'作品刚有更新，请重新读取。':'作品暂时无法读取，可以重新打开。');}}
  finally{if(sequence===state.sequence){state.reading=false;if(state.alive)setBusy(false);}}
 },[check,ownerId,preview,remembered,runtime,scope]);
 useEffect(()=>{const state=control.current;state.alive=true;void Promise.resolve().then(()=>load(undefined,true));return()=>{state.alive=false;state.sequence++;};},[load,refresh]);
 useEffect(()=>{const state=control.current;const reread=()=>{if(!document.hidden&&navigator.onLine!==false)void load();},offline=()=>{state.sequence++;state.reading=false;setItems([]);setNext(null);setError('离线期间无法核对作品当前的阅读范围。');setBusy(false);};const timer=window.setInterval(reread,20000);document.addEventListener('visibilitychange',reread);window.addEventListener('online',reread);window.addEventListener('offline',offline);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',reread);window.removeEventListener('online',reread);window.removeEventListener('offline',offline);};},[load]);
 useLayoutEffect(()=>{if(!loaded||busy||error||!restoring.current)return;restoring.current=false;return restoreDirectoryReading(scope);},[loaded,busy,error,scope]);
 const legacyItems=legacy.filter(item=>!items.some(current=>current.projectId===item.id));
 const shownLegacy=preview?legacyItems.slice(0,Math.max(0,2-items.length)):legacyItems;
 const open=(item:PortfolioItem)=>{rememberDirectoryReading(scope,Math.max(1,control.current.depth),'person-project-'+item.projectId);navigate('/app/projects/'+item.projectId);};
 return <section className={'person-section person-portfolio'+(preview?' is-preview':'')}><header><h2>作品与项目</h2>{preview&&<OpenLink to={allPath} navigate={navigate}>全部作品<ArrowRight size={14}/></OpenLink>}</header>
  <div className="person-projects">{items.map(item=><article key={item.projectId} id={'person-project-'+item.projectId}><p className="person-project-kind">{item.document.kind==='module'?'模块':'作品 / 项目'}</p><h3><OpenLink to={'/app/projects/'+item.projectId} navigate={()=>open(item)}>{item.document.title}<ArrowRight size={17}/></OpenLink></h3><p>{brief(item.document.summary)}</p>{item.document.functions.length>0&&<ul className="person-project-directions">{item.document.functions.map(topic=><li key={topic}>{topic}</li>)}</ul>}<OpenLink to={'/app/projects/'+item.projectId} navigate={()=>open(item)} className="person-project-read">阅读完整作品介绍<ArrowRight size={14}/></OpenLink></article>)}</div>
  {shownLegacy.length>0&&<div className="person-projects person-profile-projects">{items.length>0&&!preview&&<h3 className="person-portfolio-subheading">个人介绍中的其他作品</h3>}{shownLegacy.map(item=><article key={item.id}><h3>{item.title}</h3><p>{preview?brief(item.summary):item.summary}</p>{item.functions.length>0&&<ul className="person-project-directions">{item.functions.map(topic=><li key={topic}>{topic}</li>)}</ul>}{!preview&&item.technologies.length>0&&<p className="person-project-functions">工具与技术：{item.technologies.join('、')}</p>}{item.sourceUrl&&<a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">打开作品来源<ArrowUpRight size={15}/></a>}</article>)}</div>}
  {busy&&!loaded&&<p className="person-muted"><output>正在读取作品…</output></p>}{loaded&&!items.length&&!legacyItems.length&&!error&&<p className="person-muted">暂时没有可查看的作品介绍。</p>}
  {error&&<p className="person-read-error" role="alert">{error}<button type="button" disabled={busy} onClick={()=>void load()}>重新读取作品</button></p>}
  {!preview&&next&&<Button variant="outline" disabled={busy} onClick={()=>void load(next)}>更多作品</Button>}
 </section>;
}
