import React,{useEffect,useState} from 'react';
import {ArrowRight,ArrowUpRight} from 'lucide-react';
import {availableForumContent,type ForumPostView} from './community-forum-view-types';
import {forumVersionPath} from './community-forum-origin.mjs';
import {forumTopics} from '../../galaxy-official/src/shared/community-forum-topics-v1.mjs';
import type {createWebRuntime} from './runtime.mjs';
type Props={runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void};
export function CommunityHighlights({runtime,navigate}:Props){
 const [items,setItems]=useState<ForumPostView[]>([]),[state,setState]=useState('loading'),[attempt,setAttempt]=useState(0),[now,setNow]=useState(()=>Date.now()/1000);
 useEffect(()=>{let active=true,working=false;
  const read=async()=>{if(!runtime||working)return;working=true;try{const page:{items:ForumPostView[]}=await runtime.api.call('/v2/community/posts/query',{limit:3,order:'published'},{authenticated:false});if(active){setItems(page.items);setNow(Date.now()/1000);setState('ready');}}catch{if(active){setItems([]);setState('error');}}finally{working=false;}};
  void read();const resume=()=>{if(!document.hidden)void read();},timer=window.setInterval(resume,30000);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
  return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
 },[runtime,attempt]);
 const deadline=Math.min(...items.flatMap(item=>typeof item.publishedUntil==='number'&&item.publishedUntil>now?[item.publishedUntil]:[]));
 useEffect(()=>{if(!Number.isFinite(deadline))return;const timer=window.setTimeout(()=>setNow(Date.now()/1000),Math.min(2147483647,Math.max(0,deadline*1000-Date.now()+1)));return()=>window.clearTimeout(timer);},[deadline]);
 const available=items.filter(item=>availableForumContent(item,now));
 const link=(path:string,children:React.ReactNode)=><a href={path} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}>{children}</a>;
 return <section className="browse-section browse-section-community" aria-labelledby="browse-community"><header><div><h2 id="browse-community">社区里正在聊</h2><p>作品、想法与日常，都可以从一段交流开始。</p></div>{link('/app/community',<>查看全部<ArrowRight size={15}/></>)}</header>
  {state==='loading'?<output className="browse-loading">正在读取公开讨论…</output>:state==='error'?<div className="browse-empty"><p>暂时没有读到公开讨论。</p><button onClick={()=>{setState('loading');setAttempt(value=>value+1);}}>重新读取</button></div>:available.length?<div className="browse-highlights">{available.map(item=><article className="browse-highlight" key={item.locator.postId}><p className="browse-highlight-meta">{forumTopics.find(topic=>topic.id===item.topic)?.label??'未分类'}</p><h3>{link(forumVersionPath(item.locator.postId,item.locator.versionId??item.currentVersionId)??'/app/community',<>{item.payload!.title}<ArrowUpRight size={15}/></>)}</h3><p className="browse-highlight-summary">{item.payload!.body.replace(/\s+/g,' ').trim()}</p></article>)}</div>:<div className="browse-empty"><p>还没有公开讨论。可以先看看主题，也可以留下一段自己的内容。</p>{link('/app/community',<>浏览社区主题<ArrowRight size={14}/></>)}</div>}
 </section>;
}
