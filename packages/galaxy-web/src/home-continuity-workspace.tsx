import React,{useEffect,useMemo,useState} from 'react';
import {} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createHomeContinuityClient} from './home-continuity-client.mjs';
import {notificationTarget} from './features/notifications/target.mjs';
import {useCurrentTaskMaterialTree,taskViewTitle,TaskMaterialNotice} from './task-material-view';
import './profile-settings.css';
import type {AccountRuntime,HomeContinuity} from './account-workspace-types';
type Props={runtime?:AccountRuntime|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void};
const taskStates:Record<string,string>={open:'正在征集',closed:'已结束',canceled:'已取消'};
export function HomeContinuityWorkspace(props:Props){
 const connection=props.runtime?.api.snapshot();
 return <HomeContinuitySession key={JSON.stringify([props.runtime?.api.endpoint,props.subjectId,connection?.bindingId,connection?.generation,props.connected])} {...props}/>;
}
function HomeContinuitySession({runtime,connected,navigate}:Props){
 const client=useMemo(()=>runtime?createHomeContinuityClient(runtime):null,[runtime]);
 const [readResult,setResult]=useState<HomeContinuity|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(!!client);
 useEffect(()=>{let current=true,inFlight=false;
  const read=async()=>{if(!client||inFlight)return;inFlight=true;try{const value=await client.read();if(current){setResult(value);setError('');}}catch{if(current){setResult(null);setError('当前工作暂时不可读取，请稍后重试。');}}finally{inFlight=false;if(current)setBusy(false);}};
  void read();const resume=()=>{if(document.visibilityState==='visible')void read();};
  const interval=window.setInterval(resume,30000);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
  return()=>{current=false;window.clearInterval(interval);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
 },[client,refresh]);
 useEffect(()=>()=>client?.close(),[client]);
 const result=useCurrentTaskMaterialTree(runtime,readResult);
 const go=(path:string)=>{try{client?.check();navigate(path);}catch{setResult(null);setError('身份已变化，请重新打开我的工作。');}};
 const link=(path:string,text:string)=><a href={path} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();go(path);}}}>{text}</a>;
 return <div className="work-continuity" aria-busy={busy}>
  {busy&&!result&&<output>正在读取你的工作…</output>}
  {error&&<p role="alert">{error}<Button variant="ghost" onClick={()=>{setBusy(true);setRefresh(n=>n+1);}}>重试</Button></p>}
  {result&&connected&&<><div className="work-overview-grid">{(['requested','participating'] as const).map(kind=>{
   const part=result[kind],own=kind==='requested',target='/app/participate?view='+kind;
   return <section key={kind} className="continuity-section"><header><h2>{own?'我发起的求助':'我参与的工作'}</h2>{link(target,'查看全部')}</header>
    {part?.error?<p className="continuity-empty">这部分工作暂时没有读到。{link(target,'打开列表重试')}</p>:!part?.page?.items.length?<div className="continuity-empty"><p>{own?'还没有发起求助。可以从想推进的一件事开始。':'还没有参与记录。看看有没有你感兴趣的事。'}</p>{link(own?'/app/publish':'/app/participate',own?'发起求助':'浏览正在找帮助的人')}</div>:<ul className="continuity-list">{part.page.items.map(item=>{
     const path='/app/tasks/'+item.taskId+(own?'':'?section=collaboration');
     return <li key={item.taskId}><a href={path} onClick={event=>{event.preventDefault();go(path);}}><div><h3>{taskViewTitle(item,own?'发起的求助':'参与的工作')}</h3>{item.request?.summary&&<p>{item.request.summary}</p>}<TaskMaterialNotice task={item}/>{item.state&&taskStates[item.state]&&<span className="work-item-state">{taskStates[item.state]}</span>}</div></a></li>;
    })}</ul>}
   </section>;
  })}</div>
  <section className="continuity-section continuity-responses"><header><h2>最近的回应</h2>{link('/app/notifications','全部通知')}</header>
   {result.notifications?.error?<p className="continuity-empty">通知暂时没有读到。{link('/app/notifications','打开通知')}</p>:!result.notifications?.page?.items.length?<p className="continuity-empty">暂时没有未读通知。</p>:<ul className="continuity-list">{result.notifications.page.items.map(item=><li key={item.id}>{link(notificationTarget(item)??'/app/notifications',item.title)}</li>)}</ul>}
  </section></>}
 </div>;
}
