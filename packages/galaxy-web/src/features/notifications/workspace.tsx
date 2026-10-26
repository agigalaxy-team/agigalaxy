import {useCurrentTaskMaterialTree} from "../tasks/materials/task-material-view";
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {mergeNotificationItems,notificationRows,markNotificationRowRead} from './merge.mjs';
import {createNotificationLoader} from './loader.mjs';
import {leaseNotificationItems,currentNotificationItems} from './read-lease.mjs';
import {PageLoading} from '../../site-shell';
import {notificationTarget} from './target.mjs';
import {Bell,BellOff,Check,FileText,MessageCircle,Settings2,X} from 'lucide-react';
import {MessageNavigation,readableTime,useMemberNames,memberName} from "../../shared/people/conversation-ui";
import {NotificationSettings} from './settings';
import {AccountReplyNotifications} from './account-replies';
import "../chat/selected-messages.css";
import {applyNotificationChanges,saveNotificationSelection} from './settings-model.mjs';
type Runtime=Awaited<ReturnType<typeof import('../../runtime.mjs').createWebRuntime>>;
type Item={id:string;at:string;read:boolean;quiet:boolean;interruptiveEligible:boolean;presented:boolean;eventKind:string;title:string;actorId?:string;sourceExpiresAt?:string;object:{type:string;id:string;messageId?:string;roomId?:string}};
type ReadItem=Item&{readUntil:number};
type Options={revision:number;settings:import('zod/v4').infer<typeof import('../../../../galaxy-official/src/shared/notification-inbox-schema.mjs').inboxOptionsSchema>;externalDelivery:'disabled'};
type Page={items:Item[];nextAfter:string|null;lastCheckedAt:string};
type Prompt={item:ReadItem;claimId:string;deliveryClientId:string;lease:number;leaseUntil:string};
type Props={runtime:Runtime|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void};
const readableError=(reason:unknown,fallback:string)=>reason instanceof Error&&reason.message.trim()?reason.message:fallback;
const kinds:Record<string,string>={'qualification-permission-request':'材料使用请求','qualification-permission-decline':'原作者已拒绝许可请求','qualification-permission-cancel':'申请者已取消许可请求','qualification-permission-record-permission':'原作者已关联限定许可','room-message':'对话消息','room-invitation':'对话邀请','information-change':'关注的信息发生变化',dispute:'任务争议','confirm-resolution':'结果回应','propose-resolution':'交付建议'};
export function NotificationWorkspace(props:Props){
 const connection=props.runtime?.api.snapshot();
 return <NotificationSession key={JSON.stringify([props.runtime?.api.endpoint,props.subjectId,props.connected,connection?.bindingId,connection?.generation])} {...props}/>;
}
function NotificationSession({runtime,subjectId,connected,navigate}:Props){
 const connection=runtime?.api.snapshot(),permitted=!!(connected&&connection?.subjectId===subjectId&&(connection.scopes.includes('notifications')||connection.scopes.includes('*')));
 const client=useMemo(()=>runtime&&permitted?runtime.notifications:null,[runtime,permitted]);
 const loader=useMemo(()=>client?createNotificationLoader(client):null,[client]);
 const deliveryClientId=useMemo(()=>{
   const key=`galaxy.notification.delivery-client-id:${runtime?.api.endpoint??'offline'}:${subjectId??'unknown'}`;
  try {
   const existing=window.localStorage.getItem(key);
   if(existing&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing))return existing;
   const created=crypto.randomUUID(); window.localStorage.setItem(key,created); return created;
  } catch { return crypto.randomUUID(); }
 },[runtime?.api.endpoint,subjectId]);
 const [readItems,setItems]=useState<ReadItem[]>([]),[next,setNext]=useState<string|null>(null),[options,setOptions]=useState<Options|null>(null);
 const projectedItems=useCurrentTaskMaterialTree(runtime,readItems),items=useMemo(()=>projectedItems??[],[projectedItems]);
 const names=useMemberNames(runtime,subjectId,connected,items.map(item=>item.actorId));
 const [savedPrompt,setPrompt]=useState<Prompt|null>(null);
 const currentPrompt=useCurrentTaskMaterialTree(runtime,savedPrompt);
 const prompt=currentPrompt&&items.some(item=>item.id===currentPrompt.item.id&&!item.read&&!item.quiet)?currentPrompt:null;
 const [settingsOpen,setSettingsOpen]=useState(false),loadedPages=useRef(1);
 const [unread,setUnread]=useState(true),[busy,setBusy]=useState(false),[loading,setLoading]=useState(permitted),[error,setError]=useState(''),[notice,setNotice]=useState(''),[checked,setChecked]=useState<string|null>(null);
 const active=useRef({epoch:0,open:true}),working=useRef(false),presentedIds=useRef(new Set<string>()),titleBase=useRef(document.title.replace(/^\(\d+\)\s*/,''));
 const load=useCallback(async(after?:string)=>{if(!loader||!permitted||!navigator.onLine)return;const lease=active.current.epoch,startedAt=Date.now();
  return loader.load({unreadOnly:unread,...(after?{after}:{})},{pages:after?1:loadedPages.current,apply:(page:Page,prefs:Options)=>{if(lease!==active.current.epoch)return;if(after)loadedPages.current++;
   const current=leaseNotificationItems(page.items,startedAt);setItems(old=>after?mergeNotificationItems(currentNotificationItems(old),current):current);
   setPrompt(old=>{if(!old)return null;const fresh=current.find(item=>item.id===old.item.id&&!item.read&&!item.quiet);return fresh?{...old,item:fresh}:after?old:null;});
   setNext(page.nextAfter);setChecked(page.lastCheckedAt);setLoading(false);setError('');setOptions(prefs);
  },failed:()=>{if(lease===active.current.epoch){setItems([]);setNext(null);setLoading(false);}}});},[loader,permitted,unread]);
 async function run(fn:()=>Promise<unknown>){if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');const lease=active.current.epoch;let committed=false;
  try{await fn();committed=true;if(lease===active.current.epoch)await load();}catch(reason){if(lease===active.current.epoch)setError(committed?'通知操作已完成，列表稍后会自动更新。':readableError(reason,'当前未取得通知，请稍后重试。'));}finally{if(active.current.open){working.current=false;setBusy(false);}}}
 useEffect(()=>{const session=active.current;session.epoch++;session.open=true;return()=>{session.open=false;session.epoch++;};},[]);
 function changeFilter(value:boolean){if(value===unread)return;loader?.invalidate();active.current.epoch++;loadedPages.current=1;setUnread(value);setLoading(permitted);setItems([]);setNext(null);setPrompt(null);setError('');setChecked(null);}
 useEffect(()=>{let alive=true;const update=()=>{if(alive&&permitted&&navigator.onLine&&!busy&&!working.current&&!document.hidden)void load().catch((reason:unknown)=>{if(alive){setLoading(false);setError(readableError(reason,'暂时未取得通知。'));}});};const onVisibility=()=>{if(!document.hidden)update();};
  const onOffline=()=>{loader?.invalidate();active.current.epoch++;setItems([]);setPrompt(null);setNext(null);setLoading(false);setError('网络暂时中断。恢复连接后会重新读取当前可见的通知。');};
  if(navigator.onLine)update();else onOffline();const timer=setInterval(update,15000);document.addEventListener('visibilitychange',onVisibility);window.addEventListener('offline',onOffline);window.addEventListener('online',update);
  return()=>{alive=false;loader?.invalidate();clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('offline',onOffline);window.removeEventListener('online',update);};},[loader,permitted,load,busy]);
 useEffect(()=>{if(!readItems.length)return;const deadline=Math.min(...readItems.map(item=>item.readUntil));const timer=setTimeout(()=>{
  const now=Date.now(),fresh=currentNotificationItems(readItems,now),expiredRead=readItems.some(item=>item.readUntil<=now&&(!item.sourceExpiresAt||Date.parse(item.sourceExpiresAt)>now));
  setItems(old=>currentNotificationItems(old,now));setPrompt(old=>old&&fresh.some(item=>item.id===old.item.id)?old:null);
  if(expiredRead)setError('暂时无法核对这些通知，连接恢复后会重新读取。');
 },Math.max(0,deadline-Date.now()));return()=>clearTimeout(timer);},[readItems]);
 useEffect(()=>{if(!savedPrompt)return;const timer=setTimeout(()=>setPrompt(old=>old?.item.readUntil===savedPrompt.item.readUntil?null:old),Math.max(0,savedPrompt.item.readUntil-Date.now()));return()=>clearTimeout(timer);},[savedPrompt]);
 useEffect(()=>{const base=titleBase.current;const count=items.filter(item=>!item.read&&!item.quiet).length;document.title=count?`(${count}) ${base}`:base;return()=>{document.title=base;};},[items]);
 useEffect(()=>{
  if(!client||!connected||!items.length||prompt||document.hidden)return;
  let cancelled=false;const epoch=active.current.epoch;
  void (async()=>{
   for(const item of items){
    if(cancelled||epoch!==active.current.epoch||!item.interruptiveEligible||item.presented||presentedIds.current.has(item.id))continue;
    const claimId=crypto.randomUUID(); presentedIds.current.add(item.id);
    try {
     const claim=await client.claim({id:item.id,deliveryClientId,claimId},undefined);
     if(!claim.claimed||cancelled||epoch!==active.current.epoch||document.hidden){presentedIds.current.delete(item.id);continue;}
     const promptReadStartedAt=Date.now();const current:Page=await client.query({limit:20,unreadOnly:true},undefined);
     const fresh=leaseNotificationItems(current.items,promptReadStartedAt).find((value:Item)=>value.id===item.id&&!value.read&&!value.quiet);
     if(!fresh||cancelled||epoch!==active.current.epoch||document.hidden||Date.parse(claim.leaseUntil)<=Date.now()){presentedIds.current.delete(item.id);continue;}
     setPrompt({item:fresh,claimId,deliveryClientId,lease:epoch,leaseUntil:claim.leaseUntil});
     break;
    } catch { presentedIds.current.delete(item.id); }
   }
  })();
  return()=>{cancelled=true;};
 },[client,connected,deliveryClientId,items,prompt]);
 useEffect(()=>{
  if(!prompt||!client)return;
  if(prompt.lease!==active.current.epoch)return;
  let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
  // This effect runs after the separate prompt has been committed to the page.
  const acknowledge=()=>client.presented({id:prompt.item.id,deliveryClientId:prompt.deliveryClientId,claimId:prompt.claimId},undefined).then((receipt: { presented?: boolean })=>{
   if(!cancelled&&prompt.lease===active.current.epoch){
    if(receipt.presented)setItems(old=>old.map(value=>value.id===prompt.item.id?{...value,presented:true,interruptiveEligible:false}:value));
    else setPrompt(null);
   }
  }).catch(()=>{if(!cancelled&&prompt.lease===active.current.epoch){setNotice('提醒已显示，正在同步。');if(Date.parse(prompt.leaseUntil)>Date.now()+2000)timer=setTimeout(acknowledge,2000);}});
  const onVisibility=()=>{if(document.hidden){presentedIds.current.delete(prompt.item.id);setPrompt(null);}else void acknowledge();};
  document.addEventListener('visibilitychange',onVisibility);
  if(!document.hidden)void acknowledge();
  return()=>{cancelled=true;if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',onVisibility);};
 },[client,prompt]);
 function target(item:Item){return notificationTarget(item);}
 function description(item:Item&{notices?:Item[]}){const author=item.actorId?memberName(item.actorId,subjectId,names[item.actorId]??undefined):null,unreadMessages=item.notices?.filter(value=>!value.read).length??0;
  if(item.eventKind==='room-message')return `${author?author+'发来消息':'对话消息'}${unreadMessages>1?` · ${unreadMessages}条未读`:''}`;
  if(item.eventKind==='room-invitation')return author?author+'邀请你加入':'对话邀请';
  return kinds[item.eventKind]??'更新';}
 async function markItemRead(item:Item){await markNotificationRowRead(client,item);}
 function openItem(item:Item){const destination=target(item);if(!destination)return;void markItemRead(item).catch(()=>{});navigate(destination);}
 async function toggleRoom(roomId:string){const lease=active.current.epoch,current=await client!.options({},undefined);if(lease!==active.current.epoch)return;const muted=current.settings.mutedRoomIds.includes(roomId),settings=applyNotificationChanges(current.settings,{mutedRooms:{[roomId]:!muted}});
  const saved=await saveNotificationSelection(client,{expectedRevision:current.revision,settings});if(lease!==active.current.epoch)return;setOptions(saved);setNotice(muted?'已恢复这段对话的通知。':'已静音这段对话的通知。');}
 if(!connected)return <section className="messages-page notifications-page"><h2 className="message-module-title">消息</h2><MessageNavigation active="notifications" navigate={navigate}/><AccountReplyNotifications endpoint={runtime?.api.endpoint} navigate={navigate}/></section>;
 if(!permitted)return <section className="messages-page notifications-page"><h2 className="message-module-title">消息</h2><MessageNavigation active="notifications" navigate={navigate}/><h1 className="small message-page-title">通知</h1><div className="browse-note"><p>当前设备还不能查看和处理通知。可以在原设备的授权设置中添加通知权限，然后回到这里。</p><Button variant="outline" onClick={()=>navigate('/app/settings/identity')}>查看当前身份与设备</Button></div></section>;
 return <section className="messages-page notifications-page" aria-busy={busy}><div className="page-heading"><h2 className="message-module-title">消息</h2><button className="icon-button" aria-label="通知设置" onClick={()=>setSettingsOpen(true)}><Settings2 size={20}/></button></div><MessageNavigation active="notifications" navigate={navigate}/><h1 className="small message-page-title">通知</h1>
  <AccountReplyNotifications endpoint={runtime?.api.endpoint} navigate={navigate} secondary/>
  {error&&<div className="message error" role="alert">{error}</div>}{notice&&<output className="message">{notice}</output>}
  {prompt&&<output className="notification-prompt" aria-live="polite"><Bell size={18}/><button onClick={()=>openItem(prompt.item)}>{prompt.item.title}</button><button className="icon-button" aria-label="关闭提醒" onClick={()=>setPrompt(null)}><X size={16}/></button></output>}
  <div className="notification-filter" aria-label="通知筛选"><button aria-pressed={unread} onClick={()=>changeFilter(true)}>未读</button><button aria-pressed={!unread} onClick={()=>changeFilter(false)}>全部</button></div>
  {loading&&!checked&&<PageLoading label="正在读取当前允许的通知…"/>}
   <div className="notification-list">{notificationRows(items).map(item=><article className={!item.read?'unread':''} key={item.rowKey}><span className="notification-type" aria-hidden="true">{item.object.type==='room'?<MessageCircle size={21}/>:<FileText size={21}/>}</span><div className="notification-content"><h2>{target(item)?<a href={target(item)!} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();openItem(item);}}>{item.title}</a>:item.title}</h2><p><span>{description(item)}</span><time dateTime={item.at}>{readableTime(item.at)}</time></p>{!target(item)&&<p>这项内容暂时无法从网页打开。</p>}</div><div className="notification-row-actions">{!item.read&&<button className="icon-button notification-read" aria-label={'标为已读：'+item.title} disabled={busy} onClick={()=>run(()=>markItemRead(item))}><Check size={18}/></button>}{item.object.type==='room'&&<button className="icon-button notification-read" aria-label={(options?.settings.mutedRoomIds.includes(item.object.id)?'恢复通知：':'静音通知：')+item.title} disabled={busy} onClick={()=>run(()=>toggleRoom(item.object.id))}><BellOff size={16}/></button>}</div></article>)}</div>
  {!loading&&!items.length&&!error&&<div className="empty-state"><h2>{unread?'当前没有可见的未读事项':'当前没有可见的通知'}</h2><p>{unread?'可以查看全部通知。':'可以继续已有对话。'}</p><div className="button-row">{unread&&<Button variant="outline" onClick={()=>changeFilter(false)}>查看全部通知</Button>}<Button variant="outline" onClick={()=>navigate('/app/rooms')}>继续聊天</Button></div></div>}
  {next&&<Button variant="outline" disabled={busy} onClick={async()=>{if(working.current)return;const lease=active.current.epoch;working.current=true;setBusy(true);try{await load(next);}catch(reason){if(lease===active.current.epoch)setError(readableError(reason,'通知下一页暂未读取成功，请稍后重试。'));}finally{if(active.current.open){working.current=false;setBusy(false);}}}}>更多通知</Button>}
  {runtime&&client&&subjectId&&<NotificationSettings runtime={runtime} subjectId={subjectId} client={client} open={settingsOpen} onResume={()=>setSettingsOpen(true)} onClose={()=>setSettingsOpen(false)} onSaved={(value,message)=>{setOptions(value);setNotice(message);void load().catch(()=>{});}}/>}
 </section>;
}
