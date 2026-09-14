import React, {useEffect,useRef,useState} from 'react';
import {ArrowRight,RefreshCw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';

type View='open'|'requested'|'participating';
type Props={runtime:any;subjectId?:string;connected:boolean;navigate:(path:string)=>void;needIdentity:()=>void};
const views:Record<View,string>={open:'开放任务',requested:'我发布的',participating:'与我有关'};
const states:Record<string,string>={open:'正在征集',closed:'已结束',canceled:'已取消'};
const locationView=():View=>{const value=new URLSearchParams(location.search).get('view');return value==='requested'||value==='participating'?value:'open';};

export function TaskDirectoryWorkspace({runtime,subjectId,connected,navigate,needIdentity}:Props){
 const [view,setView]=useState<View>(locationView),[draft,setDraft]=useState(''),[query,setQuery]=useState('');
 const [items,setItems]=useState<any[]>([]),[next,setNext]=useState<string|null>(null),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 const [refresh,setRefresh]=useState(0),sequence=useRef(0),working=useRef(false);
 const canRead=!!runtime&&(view==='open'||connected);
 const changeView=(value:View)=>{history.replaceState(null,'',value==='open'?'/app/participate':`/app/participate?view=${value}`);setView(value);setDraft('');setQuery('');};
 useEffect(()=>{const changed=()=>setView(locationView());addEventListener('popstate',changed);return()=>removeEventListener('popstate',changed);},[]);
 async function load(after?:string){
  if(!canRead||working.current)return;
  working.current=true;const token=++sequence.current;setBusy(true);setError('');
  try{
   const page=await runtime.api.call('/v2/tasks/query',{view,query,...(after?{after}:{})},{authenticated:connected});
   if(token!==sequence.current)return;
   setItems(old=>after?[...old,...page.items.filter((item:any)=>!old.some(known=>known.taskId===item.taskId))]:page.items);setNext(page.nextAfter??null);setLoaded(true);
  }catch(reason:any){if(token===sequence.current)setError(({connection_required:'请重新连接当前身份，再查看本人任务。',binding_revoked:'当前设备连接已撤销，请到身份设置处理。'} as Record<string,string>)[reason?.code]??reason?.message??'任务暂时未能读取，请重试。');}
  finally{if(token===sequence.current){setBusy(false);working.current=false;}}
 }
 useEffect(()=>{sequence.current++;working.current=false;setItems([]);setNext(null);setLoaded(false);setError('');setBusy(false);void load();
  const reload=()=>{if(document.visibilityState==='visible'&&!working.current&&canRead)setRefresh(value=>value+1);};
  const timer=window.setInterval(reload,20000);document.addEventListener('visibilitychange',reload);
  return()=>{sequence.current++;working.current=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};},[runtime,subjectId,connected,view,query,refresh]);
 return <section aria-busy={busy}>
  <div className="eyebrow">让经验成为下一份帮助</div><h1 className="small">参与任务</h1>
  <p className="lead">寻找你能提供的帮助，也可以继续自己发起或收到回应的任务。新参与者可以从开放协助开始。</p>
  <div className="button-row" role="group" aria-label="任务范围">{(Object.keys(views) as View[]).map(value=><Button key={value} variant={view===value?'default':'outline'} aria-pressed={view===value} onClick={()=>changeView(value)}>{views[value]}</Button>)}</div>
  {view==='participating'&&<p className="muted">包括收到的邀请、自己的申请和实际参与记录。收到邀请或提交申请不等于已承接。</p>}
  {view==='requested'&&<p className="muted">这里也可继续查看本人有权读取的私有、已结束及已取消任务，打开不会重新公开或重开。</p>}
  {!connected&&view!=='open'?<div className="message"><p>连接当前银河身份后查看本人的任务。</p><Button onClick={needIdentity}>连接身份后继续</Button></div>:<>
   <form className="search-row" onSubmit={event=>{event.preventDefault();if(query===draft.trim())setRefresh(value=>value+1);else setQuery(draft.trim());}}><Input value={draft} maxLength={200} onChange={event=>setDraft(event.target.value)} placeholder="搜索任务目标或环境" aria-label="搜索当前范围任务"/><Button type="submit" disabled={!canRead||busy}>查找任务</Button><Button type="button" variant="ghost" disabled={!canRead||busy} onClick={()=>setRefresh(value=>value+1)} aria-label="刷新当前任务范围"><RefreshCw size={16}/></Button></form>
   {error&&<div className="message error" role="alert">{error}<Button variant="ghost" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>重试读取</Button></div>}
   {!runtime&&<p className="message">正在准备任务连接。连接失败时可返回官网稍后重试。</p>}
   {busy&&!loaded&&<p role="status">正在读取当前可见任务…</p>}
   <div className="result-list">{items.map(item=><button className="task-card" key={item.taskId} onClick={()=>navigate(`/app/tasks/${item.taskId}`)}><span className="tag">{states[item.state]??item.state}</span><h2>{item.request?.title??'历史任务'}</h2><p>{item.request?.summary}</p><span className="text-link">查看当前任务 <ArrowRight size={15}/></span></button>)}</div>
   {loaded&&!busy&&!error&&items.length===0&&<div className="empty-state"><p>{view==='open'?'暂时没有符合条件的开放任务。':view==='requested'?'当前没有符合条件的本人任务。':'当前没有符合条件的邀请、申请或参与任务。'}</p><Button variant="outline" onClick={()=>navigate('/app/publish')}>发布自己的目标</Button></div>}
   {next&&<Button variant="outline" disabled={busy} onClick={()=>void load(next)}>更多任务</Button>}
  </>}
  <p className="return-note">进入同一任务继续协作；原聊天中的模型也可按任务ID刷新。离开目录不会退出参与或取消任务。</p>
 </section>;
}
