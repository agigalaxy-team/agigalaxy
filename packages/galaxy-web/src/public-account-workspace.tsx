import React,{useEffect,useRef,useState} from 'react';
import {UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createOfficialAccountClient} from './official-account-client.mjs';
import {loadWebConfiguration} from './runtime.mjs';
import {availableForumContent,type ForumPostView} from './community-forum-view-types';
import {forumVersionPath} from './community-forum-origin.mjs';
import {PublicLinkedIds,PublicExternalCredentials} from './public-account-relations';
import {publicAccountReturn,profileReturnLabel} from './profile-navigation.mjs';
import './online-account-settings.css';

type PublicPosts={items:ForumPostView[];nextAfter?:string|null;scanTruncated:boolean;checkedAt:number};
type PublicAccount={accountId:string;uid?:string|null;displayName:string|null;subjectType:'person'|'organization'|'agent'|null;typeSource:'account-owner-statement';publicQuery?:{showLinkedIds:boolean;showExternalCredentials:boolean};posts?:PublicPosts};
export function PublicAccountWorkspace({accountId,endpoint,navigate,onReturn}:{accountId:string;endpoint?:string;navigate:(path:string)=>void;onReturn?:(path:string)=>void}){
 const [value,setValue]=useState<PublicAccount|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0),[now,setNow]=useState(()=>Math.floor(Date.now()/1000));
 const loadedPages=useRef(1),snapshot=useRef(value),more=useRef<HTMLDivElement>(null),request=useRef<((append?:boolean)=>Promise<void>)|null>(null);
 snapshot.current=value;
 const back=publicAccountReturn(history.state);
 useEffect(()=>{
  let active=true,working=false,serial=0;loadedPages.current=1;setValue(null);setError('');setLoading(true);
  const read=async(append=false)=>{
   if(!active||working||document.hidden||navigator.onLine===false)return;
   working=true;const ticket=++serial,current=()=>active&&serial===ticket&&navigator.onLine!==false;setBusy(true);
   try{
    const authority=endpoint??(await loadWebConfiguration()).endpoint,client=createOfficialAccountClient({endpoint:authority});
    let result:PublicAccount;
    if(append){
     const previous=snapshot.current,cursor=previous?.posts?.nextAfter;if(!previous||!cursor)return;
     const page=await client.publicPosts(accountId,{after:cursor}) as PublicPosts;
     if(!current())return;
     if(!Array.isArray(page.items)||page.nextAfter===cursor)throw Error();
     result={...previous,posts:{...page,items:[...new Map([...(previous.posts?.items??[]),...page.items].map(item=>[item.locator.postId,item])).values()]}};
     loadedPages.current++;
    }else{
     result=await client.publicAccount(accountId) as PublicAccount;
     if(result.accountId!==accountId||typeof result.displayName!=='string'&&result.displayName!==null||result.typeSource!=='account-owner-statement')throw Error();
     if(result.posts){
      let page=result.posts,cursor=page.nextAfter;const items=[...page.items],seen=new Set<string>();
      for(let index=1;index<loadedPages.current&&cursor;index++){
       if(seen.has(cursor))throw Error();seen.add(cursor);
       page=await client.publicPosts(accountId,{after:cursor}) as PublicPosts;if(!current())return;
       if(!Array.isArray(page.items))throw Error();items.push(...page.items);cursor=page.nextAfter;
      }
      result={...result,posts:{...page,items:[...new Map(items.map(item=>[item.locator.postId,item])).values()]}};
     }
    }
    if(current()){setValue(result);setError('');setNow(Math.floor(Date.now()/1000));}
   }catch{if(current()){setValue(null);setError('此账户未开放查询，或资料当前不可读取。');}}
   finally{if(active&&serial===ticket){working=false;setLoading(false);setBusy(false);}}
  };
  request.current=read;
  const visible=()=>{if(!document.hidden)void read();},offline=()=>{if(active){serial++;working=false;setLoading(false);setBusy(false);setValue(null);setError('暂时离线，联网后自动恢复。');}};
  if(navigator.onLine===false)offline();else void read();
  const timer=window.setInterval(visible,30000);document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);window.addEventListener('online',visible);window.addEventListener('offline',offline);
  return()=>{active=false;request.current=null;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);window.removeEventListener('online',visible);window.removeEventListener('offline',offline);};
 },[accountId,endpoint,attempt]);
 useEffect(()=>{if(!value?.posts?.nextAfter||!more.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))void request.current?.(true);},{rootMargin:'300px'});observer.observe(more.current);return()=>observer.disconnect();},[value?.posts?.nextAfter,busy]);
 const deadline=Math.min(...(value?.posts?.items??[]).flatMap(item=>typeof item.publishedUntil==='number'&&item.publishedUntil>now?[item.publishedUntil]:[]));
 useEffect(()=>{if(!Number.isFinite(deadline))return;const timer=window.setTimeout(()=>setNow(Math.floor(Date.now()/1000)),Math.min(2147483647,Math.max(0,deadline*1000-Date.now()+1)));return()=>window.clearTimeout(timer);},[deadline]);
 return <section className="public-online-account" aria-busy={busy}>
  <a className="back-link" href={back} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();(onReturn??navigate)(back);}}}>{profileReturnLabel(back)}</a>
  {loading&&<output>正在加载账户资料…</output>}
  {error&&<div className="message"><h1>账户资料暂不可读</h1><p>{error}</p><Button variant="outline" onClick={()=>setAttempt(value=>value+1)}>重试</Button></div>}
  {value&&<>
   <header className="public-online-account-heading"><UserRound size={28}/><div><h1>{value.displayName||'银河账户'}</h1>{value.uid&&<p className="account-uid"><span>UID</span> <code>{value.uid}</code></p>}<p>{({person:'个人账户',organization:'组织账户',agent:'Agent 账户'} as Record<string,string>)[value.subjectType??'']??'主体类型尚未记录'} · 账户持有者声明</p></div></header>
   {value.publicQuery?.showLinkedIds&&<PublicLinkedIds key={'ids:'+accountId} accountId={accountId} endpoint={endpoint} navigate={navigate}/>}
   {value.publicQuery?.showExternalCredentials&&<PublicExternalCredentials key={'credentials:'+accountId} accountId={accountId} endpoint={endpoint}/>}
   {value.posts&&<section><h2>公开发表的内容</h2>{value.posts.items.filter(item=>availableForumContent(item,now)).map(item=>{const path=forumVersionPath(item.locator.postId,item.locator.versionId??item.currentVersionId)??'/app/community';return <article key={item.locator.postId} className="public-account-post"><h3><a href={path} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}>{item.payload?.title}</a></h3><p>{item.payload?.body.slice(0,220)}</p></article>;})}{!value.posts.items.some(item=>availableForumContent(item,now))&&(value.posts.nextAfter?<output>正在加载可公开的帖子…</output>:<p>当前没有可展示的公开帖子。</p>)}<div ref={more}>{value.posts.nextAfter&&<Button variant="ghost" disabled={busy} onClick={()=>void request.current?.(true)}>{busy?'正在加载…':'更多帖子'}</Button>}</div></section>}
  </>}
 </section>;
}
