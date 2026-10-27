import React,{useCallback,useEffect,useEffectEvent,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {z} from 'zod/v4';
import {UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {AccountEntryPage} from "../accounts/account-center";
import {useQueryReads} from "../../application/query-reads";
import {accountFollowPageSchema} from '../../../../galaxy-official/src/shared/account-follows-schema.mjs';
import {AccountFollowControl,accountFollowMessage,useAccountFollows} from './controls';
import './account-follows.css';

type Page=z.infer<typeof accountFollowPageSchema>;
const target=(after:string|null)=>'/app/account?section=following'+(after?'&after='+encodeURIComponent(after):'');
const plain=(event:React.MouseEvent<HTMLAnchorElement>)=>event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey;
export function AccountFollowsWorkspace({endpoint,navigate,search=''}:{endpoint?:string;navigate:(path:string)=>void;search?:string}){
 const {model,memory,lease,client,available,scope}=useAccountFollows(endpoint),parameters=useMemo(()=>new URLSearchParams(search),[search]),after=parameters.get('after'),
  [page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pendingCount,setPendingCount]=useState(0),
  heading=useRef<HTMLHeadingElement>(null),returnFocus=useRef<Element|null>(null),readPage=useRef<(()=>void)|null>(null);
 const tasks=useQueryReads(scope,'follows','page:'+ (model.session?.csrfToken??''));
 const refresh=useCallback(()=>readPage.current?.(),[]);
 useLayoutEffect(()=>{if(page&&returnFocus.current){if(document.activeElement===document.body||document.activeElement===returnFocus.current)heading.current?.focus({preventScroll:true});returnFocus.current=null;}},[page]);
 const refreshAccount=useEffectEvent(()=>model.refresh());
 useEffect(()=>{
  let active=true,working=false,expiry:ReturnType<typeof setTimeout>|undefined,blocked=false;
  setPage(null);setError('');setBusy(false);setPendingCount(client?.pendingAll().length??0);
  const read=(force=false)=>{
   if(!active||!client||!available||working||blocked||navigator.onLine===false)return;
   working=true;setBusy(true);
   void tasks.run({lane:'page',key:after??'first'},({signal})=>client.query(after?{after}:{},{signal}),{
    force,validUntil:value=>value.readExpiresAt*1000,onSuccess:value=>{setPage(value);setError('');setPendingCount(client.pendingAll().length);if(expiry)clearTimeout(expiry);expiry=setTimeout(()=>{if(active){setPage(null);read(true);}},Math.max(0,value.readExpiresAt*1000-Date.now()));},
    onError:problem=>{setPage(null);setError(accountFollowMessage(problem));const status=problem&&typeof problem==='object'&&'status'in problem?Number(problem.status):0;if(status===401||status===403){blocked=true;void refreshAccount();}},
    onSettled:()=>{working=false;setBusy(false);},
   });
  };
  readPage.current=()=>{blocked=false;read(true);};
  const offline=()=>{tasks.cancel();working=false;setBusy(false);setPage(null);setError('暂时离线，联网后继续读取。');},visible=()=>{read();};
  if(navigator.onLine===false)offline();else read();
  window.addEventListener('offline',offline);window.addEventListener('online',visible);
  return()=>{active=false;readPage.current=null;tasks.cancel();if(expiry)clearTimeout(expiry);window.removeEventListener('offline',offline);window.removeEventListener('online',visible);};
 },[client,available,after,tasks]);
 const currentPage=page?.accountId===client?.ownerId?page:null;
 if(model.phase==='signed-out')return <AccountEntryPage navigate={navigate} returnTo={target(after)}/>;
 const previous=after&&lease?memory.previousFollowingPage(lease,after):undefined;
 const link=(path:string,label:string,before?:()=>void)=><a href={path} onClick={event=>{if(plain(event)){event.preventDefault();before?.();navigate(path);}}}>{label}</a>;
 return <section className="account-follows-page" aria-busy={busy}>
  <header className="account-page-heading"><h1 ref={heading} tabIndex={-1}>我的关注</h1></header>
  {!available&&model.phase!=='loading'&&<output className="message" ><p>{model.phase==='offline'?'暂时离线，联网后继续读取。':'账户暂时无法连接。'}</p><Button type="button" variant="outline" onClick={()=>void model.refresh()}>重试读取</Button></output>}
  {!currentPage&&!error&&(available||model.phase==='loading')&&<output>正在读取关注…</output>}
  {error&&<output className="message" ><p>{error}</p><Button type="button" variant="outline" onClick={refresh}>重试读取</Button></output>}
  {available&&pendingCount>0&&<output className="account-follow-message">正在保存关注…</output>}
  {currentPage&&currentPage.items.length===0&&<p>{after?'这页已没有关注。':'还没有关注的账户。可以从公开资料页关注想继续阅读的作者。'}</p>}
  {currentPage&&currentPage.items.length>0&&<ul className="account-follows-list">{currentPage.items.map(item=>{
   const profile=item.source.state==='available'?item.source.profile:null,label=profile?(profile.displayName||profile.uid||'银河账户'):'资料当前不可读取';
   return <li key={item.relationship.id??item.relationship.targetAccountId}>
    <div className="account-follow-person"><UserRound size={22} aria-hidden="true"/><div><h2>{profile?link('/app/accounts/'+profile.accountId,label):label}</h2>{profile?.uid&&profile.displayName!==profile.uid&&<p className="account-uid"><span>UID</span> <code>{profile.uid}</code></p>}</div></div>
    <AccountFollowControl endpoint={endpoint} targetAccountId={item.relationship.targetAccountId} initialRelationship={item.relationship} initialCanFollow={!!profile} showDirectoryLink={false} onChanged={(following,focused)=>{if(!following&&focused)returnFocus.current=document.activeElement;refresh();}}/>
   </li>;
  })}</ul>}
  {(after||currentPage?.nextAfter)&&<nav className="account-follows-pagination" aria-label="关注列表分页">
   {after&&link(target(previous??null),previous===undefined?'回到开始':'上一页')}
   {currentPage?.nextAfter&&link(target(currentPage.nextAfter),'下一页',()=>{if(lease&&currentPage.nextAfter)memory.rememberFollowingPage(lease,currentPage.nextAfter,after);})}
  </nav>}
 </section>;
}
