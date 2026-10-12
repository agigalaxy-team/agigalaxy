import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {MemberAvatar,memberName,useMemberNames} from './conversation-ui';
import {createHelpOriginClient,selectHelpOrigin,taskOriginReturn} from './help-origin-client.mjs';
import {createTaskPreparationClient} from './task-preparation-client.mjs';
import './task-help-continuation.css';
import type {TaskEntryRuntime,AttemptRef,HelpOriginClient,HelpOriginView,HelpOriginSelection,HelpOriginLocator,TaskEntryPreparationClient} from './task-entry-types';
import type {WorkTask} from './work-task-types';
import type {WorkAttempt} from './work-fact-types';
import {taskEntryScope} from './task-entry-types';

const refKey=(value:AttemptRef)=>value.id+':'+value.version;
const attemptOutcome=(item:WorkAttempt)=>({failed:'报告未达到目标',succeeded:'报告达到目标',partial:'报告部分达到目标',inconclusive:'尚无定论',conflicting:'报告结果存在冲突',unrecorded:'尚未记录结果'} as Record<string,string>)[item.reportedOutcome??'']??({running:'进行中',completed:'已结束',abandoned:'已放下',canceled:'已取消',inconclusive:'尚无定论'} as Record<string,string>)[item.status]??'保留原记录状态';
function currentAttempts(items:WorkAttempt[],chosen:Set<string>){
 const latest=new Map<string,WorkAttempt>();
 for(const item of items){const previous=latest.get(item.id);if(!previous||item.version>previous.version)latest.set(item.id,item);}
 return items.filter(item=>latest.get(item.id)===item||chosen.has(refKey(item)));
}
type PickerProps={runtime:TaskEntryRuntime|null;connected:boolean;locator:HelpOriginLocator|null;selection:HelpOriginSelection|null;busy:boolean;sourceRevision:number;onChange:(value:HelpOriginSelection|null)=>void;navigate:(path:string)=>void};
export function TaskOriginPicker(props:PickerProps){return <TaskOriginPickerSession key={taskEntryScope(props.runtime,props.connected)} {...props}/>;}
function TaskOriginPickerSession({runtime,connected,locator,selection,busy,sourceRevision,onChange,navigate}:PickerProps){
 const connection=runtime?.api.snapshot();
 const client:HelpOriginClient|null=useMemo(()=>runtime&&connected?createHelpOriginClient(runtime):null,[runtime,connected]);
 const taskId=selection?.taskId??locator?.taskId,returnTo=taskOriginReturn(taskId,selection?.returnTo??locator?.returnTo);
 const [source,setSource]=useState<{client:HelpOriginClient;taskId:string;slot:string;value:HelpOriginView|null;error:string}|null>(null),[retry,setRetry]=useState(0),fieldId=useId();
 const slot=JSON.stringify([taskId,retry,sourceRevision]);
 const busyRef=useRef(busy);useEffect(()=>{busyRef.current=busy;},[busy]);
 const scoped=source?.client===client&&source?.taskId===taskId&&source.slot===slot?source:null,view=scoped?.value??null,error=scoped?.error??'',reading=!!client&&!!taskId&&!scoped;
 const attemptsSource=view?.attempts??[],names=useMemberNames(runtime,connection?.subjectId,connected,attemptsSource.map(item=>item.actorId));
 useEffect(()=>{
  let active=true,reading=false,readGeneration=0;
  const read=async(initial=false)=>{
   if(!client||!taskId||!active||reading||(!initial&&busyRef.current)||document.hidden||!navigator.onLine)return;reading=true;const ticket=++readGeneration;
   try{const value=await client.read(taskId);if(active&&ticket===readGeneration&&!document.hidden&&navigator.onLine)setSource({client,taskId,slot,value,error:''});}
   catch{if(active&&ticket===readGeneration)setSource({client,taskId,slot,value:null,error:'原工作目前无法读取。已选关联仍保留，可以稍后继续，也可以取消关联后独立发布。'});}
   finally{if(ticket===readGeneration)reading=false;}
  };
  const hide=()=>{readGeneration++;reading=false;if(client&&taskId)setSource({client,taskId,slot,value:null,error:'原工作暂时无法核对，原关联和本页文字仍保留。连接恢复后会重新读取。'});};
  const visible=()=>{hide();void read();};
  void read(true);const timer=setInterval(()=>void read(),20000);document.addEventListener('visibilitychange',visible);window.addEventListener('offline',hide);window.addEventListener('online',visible);
  return()=>{active=false;readGeneration++;clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('offline',hide);window.removeEventListener('online',visible);};
 },[client,taskId,slot]);
 useEffect(()=>()=>client?.close(),[client]);
 if(!taskId)return null;
 const chosen=new Set<string>((selection?.attemptRefs??[]).map(refKey)),attempts=currentAttempts(attemptsSource,chosen);
 const selectable=!!view&&(!selection||(selection.ownerId===view.ownerId&&selection.endpoint===view.endpoint&&selection.caseId===(view.task.caseId??null)));
 const update=(refs:AttemptRef[])=>{if(view)onChange(selectHelpOrigin(view,returnTo,refs));};
 const remove=(ref:AttemptRef)=>{if(selection)onChange({...selection,attemptRefs:selection.attemptRefs.filter(item=>refKey(item)!==refKey(ref))});};
 const missing=(selection?.attemptRefs??[]).filter(ref=>!attemptsSource.some(item=>refKey(item)===refKey(ref)));
 const synthetic=view?.facts?.synthetic===true||(view?.task&&'synthetic' in view.task.request&&view.task.request.synthetic===true);
 return <section className="request-work-origin" aria-label="原工作关联">
  <header><h2>从已有工作继续</h2>{returnTo&&<a href={returnTo} onClick={event=>{event.preventDefault();navigate(returnTo);}}>阅读原工作</a>}</header>
  {!connected&&<p className="request-help-note">连接原身份后，可以读取这里已有的进展。</p>}
  {reading&&<output className="request-help-note">正在读取原工作…</output>}
  {error&&<div className="request-source-error"><p role="alert">{error}</p><Button type="button" variant="ghost" disabled={busy||!client} onClick={()=>setRetry(value=>value+1)}>再试一次</Button></div>}
  {view&&<div className="request-origin-reading"><h3>{view.task.request.title}</h3>{synthetic&&<p className="request-help-note">合成示例</p>}<p className="request-origin-summary">{view.task.request.summary}</p></div>}
  <label className="request-origin-choice" aria-label="保留与原工作的关联" htmlFor={fieldId+'-link'}><input id={fieldId+'-link'} type="checkbox" checked={!!selection} disabled={busy||(!selection&&!selectable)} onChange={event=>event.target.checked?update([]):onChange(null)}/><span><strong>保留与原工作的关联</strong><small>{selection?'别人可以沿关联了解前后的工作，原资料仍按原来的范围分享。':'也可以不选，独立发起这份求助。'}</small></span></label>
  {selection&&<>
   {!selectable&&view&&<p className="request-source-error" role="alert">原工作与保留的选择已变化。可以先取消关联，再根据当前内容重新选择。</p>}
   {selectable&&<fieldset className="request-origin-attempts" disabled={busy}><legend>已经尝试过什么？<span>按需选择</span></legend>
    {attempts.map(item=>{
     const historical=attemptsSource.some(other=>other.id===item.id&&other.version>item.version);
     return <label className="request-attempt-choice" aria-label={item.strategy} key={refKey(item)} htmlFor={fieldId+refKey(item)}><input id={fieldId+refKey(item)} type="checkbox" checked={chosen.has(refKey(item))} disabled={!chosen.has(refKey(item))&&chosen.size>=32} onChange={event=>event.target.checked?update([...selection.attemptRefs,{id:item.id,version:item.version}]):remove(item)}/><span><strong>{item.strategy}</strong>{item.summary&&item.summary!==item.strategy&&<span className="request-attempt-summary">{item.summary}</span>}<small><MemberAvatar subjectId={item.actorId}/>{memberName(item.actorId,connection?.subjectId,names[item.actorId]??undefined)} · {attemptOutcome(item)}{historical?' · 已选当时的记录':''}{item.synthetic&&!synthetic?' · 合成示例':''}</small></span></label>;
    })}
    {!attempts.length&&<p className="request-help-note">这里还没有可选的尝试，可以只关联原工作。</p>}
   </fieldset>}
   {missing.map(ref=><div className="request-origin-missing" key={refKey(ref)}><p>此前选定的一条尝试目前不可读，原选择仍保留。</p><button type="button" className="text-action" disabled={busy} onClick={()=>remove(ref)}>不再引用这条尝试</button><details><summary>原选定记录</summary><code>{ref.id}</code><span> · 版本 {ref.version}</span></details></div>)}
   <details className="request-help-reference"><summary>准确来源引用</summary><dl><dt>原工作</dt><dd><code>{selection.taskId}</code>{view&&<> · 当前修订 {view.task.version}</>}</dd>{selection.caseId&&<><dt>工作记录</dt><dd><code>{selection.caseId}</code></dd></>}{selection.attemptRefs.length>0&&<><dt>选定尝试</dt><dd>{selection.attemptRefs.map(ref=><p key={refKey(ref)}><code>{ref.id}</code> · 版本 {ref.version}</p>)}</dd></>}</dl></details>
  </>}
 </section>;
}

type ReturnProps={runtime:TaskEntryRuntime|null;connected:boolean;subjectId?:string;task:WorkTask;navigate:(path:string)=>void};
export function TaskOriginReturn(props:ReturnProps){return <TaskOriginReturnSession key={taskEntryScope(props.runtime,props.connected,props.subjectId,props.task.taskId)} {...props}/>;}
function TaskOriginReturnSession({runtime,connected,subjectId,task,navigate}:ReturnProps){
 const key=taskEntryScope(runtime,connected,subjectId);
 const client:TaskEntryPreparationClient|null=useMemo(()=>runtime&&connected?createTaskPreparationClient(runtime):null,[runtime,connected]);
 const parent=task.request.parentTaskId,own=task.requesterId===subjectId;
 const [target,setTarget]=useState<{client:TaskEntryPreparationClient;key:string;taskId:string;parent:string;path:string|null}|null>(null);
 useEffect(()=>{let active=true;if(client&&own&&parent)client.attach(task).then(value=>{if(active)setTarget({client,key,parent,taskId:task.taskId,path:taskOriginReturn(parent,value?.originReturn?.taskId===parent?value.originReturn.returnTo:null)});}).catch(()=>{if(active)setTarget({client,key,parent,taskId:task.taskId,path:taskOriginReturn(parent,null)});});return()=>{active=false;};},[client,task,own,parent,key]);
 useEffect(()=>()=>client?.close(),[client]);
 const path=target?.key===key&&target.client===client&&target.parent===parent&&target.taskId===task.taskId&&own?target.path:null;
 return path?<p className="request-origin-return"><a href={path} onClick={event=>{event.preventDefault();navigate(path);}}>返回原工作</a><span>继续查看进展，或用这次得到的帮助接着做。</span></p>:null;
}
