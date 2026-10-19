import React,{useEffect,useState} from 'react';
import {UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createOfficialAccountClient} from './official-account-client.mjs';
import {loadWebConfiguration} from './runtime.mjs';
import {availableForumContent,type ForumPostView} from './community-forum-view-types';
import {forumVersionPath} from './community-forum-origin.mjs';
import {PublicLinkedIds,PublicExternalCredentials} from './public-account-relations';
import './online-account-settings.css';

type PublicAccount={accountId:string;displayName:string|null;subjectType:'person'|'organization'|'agent'|null;typeSource:'account-owner-statement';publicQuery?:{showLinkedIds:boolean;showExternalCredentials:boolean};posts?:{items:ForumPostView[];scanTruncated:boolean;checkedAt:number}};
export function PublicAccountWorkspace({accountId,endpoint,navigate}:{accountId:string;endpoint?:string;navigate:(path:string)=>void}){
 const [value,setValue]=useState<PublicAccount|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0),[now,setNow]=useState(()=>Math.floor(Date.now()/1000));
 useEffect(()=>{let active=true,working=false,serial=0;const read=async()=>{if(!active||working||document.hidden||navigator.onLine===false)return;working=true;const ticket=++serial,current=()=>active&&serial===ticket&&navigator.onLine!==false;
   try{const authority=endpoint??(await loadWebConfiguration()).endpoint,client=createOfficialAccountClient({endpoint:authority}),result=await client.publicAccount(accountId) as PublicAccount;
    if(result.accountId!==accountId||typeof result.displayName!=='string'&&result.displayName!==null||result.typeSource!=='account-owner-statement')throw Error();
    if(current()){setValue(result);setError('');setNow(Math.floor(Date.now()/1000));}
   }catch{if(current()){setValue(null);setError('此账户未开放查询，或资料当前不可读取。');}}finally{if(active&&serial===ticket){working=false;setLoading(false);}}
  };const visible=()=>{if(!document.hidden)void read();},offline=()=>{if(active){serial++;working=false;setLoading(false);setValue(null);setError('暂时离线，联网后重新读取当前允许的资料。');}};
  if(navigator.onLine===false)offline();else void read();const timer=window.setInterval(visible,30000);document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);window.addEventListener('online',visible);window.addEventListener('offline',offline);
  return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);window.removeEventListener('online',visible);window.removeEventListener('offline',offline);};
 },[accountId,endpoint,attempt]);
 const deadline=Math.min(...(value?.posts?.items??[]).flatMap(item=>typeof item.publishedUntil==='number'&&item.publishedUntil>now?[item.publishedUntil]:[]));
 useEffect(()=>{if(!Number.isFinite(deadline))return;const timer=window.setTimeout(()=>setNow(Math.floor(Date.now()/1000)),Math.min(2147483647,Math.max(0,deadline*1000-Date.now()+1)));return()=>window.clearTimeout(timer);},[deadline]);
 return <section className="public-online-account"><button className="back-link" onClick={()=>navigate('/app/community')}>返回社区</button>{loading&&<output>正在读取公开账户资料…</output>}{error&&<div className="message"><h1>账户资料暂不可读</h1><p>{error}</p><Button variant="outline" onClick={()=>{setLoading(true);setAttempt(value=>value+1);}}>重新读取</Button></div>}{value&&<><header className="public-online-account-heading"><UserRound size={28}/><div><h1>{value.displayName||'银河账户'}</h1><p>{({person:'个人账户',organization:'组织账户',agent:'Agent 账户'} as Record<string,string>)[value.subjectType??'']??'主体类型尚未记录'} · 账户持有者声明</p></div></header>{value.publicQuery?.showLinkedIds&&<PublicLinkedIds key={'ids:'+accountId} accountId={accountId} endpoint={endpoint} navigate={navigate}/>} {value.publicQuery?.showExternalCredentials&&<PublicExternalCredentials key={'credentials:'+accountId} accountId={accountId} endpoint={endpoint}/>} {value.posts&&<section><h2>公开发表的内容</h2>{value.posts.items.filter(item=>availableForumContent(item,now)).map(item=>{const path=forumVersionPath(item.locator.postId,item.locator.versionId??item.currentVersionId)??'/app/community';return <article key={item.locator.postId} className="public-account-post"><h3><a href={path} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}>{item.payload?.title}</a></h3><p>{item.payload?.body.slice(0,220)}</p></article>;})}{!value.posts.items.some(item=>availableForumContent(item,now))&&<p>当前没有可展示的公开帖子。</p>}{value.posts.scanTruncated&&<p>这里列出当前取得的内容，可到社区继续浏览。</p>}</section>}</>}</section>;
}
