import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {z} from 'zod/v4';
import {UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {AccountEntryPage} from '../../account-center';
import {useReadTasks} from '../../use-read-task';
import {accountFollowPageSchema} from '../../../../galaxy-official/src/shared/account-follows-schema.mjs';
import {AccountFollowControl,accountFollowMessage,useAccountFollows} from './controls';
import './account-follows.css';

type Page=z.infer<typeof accountFollowPageSchema>;
const target=(after:string|null)=>'/app/account?section=following'+(after?'&after='+encodeURIComponent(after):'');
const plain=(event:React.MouseEvent<HTMLAnchorElement>)=>event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey;
export function AccountFollowsWorkspace({endpoint,navigate,search=''}:{endpoint?:string;navigate:(path:string)=>void;search?:string}){
 const {model,memory,lease,client,available}=useAccountFollows(endpoint),parameters=useMemo(()=>new URLSearchParams(search),[search]),after=parameters.get('after'),
  [page,setPage]=useState<Page|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pendingCount,setPendingCount]=useState(0),
  heading=useRef<HTMLHeadingElement>(null),returnFocus=useRef<Element|null>(null),readPage=useRef<(()=>void)|null>(null);
 const tasks=useReadTasks('account-follow-page:'+(client?.ownerId??'visitor')+':'+(model.session?.csrfToken??'')+':'+(after??''));
 const refresh=useCallback(()=>readPage.current?.(),[]);
 useLayoutEffect(()=>{if(page&&returnFocus.current){if(document.activeElement===document.body||document.activeElement===returnFocus.current)heading.current?.focus({preventScroll:true});returnFocus.current=null;}},[page]);
 useEffect(()=>{
  let active=true,working=false,timer:ReturnType<typeof setTimeout>|undefined,expiry:ReturnType<typeof setTimeout>|undefined,blocked=false;
  setPage(null);setError('');setBusy(false);setPendingCount(client?.pendingAll().length??0);
  const read=()=>{
   if(!active||!client||!available||working||blocked||document.hidden||navigator.onLine===false)return;
   working=true;setBusy(true);
   void tasks.run({lane:'page',key:after??'first'},({signal})=>client.query(after?{after}:{},{signal}),{
    onSuccess:value=>{setPage(value);setError('');setPendingCount(client.pendingAll().length);if(expiry)clearTimeout(expiry);expiry=setTimeout(()=>{if(active)setPage(null);},Math.max(0,value.readExpiresAt*1000-Date.now()));},
    onError:problem=>{setPage(null);setError(accountFollowMessage(problem));const status=problem&&typeof problem==='object'&&'status'in problem?Number(problem.status):0;if(status===401||status===403){blocked=true;void model.refresh();}},
    onSettled:()=>{working=false;setBusy(false);if(active&&!blocked)timer=setTimeout(read,client.pendingAll().length?5000:25000);},
   });
  };
  readPage.current=()=>{blocked=false;if(timer)clearTimeout(timer);read();};
  const offline=()=>{tasks.cancel();working=false;setBusy(false);setPage(null);setError('暂时离线，联网后继续读取。');},visible=()=>{if(timer)clearTimeout(timer);read();};
  if(navigator.onLine===false)offline();else read();
  window.addEventListener('offline',offline);window.addEventListener('online',visible);window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;readPage.current=null;tasks.cancel();if(timer)clearTimeout(timer);if(expiry)clearTimeout(expiry);window.removeEventListener('offline',offline);window.removeEventListener('online',visible);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
 },[client,available,after,tasks]);
 if(model.phase==='signed-out')return <AccountEntryPage navigate={navigate} returnTo={target(after)}/>;
 const previous=after&&lease?memory.previousFollowingPage(lease,after):undefined;
 const link=(path:string,label:string,before?:()=>void)=><a href={path} onClick={event=>{if(plain(event)){event.preventDefault();before?.();navigate(path);}}}>{label}</a>;
 return <section className="account-follows-page" aria-busy={busy}>
  <header className="account-page-heading"><h1 ref={heading} tabIndex={-1}>我的关注</h1></header>
  {!available&&model.phase!=='loading'&&<div className="message" role="status"><p>{model.phase==='offline'?'暂时离线，联网后继续读取。':'账户暂时无法连接。'}</p><Button type="button" variant="outline" onClick={()=>void model.refresh()}>重试读取</Button></div>}
  {!page&&!error&&(available||model.phase==='loading')&&<output>正在读取关注…</output>}
  {error&&<div className="message" role="status"><p>{error}</p><Button type="button" variant="outline" onClick={refresh}>重试读取</Button></div>}
  {available&&pendingCount>0&&<output className="account-follow-message">正在保存关注…</output>}
  {page&&page.items.length===0&&<p>{after?'这页已没有关注。':'还没有关注的账户。可以从公开资料页关注想继续阅读的作者。'}</p>}
  {page&&page.items.length>0&&<ul className="account-follows-list">{page.items.map(item=>{
   const profile=item.source.state==='available'?item.source.profile:null,label=profile?(profile.displayName||profile.uid||'银河账户'):'资料当前不可读取';
   return <li key={item.relationship.id??item.relationship.targetAccountId}>
    <div className="account-follow-person"><UserRound size={22} aria-hidden="true"/><div><h2>{profile?link('/app/accounts/'+profile.accountId,label):label}</h2>{profile?.uid&&profile.displayName!==profile.uid&&<p className="account-uid"><span>UID</span> <code>{profile.uid}</code></p>}</div></div>
    <AccountFollowControl endpoint={endpoint} targetAccountId={item.relationship.targetAccountId} initialRelationship={item.relationship} initialCanFollow={!!profile} showDirectoryLink={false} onChanged={(following,focused)=>{if(!following&&focused)returnFocus.current=document.activeElement;refresh();}}/>
   </li>;
  })}</ul>}
  {(after||page?.nextAfter)&&<nav className="account-follows-pagination" aria-label="关注列表分页">
   {after&&link(target(previous??null),previous===undefined?'回到开始':'上一页')}
   {page?.nextAfter&&link(target(page.nextAfter),'下一页',()=>{if(lease&&page.nextAfter)memory.rememberFollowingPage(lease,page.nextAfter,after);})}
  </nav>}
 </section>;
}
