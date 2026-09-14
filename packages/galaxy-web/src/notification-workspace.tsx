import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {createNotificationInboxClient} from '../../galaxy-official/src/personal-summary-client.mjs';
import {mergeNotificationItems} from './notification-merge.mjs';
import {createNotificationLoader} from './notification-loader.mjs';
type Props={runtime:any;subjectId?:string;connected:boolean;navigate:(path:string)=>void;room?:any};
const kinds:Record<string,string>={'qualification-permission-request':'资格材料许可请求','qualification-permission-decline':'原作者已拒绝许可请求','qualification-permission-cancel':'申请者已取消许可请求','qualification-permission-record-permission':'原作者已关联限定许可','room-message':'房间消息','room-invitation':'房间邀请','information-change':'关注的信息发生变化',dispute:'任务争议','confirm-resolution':'结果回应','propose-resolution':'交付建议'};
export function notificationTarget(item:any){const o=item?.object;if(!o)return null;if(o.type==='capsule')return `/app/capsules/${o.id}${o.versionId?`/versions/${o.versionId}`:''}`;if(o.type==='qualification-request')return `/app/qualification-permissions/${o.id}`;if(o.type==='room')return `/app/rooms/${o.id}`;if(o.type==='room-invitation')return '/app/rooms';if(o.type==='task')return `/app/tasks/${o.id}`;if(o.type==='information-watch')return '/app/information';if(o.type==='project')return `/app/projects?projectId=${encodeURIComponent(o.id)}`;if(o.type==='builder'||o.type==='worker-pack')return '/app/builders';if(o.type==='hub')return '/app/hubs';if(o.type==='governance'||o.type==='case')return '/app/governance';return null;}
export function NotificationWorkspace(props:Props){
 return <NotificationSession key={`${props.runtime?.api.endpoint}:${props.subjectId}:${props.connected}`} {...props}/>;
}
function NotificationSession({runtime,subjectId,connected,navigate}:Props){
 const boundSubject=useRef<string|undefined>(subjectId),boundEndpoint=useRef<string|undefined>(runtime?.api.endpoint);
 const call=useMemo(()=>runtime?((path:string,input:any,options:any)=>{const current=runtime.api.snapshot()?.subjectId;if(!boundSubject.current&&current)boundSubject.current=current;if(!boundSubject.current||current!==boundSubject.current||runtime.api.endpoint!==boundEndpoint.current)throw new Error('身份或连接已改变，请重新打开通知。');return runtime.api.call(path,input,options);}):null,[runtime]);
 const client=useMemo(()=>call?createNotificationInboxClient({call}):null,[call]);
 const loader=useMemo(()=>client?createNotificationLoader(client):null,[client]);
 const deliveryClientId=useMemo(()=>{
   const key=`galaxy.notification.delivery-client-id:${runtime?.api.endpoint??'offline'}:${subjectId??'unknown'}`;
  try {
   const existing=window.localStorage.getItem(key);
   if(existing&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing))return existing;
   const created=crypto.randomUUID(); window.localStorage.setItem(key,created); return created;
  } catch { return crypto.randomUUID(); }
 },[runtime?.api.endpoint,subjectId]);
 const [items,setItems]=useState<any[]>([]),[next,setNext]=useState<string|null>(null),[options,setOptions]=useState<any>(null),[settings,setSettings]=useState<any>(null);
 const [prompt,setPrompt]=useState<any>(null);
 const [unread,setUnread]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[checked,setChecked]=useState<string|null>(null),[block,setBlock]=useState('');
 const active=useRef(0),working=useRef(false),dirty=useRef(false),presentedIds=useRef(new Set<string>()),titleBase=useRef(document.title.replace(/^\(\d+\)\s*/,''));
 async function load(after?:string){if(!loader||!connected)return;const lease=active.current;
  return loader.load({unreadOnly:unread,...(after?{after}:{})},{apply:(page:any,prefs:any)=>{if(lease!==active.current)return;
   setItems(old=>after?mergeNotificationItems(old,page.items):page.items);setNext(page.nextAfter);setChecked(page.lastCheckedAt);setError('');if(!dirty.current){setOptions(prefs);setSettings(prefs.settings);}
  },failed:()=>{if(lease===active.current){setItems([]);setNext(null);}}});}
 async function run(fn:()=>Promise<any>){if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');const lease=active.current;let committed=false;
  try{await fn();committed=true;if(lease===active.current)await load();}catch(e:any){if(lease===active.current)setError(committed?'通知操作已收到服务回执，但列表暂未刷新；请稍后刷新，不要重复提交。':e?.message??'当前未取得通知，请稍后重试。');}finally{if(lease===active.current){working.current=false;setBusy(false);}}}
 useEffect(()=>{active.current++;setItems([]);setPrompt(null);setOptions(null);setSettings(null);setError('');dirty.current=false;working.current=false;presentedIds.current.clear();setBusy(false);return()=>{active.current++;};},[runtime,subjectId,connected]);
 useEffect(()=>{let alive=true;setItems([]);setNext(null);setPrompt(null);const update=()=>{if(alive&&connected&&!working.current&&!document.hidden)void load().catch(e=>{if(alive)setError(e?.message??'暂时未取得通知。');});};const onVisibility=()=>{if(!document.hidden)update();};update();const timer=setInterval(update,15000);document.addEventListener('visibilitychange',onVisibility);return()=>{alive=false;loader?.invalidate();clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);};},[loader,connected,subjectId,unread]);
 useEffect(()=>{const base=titleBase.current;const count=items.filter(item=>!item.read&&!item.quiet).length;document.title=count?`(${count}) ${base}`:base;return()=>{document.title=base;};},[items]);
 useEffect(()=>{
  if(!client||!connected||!items.length||prompt||document.hidden)return;
  let cancelled=false;
  (async()=>{
   for(const item of items){
    if(cancelled||!item.interruptiveEligible||item.presented||presentedIds.current.has(item.id))continue;
    const claimId=crypto.randomUUID(); presentedIds.current.add(item.id);
    try {
     const claim=await client.claim({id:item.id,deliveryClientId,claimId});
     if(!claim.claimed||cancelled||document.hidden){presentedIds.current.delete(item.id);continue;}
     setPrompt({item,claimId,deliveryClientId,lease:active.current});
     break;
    } catch { presentedIds.current.delete(item.id); }
   }
  })();
  return()=>{cancelled=true;};
 },[client,connected,deliveryClientId,items,prompt]);
 useEffect(()=>{
  if(!prompt||!client)return;
  if(document.hidden||prompt.lease!==active.current){presentedIds.current.delete(prompt.item.id);setPrompt(null);return;}
  let cancelled=false;
  // This effect runs after the separate prompt has been committed to the page.
  client.presented({id:prompt.item.id,deliveryClientId:prompt.deliveryClientId,claimId:prompt.claimId}).then((receipt: { presented?: boolean })=>{
   if(!cancelled&&prompt.lease===active.current){
    if(receipt.presented)setItems(old=>old.map(value=>value.id===prompt.item.id?{...value,presented:true,interruptiveEligible:false}:value));
    else setPrompt(null);
   }
  }).catch(()=>{if(!cancelled)setPrompt(null);});
  return()=>{cancelled=true;};
 },[client,prompt]);
 useEffect(()=>{if(prompt&&!items.some(item=>item.id===prompt.item.id&&!item.read&&!item.quiet))setPrompt(null);},[items,prompt]);
 function editSettings(next:any){dirty.current=true;setSettings(next);}
 function target(item:any){return notificationTarget(item);}
 if(!connected)return <section><h1 className="small">通知</h1><p>连接身份后查看自己的待处理事项，关闭页面不会处理或取消任何业务。</p><Button onClick={()=>navigate('/app/settings')}>连接身份</Button></section>;
 return <section aria-busy={busy}><h1 className="small">通知</h1><p className="lead">查看消息、邀请及任务变化，再按需要进入原内容。</p>
  {error&&<div className="message error" role="alert">{error}</div>}{notice&&<output className="message">{notice}</output>}
  {prompt&&<div className="message" role="status" aria-live="polite"><strong>待处理提醒：{prompt.item.title}</strong><div className="button-row">{target(prompt.item)&&<Button variant="outline" onClick={()=>navigate(target(prompt.item)!)}>进入对应内容</Button>}<Button variant="ghost" onClick={()=>setPrompt(null)}>收起这条提醒</Button></div><p className="muted">收起不标记已读，也不处理任务；原事项继续留在通知列表。</p></div>}
  <div className="button-row"><label><input type="checkbox" disabled={busy} checked={unread} onChange={e=>setUnread(e.target.checked)}/>只看未读</label><Button variant="outline" disabled={busy} onClick={()=>run(async()=>{})}>刷新通知</Button></div>
  <p className="muted">{checked?`最近查询：${new Date(checked).toLocaleString()}。`:'尚未取得查询结果。'}当前页运行时刷新；不会自动标记已读，也不承诺关闭网页后的系统推送。</p>
   <div className="result-list">{items.map(item=><article className="task-card" key={item.id}><h2>{item.title}</h2><p>{kinds[item.eventKind]??'业务事项'} · {item.read?'已标记已读':'未读'} · {new Date(item.at).toLocaleString()}{item.presented?' · 已提示':item.quiet?' · 安静收件':''}</p>
   <div className="button-row">{target(item)&&<Button onClick={()=>navigate(target(item)!)}>进入对应内容</Button>}<Button variant="outline" disabled={busy||item.read} onClick={()=>run(async()=>{await client!.markRead({id:item.id,reader:'human'});setNotice('已按你的选择标记此通知已读，不改变任务或房间阅读位置。');})}>我已读这条通知</Button>
    {item.object.type==='room'&&settings&&<Button variant="ghost" disabled={busy} onClick={()=>{const roomId=item.object.id,muted=settings.mutedRoomIds.includes(roomId);editSettings({...settings,mutedRoomIds:muted?settings.mutedRoomIds.filter((id:string)=>id!==roomId):[...settings.mutedRoomIds,roomId]});setNotice('房间静音选择尚未保存，请在下方保存通知设置。');}}>{settings.mutedRoomIds.includes(item.object.id)?'取消房间静音':'静音这个房间'}</Button>}</div>
   {!target(item)&&<p className="muted">原对象类型：{item.object.type}。完整旧对象页面尚未接入，可用银河 MCP 按该对象查询；不把它转成另一项任务。</p>}
  </article>)}</div>
  {!items.length&&!error&&<div className="empty-state">当前条件下没有仍可见的通知。关闭类别、静音、已读或来源到期会影响结果。</div>}
  {next&&<Button variant="outline" disabled={busy} onClick={async()=>{if(working.current)return;working.current=true;setBusy(true);try{await load(next);}catch(e:any){setError(typeof e?.message==='string'&&e.message.trim()?e.message:'通知下一页暂未读取成功，请稍后重试。');}finally{working.current=false;setBusy(false);}}}>继续读取通知</Button>}
  {settings&&options&&<details className="room-settings"><summary>通知与屏蔽设置</summary><form className="workspace-form" onSubmit={e=>{e.preventDefault();void run(async()=>{const receipt=await client!.saveOptions({expectedRevision:options.revision,settings});setOptions((old:any)=>({...old,revision:receipt.revision??old.revision,settings:receipt.settings??settings}));setSettings(receipt.settings??settings);dirty.current=false;setNotice('通知设置已保存。必要的业务回执仍会安静留在收件区。');});}}>
   <fieldset disabled={busy}><legend>选择通知范围</legend><label><input type="checkbox" checked={settings.rooms} onChange={e=>editSettings({...settings,rooms:e.target.checked})}/>显示房间类通知</label><label><input type="checkbox" checked={settings.tasks} onChange={e=>editSettings({...settings,tasks:e.target.checked})}/>显示任务类通知</label>
   {settings.mutedRoomIds.map((id:string)=><p key={id}>静音房间 <code>{id}</code><Button type="button" variant="ghost" onClick={()=>editSettings({...settings,mutedRoomIds:settings.mutedRoomIds.filter((r:string)=>r!==id)})}>解除静音</Button></p>)}
   <label htmlFor="galaxy-block-subject">要屏蔽的银河 ID<Input id="galaxy-block-subject" value={block} onChange={e=>setBlock(e.target.value.trim())} placeholder="填写对方的银河 ID"/></label><Button type="button" variant="outline" disabled={!/^GUID[A-Z0-9]{28}$/.test(block)||block===subjectId||settings.blockedSubjectIds.includes(block)} onClick={()=>{editSettings({...settings,blockedSubjectIds:[...settings.blockedSubjectIds,block]});setBlock('');}}>加入待保存的屏蔽清单</Button>
   {settings.blockedSubjectIds.map((id:string)=><p key={id}><code>{id}</code><Button type="button" variant="ghost" onClick={()=>editSettings({...settings,blockedSubjectIds:settings.blockedSubjectIds.filter((s:string)=>s!==id)})}>解除屏蔽</Button></p>)}
   <p className="muted">屏蔽影响后续联系和通知，不等于撤销已经公开的资料。外部邮件、系统推送当前未在此开启。</p><div className="button-row"><Button type="submit" disabled={busy}>保存所选通知设置</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>run(async()=>{dirty.current=false;})}>放弃未保存修改并重新读取</Button></div>
  </fieldset></form></details>}
 </section>;
}

