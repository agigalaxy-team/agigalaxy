import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Bell,Check} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {OfficialAccountStatus,useOfficialAccountSession,type OfficialSession} from './official-account-panel';
import {forumVersionPath} from './community-forum-origin.mjs';
import type {ForumNotification} from './community-forum-view-types';
import {MemberAvatar} from './conversation-ui';
import {LoadingFeedback,ReadFailure} from './interaction-feedback';
import {useReadTasks} from './use-read-task';

type Model=ReturnType<typeof useOfficialAccountSession>;
type Item=ForumNotification&{readUntil:number};
const deadline=(value:Item)=>Math.min(value.readUntil,typeof value.sourceExpiresAt==='number'?value.sourceExpiresAt:Date.parse(value.sourceExpiresAt)/1000);
export function AccountReplyNotifications({endpoint,navigate,secondary=false}:{endpoint?:string;navigate:(path:string)=>void;secondary?:boolean}){
 const model=useOfficialAccountSession(endpoint),session=model.session;
 return <section className="account-reply-notifications" aria-label="账户通知">{!secondary&&<h1 className="small message-page-title">通知</h1>}{!session&&<OfficialAccountStatus model={model} navigate={navigate} returnTo="/app/notifications" compact/>}{session?.account.id&&model.client&&<React.Fragment key={session.account.id+':'+session.csrfToken}>
  <AccountServiceNotices client={model.client} session={session} navigate={navigate} refreshSession={model.refresh}/>
  <section aria-label="社区回复"><h2 className="small">社区回复</h2><AccountReplyList client={model.client} session={session} navigate={navigate}/></section>
 </React.Fragment>}</section>;
}

type ServiceNotice={noticeId:string;kind:'service-notice';purpose:'maintenance'|'service-update'|'community-update';title:string;body:string;href:string|null;at:string;expiresAt:string;read:boolean;source:{kind:'business-operator';serviceEndpoint:string}};
type ReadServiceNotice=ServiceNotice&{readUntil:number};
type ServiceNoticePage={items:ServiceNotice[];nextAfter:string|null;checkedAt:number};
const noticeCode=(reason:unknown)=>reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';
const noticeHref=(value:unknown):value is string=>typeof value==='string'&&value.length<=2048&&value.startsWith('/')&&!value.startsWith('//')&&!/[\s\\\p{Cc}]/u.test(value);
function serviceNoticePage(value:unknown):ServiceNoticePage{
 if(!value||typeof value!=='object'||!('items'in value)||!Array.isArray(value.items)||value.items.length>100||!('nextAfter'in value)||value.nextAfter!==null&&(typeof value.nextAfter!=='string'||!/^[1-9][0-9]{0,18}$/.test(value.nextAfter))||!('checkedAt'in value)||typeof value.checkedAt!=='number')throw Error('Invalid notice response');
 for(const item of value.items){
  if(!item||typeof item!=='object'||typeof item.noticeId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.noticeId)||item.kind!=='service-notice'||!['maintenance','service-update','community-update'].includes(item.purpose)
   ||typeof item.title!=='string'||item.title.length>160||typeof item.body!=='string'||item.body.length>8000||typeof item.read!=='boolean'||typeof item.at!=='string'||!Number.isFinite(Date.parse(item.at))||typeof item.expiresAt!=='string'||!Number.isFinite(Date.parse(item.expiresAt))
   ||item.href!==null&&!noticeHref(item.href)||item.source?.kind!=='business-operator'||typeof item.source?.serviceEndpoint!=='string')throw Error('Invalid notice response');
 }
 return value as ServiceNoticePage;
}

function AccountServiceNotices({client,session,navigate,refreshSession}:{client:NonNullable<Model['client']>;session:OfficialSession;navigate:(path:string)=>void;refreshSession:()=>Promise<void>}){
 const tasks=useReadTasks('account-notices:'+session.account.id),life=useRef({active:false,generation:0}),pages=useRef(1),more=useRef<HTMLDivElement>(null),writes=useRef(new Set<string>()),failedWrites=useRef(new Map<string,ServiceNotice>()),confirmedRead=useRef(new Set<string>());
 const [items,setItems]=useState<ReadServiceNotice[]>([]),[next,setNext]=useState<string|null>(null),[unread,setUnread]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[now,setNow]=useState(()=>Date.now()/1000),[pending,setPending]=useState(new Set<string>()),[writeErrors,setWriteErrors]=useState<Record<string,string>>({});
 const load=useCallback(async(after?:string)=>{
  if(tasks.isPending('notices'))return;
  if(navigator.onLine===false){setLoading(false);setError('暂时离线，联网后自动恢复。');return;}
  await tasks.run({lane:'notices',key:JSON.stringify([unread,after??'head'])},async({signal})=>{
   let cursor=after,last:string|null=null;const values:ReadServiceNotice[]=[],seen=new Set<string>();
   for(let page=0;page<(after?1:pages.current);page++){
    const startedAt=Date.now()/1000,query=new URLSearchParams({limit:'20',unreadOnly:String(unread),...(cursor?{after:cursor}:{})});
    const response=serviceNoticePage(await client.call('/v1/account/notifications/notices?'+query,undefined,{method:'GET',session,signal}));
    values.push(...response.items.map(item=>({...item,readUntil:Math.min(startedAt+15,Date.parse(item.expiresAt)/1000)})));last=response.nextAfter;
    if(!last)break;if(last===cursor||seen.has(last))throw Error('Invalid notice page');seen.add(last);cursor=last;
   }
   return {values,last};
  },{onStart:()=>setLoading(true),onSuccess:({values:incoming,last})=>{
    const values=incoming.map(item=>({...item,read:item.read||confirmedRead.current.has(item.noticeId)}));
    if(after)pages.current++;
    setItems(previous=>after?[...new Map([...previous,...values].map(item=>[item.noticeId,item])).values()]:values);setNext(last);setNow(Date.now()/1000);setError('');
    for(const value of values)if(value.read)failedWrites.current.delete(value.noticeId);
    setWriteErrors(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>failedWrites.current.has(id))));
   },onError:reason=>{
    setError(noticeCode(reason)==='official_account_session_expired'?'登录已过期，正在重新连接账户。':'银河通知暂时无法加载，联网后会继续。');
    if(noticeCode(reason)==='official_account_session_expired')void refreshSession();
   },onSettled:()=>setLoading(false)});
 },[client,session,unread,tasks,refreshSession]);
 useEffect(()=>{const current=life.current;current.active=true;return()=>{current.active=false;current.generation++;};},[]);
 useEffect(()=>{
  const refresh=()=>{if(!document.hidden&&navigator.onLine!==false)void load();},offline=()=>{tasks.cancel('notices');setLoading(false);setError('暂时离线，联网后自动恢复。');};
  if(navigator.onLine===false)offline();else refresh();
  const timer=window.setInterval(refresh,12000),clock=window.setInterval(()=>setNow(Date.now()/1000),1000);
  window.addEventListener('online',refresh);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',refresh);
  return()=>{tasks.cancel('notices');window.clearInterval(timer);window.clearInterval(clock);window.removeEventListener('online',refresh);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',refresh);};
 },[load,tasks]);
 useEffect(()=>{
  if(!next||!more.current||typeof IntersectionObserver==='undefined')return;
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))void load(next);},{rootMargin:'250px'});observer.observe(more.current);return()=>observer.disconnect();
 },[next,items,load]);
 const markRead=useCallback(async(value:ServiceNotice)=>{
  if(value.read||writes.current.has(value.noticeId))return;
  const generation=life.current.generation;writes.current.add(value.noticeId);failedWrites.current.delete(value.noticeId);setPending(new Set(writes.current));setWriteErrors(previous=>{const result={...previous};delete result[value.noticeId];return result;});
  try{
   const response=await client.call('/v1/account/notifications/notices/'+value.noticeId+'/read',{}, {session}) as {noticeId:string;read:boolean};
   if(response.noticeId!==value.noticeId||response.read!==true)throw Error('Invalid notice receipt');
   if(life.current.active&&generation===life.current.generation){confirmedRead.current.add(value.noticeId);setItems(previous=>previous.map(item=>item.noticeId===value.noticeId?{...item,read:true}:item));}
  }catch(reason){
   if(!life.current.active||generation!==life.current.generation)return;
   if(noticeCode(reason)==='operations_notice_not_found'){setItems(previous=>previous.filter(item=>item.noticeId!==value.noticeId));setError('这条通知当前不可读取。');void load();}
   else{failedWrites.current.set(value.noticeId,value);setWriteErrors(previous=>({...previous,[value.noticeId]:'暂未确认已读状态，可以重试。'}));if(noticeCode(reason)==='official_account_session_expired')void refreshSession();}
  }finally{writes.current.delete(value.noticeId);if(life.current.active&&generation===life.current.generation)setPending(new Set(writes.current));}
 },[client,session,load,refreshSession]);
 useEffect(()=>{
  const resume=()=>{for(const value of failedWrites.current.values())void markRead(value);};
  window.addEventListener('online',resume);return()=>window.removeEventListener('online',resume);
 },[markRead]);
 const visible=items.filter(item=>item.readUntil>now&&(!unread||!item.read));
 const filter=(value:boolean)=>{if(value===unread)return;tasks.cancel('notices');pages.current=1;setUnread(value);setItems([]);setNext(null);setError('');setLoading(true);};
 return <section aria-label="银河通知"><h2 className="small">银河通知</h2>
  <div className="notification-filter" aria-label="银河通知筛选"><button type="button" aria-pressed={!unread} onClick={()=>filter(false)}>全部</button><button type="button" aria-pressed={unread} onClick={()=>filter(true)}>未读</button></div>
  <ReadFailure message={error} onRetry={()=>load()} retrying={tasks.isPending('notices')}/>
  <LoadingFeedback active={loading} label="正在加载银河通知…" scopeKey="account-notices"/>
  <div className="notification-list">{visible.map(value=><article key={value.noticeId} className={value.read?'':'unread'} aria-busy={pending.has(value.noticeId)}><span className="notification-type" aria-hidden="true"><Bell size={20}/></span><div className="notification-content">
   <h2>{value.href?<a href={value.href} onClick={event=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();void markRead(value);navigate(value.href!);}}>{value.title}</a>:value.title}</h2>
   <div className="forum-prose" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:14,lineHeight:1.8,marginBottom:8}}>{value.body}</div>
   <p><span>AGI Galaxy</span><time dateTime={value.at}>{new Date(value.at).toLocaleString('zh-CN')}</time><span>{pending.has(value.noticeId)?'正在标记…':value.read?'已读':'未读'}</span></p>
   {writeErrors[value.noticeId]&&<ReadFailure message={writeErrors[value.noticeId]} onRetry={()=>markRead(value)} retrying={pending.has(value.noticeId)} retryLabel="重试"/>}
  </div><div className="notification-row-actions">{!value.read&&<button type="button" className="icon-button notification-read" aria-label={'标为已读：'+value.title} disabled={pending.has(value.noticeId)} onClick={()=>void markRead(value)}><Check size={18}/></button>}</div></article>)}</div>
  {!loading&&!error&&!visible.length&&<p className="empty-state">{unread?'没有未读的银河通知。':items.length?'正在更新银河通知…':'暂时没有银河通知。'}</p>}
  <div ref={more}>{next&&<Button variant="ghost" onClick={()=>void load(next)}>更多银河通知</Button>}</div>
 </section>;
}
function AccountReplyList({client,session,navigate}:{client:NonNullable<Model['client']>;session:OfficialSession;navigate:(path:string)=>void}){
  const [items,setItems]=useState<Item[]>([]),[next,setNext]=useState<string|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[now,setNow]=useState(()=>Date.now()/1000),more=useRef<HTMLDivElement>(null),life=useRef(true),reading=useRef(false),pages=useRef(1),ticket=useRef(0),opening=useRef(0),failedOpen=useRef<Item|null>(null);
 async function load(after?:string){if(reading.current)return;reading.current=true;const request=++ticket.current,startedAt=Date.now()/1000;try{let cursor=after,last:string|null=null;const values:Item[]=[];for(let page=0;page<(after?1:pages.current);page++){const response=await client.call('/v2/community/notifications/query',{...(cursor?{after:cursor}:{}),limit:20},{session}) as {items:ForumNotification[];nextAfter:string|null};if(!life.current||request!==ticket.current)return;values.push(...response.items.map(value=>({...value,readUntil:startedAt+15})));last=response.nextAfter;if(!last)break;if(last===cursor)throw Error();cursor=last;}if(after)pages.current++;setItems(old=>after?[...new Map([...old,...values].map(value=>[value.replyId,value])).values()]:values);setNext(last);setNow(Date.now()/1000);setError('');}catch{if(life.current&&request===ticket.current)setError('回复暂时无法加载，联网后会继续。');}finally{reading.current=false;if(life.current&&request===ticket.current)setLoading(false);}}
 useEffect(()=>{life.current=true;const refresh=()=>{if(!document.hidden&&navigator.onLine!==false)void load();},offline=()=>{ticket.current++;setItems([]);setError('暂时离线，联网后自动恢复。');};refresh();const timer=setInterval(refresh,12000),clock=setInterval(()=>setNow(Date.now()/1000),1000);window.addEventListener('online',refresh);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',refresh);return()=>{life.current=false;ticket.current++;clearInterval(timer);clearInterval(clock);window.removeEventListener('online',refresh);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',refresh);};},[client,session.account.id,session.csrfToken]);
 useEffect(()=>{if(!next||!more.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(value=>value.isIntersecting))void load(next);},{rootMargin:'250px'});observer.observe(more.current);return()=>observer.disconnect();},[next,items]);
  async function open(value:Item){const request=++opening.current;failedOpen.current=null;try{await client.call('/v2/community/notifications/read',{replyId:value.replyId},{session});if(life.current&&request===opening.current)navigate(forumVersionPath(value.postId,value.postVersionId)+'#reply-'+value.replyId);}catch(reason){if(life.current&&request===opening.current){const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';if(code==='not_found'){setItems(old=>old.filter(item=>item.replyId!==value.replyId));setError('这条回复当前不可读取。');void load();}else{failedOpen.current=value;setError(navigator.onLine===false?'暂时离线，联网后可以继续打开这条回复。':'暂时无法打开这条回复，通知仍保留。');}}}}
 const visible=items.filter(value=>deadline(value)>now);
  return <>{error&&<p role="alert" className="message error">{error}<Button variant="ghost" onClick={()=>void(failedOpen.current?open(failedOpen.current):load())}>重试</Button></p>}{loading&&<output>正在加载通知…</output>}<div className="notification-list">{visible.map(value=><article key={value.replyId} className={value.read?'':'unread'}><MemberAvatar subjectId={value.authorAccountId??value.authorId??undefined} name={value.author?.displayName??undefined}/><div className="notification-content"><h2><button type="button" onClick={()=>void open(value)}>{value.title}</button></h2>{value.author?.displayName&&<span>{value.author.displayName}</span>}<p>{value.preview}</p><time>{new Date(typeof value.at==='number'?value.at*1000:value.at).toLocaleString('zh-CN')}</time></div></article>)}</div>{!loading&&!error&&!visible.length&&(items.length?<output>正在更新通知…</output>:<p className="empty-state">暂时没有回复通知。</p>)}<div ref={more}>{next&&<Button variant="ghost" onClick={()=>void load(next)}>更多通知</Button>}</div></>;
}
