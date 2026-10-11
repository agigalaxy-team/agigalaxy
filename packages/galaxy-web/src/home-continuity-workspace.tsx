import React,{useEffect,useMemo,useState} from 'react';
import {ArrowRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createHomeContinuityClient} from './home-continuity-client.mjs';
import {notificationTarget} from './notification-target.mjs';
import './profile-settings.css';
import type {AccountRuntime,HomeContinuity} from './account-workspace-types';
type Props={runtime?:AccountRuntime|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void};
export function HomeContinuityWorkspace(props:Props){
 const connection=props.runtime?.api.snapshot();
 return <HomeContinuitySession key={`${props.runtime?.api.endpoint}:${props.subjectId}:${connection?.bindingId}:${connection?.generation}:${props.connected}`} {...props}/>;
}
function HomeContinuitySession({runtime,connected,navigate}:Props){
 const client=useMemo(()=>runtime?createHomeContinuityClient(runtime):null,[runtime]);
 const [result,setResult]=useState<HomeContinuity|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(!!client);
 useEffect(()=>{let current=true,inFlight=false;
  const read=async()=>{if(!client||inFlight)return;inFlight=true;try{const value=await client.read();if(current){setResult(value);setError('');}}catch{if(current){setResult(null);setError('当前工作暂时不可读取，请稍后重试。');}}finally{inFlight=false;if(current)setBusy(false);}};
  void read();const resume=()=>{if(document.visibilityState==='visible')void read();};
  const interval=window.setInterval(resume,30000);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
  return()=>{current=false;window.clearInterval(interval);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
 },[client,refresh]);
 useEffect(()=>()=>client?.close(),[client]);
 const go=(path:string)=>{try{client?.check();navigate(path);}catch{setResult(null);setError('身份已变化，请重新打开我的工作。');}};
 const link=(path:string,text:string)=> <a href={path} onClick={event=>{event.preventDefault();go(path);}}>{text}</a>;
 return <div className="work-continuity" aria-busy={busy}>
  {busy&&!result&&<output>正在读取你的工作…</output>}
  {error&&<p role="alert">{error}<Button variant="ghost" onClick={()=>{setBusy(true);setRefresh(n=>n+1);}}>重试</Button></p>}
  {result&&connected&&<><section className="continuity-section"><header><h2>继续手头的事</h2>{link('/app/participate?view=participating','全部相关工作')}</header>
   {result.participating?.error?<p className="continuity-empty">相关工作暂时没有读到。{link('/app/participate?view=participating','打开我的工作')}</p>:!result.participating?.page?.items.length?<p className="continuity-empty">还没有相关工作。{link('/app/participate','看看正在找帮助的人')}</p>:<ul className="continuity-list">{result.participating.page.items.map((item)=><li key={item.taskId}><a href={`/app/tasks/${item.taskId}?section=collaboration`} onClick={event=>{event.preventDefault();go(`/app/tasks/${item.taskId}?section=collaboration`);}}><div><h3>{item.request?.title??'参与的工作'}</h3>{item.request?.summary&&<p>{item.request.summary}</p>}</div><ArrowRight size={17}/></a></li>)}</ul>}
  </section><section className="continuity-section"><header><h2>最近的回应</h2>{link('/app/notifications','全部通知')}</header>
   {result.notifications?.error?<p className="continuity-empty">通知暂时没有读到。{link('/app/notifications','打开通知')}</p>:!result.notifications?.page?.items.length?<p className="continuity-empty">暂时没有未读通知。</p>:<ul className="continuity-list">{result.notifications.page.items.map((item)=><li key={item.id}><a href={notificationTarget(item)??'/app/notifications'} onClick={event=>{event.preventDefault();go(notificationTarget(item)??'/app/notifications');}}><span>{item.title}</span><ArrowRight size={16}/></a></li>)}</ul>}
  </section></>}
 </div>;
}
