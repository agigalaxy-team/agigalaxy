import {ReadingDetails,ReadingSummary} from './reading-details';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {getFactClient} from './fact-client.mjs';
import {MemberLink,useMemberNames} from './conversation-ui';
import type {WorkFactClient,WorkFacts,WorkAttempt} from './work-fact-types';
import type {WorkRuntime,WorkTask} from './work-task-types';

type Reference={id:string;version:number};
type SelectedAttempt={reference:Reference;attempt:WorkAttempt|null};
type Props={task:WorkTask;runtime:WorkRuntime|null;connected:boolean;subjectId?:string;navigate?:(path:string)=>void};
export function selectedRequestAttempts(facts:WorkFacts|null,references:Reference[]):SelectedAttempt[]{
 const seen=new Set<string>();
 return references.flatMap(reference=>{
  const key=reference.id+':'+reference.version;if(seen.has(key))return[];seen.add(key);
  return[{reference,attempt:facts?.attempts.find(item=>item.id===reference.id&&item.version===reference.version)??null}];
 });
}
const attemptState:Record<string,string>={running:'正在尝试',completed:'本段尝试已结束',abandoned:'已放下这次尝试',canceled:'已取消这次尝试',inconclusive:'尚无定论'};
const reportedOutcome:Record<string,string>={succeeded:'记录为达到本次尝试的目标',partial:'记录为部分达到',failed:'记录为未达到',inconclusive:'记录为尚无定论',conflicting:'记录中存在冲突',unrecorded:'尚未记录结果'};
function connectionKey(runtime:WorkRuntime){
 const connection=runtime.api.snapshot();
 return JSON.stringify([runtime.api.endpoint,connection?.subjectId,connection?.bindingId,connection?.generation,connection?.control?.deviceId,connection?.control?.keyId,connection?.control?.epoch]);
}
export function TaskRequestBackground({task,runtime,connected,subjectId,navigate}:Props){
 const references=task.request.workContext.attemptRefs;
 if(!references.length)return null;
 if(!runtime||!connected||!subjectId)return <section className="request-selected-attempts"><h2>已有尝试与实际观察</h2><p>这份求助带有选定的尝试记录。连接身份后，可以按当前许可阅读。</p></section>;
 return <BackgroundSession key={JSON.stringify([task.taskId,subjectId,connectionKey(runtime)])} {...{task,runtime,subjectId,navigate}}/>;
}
function BackgroundSession({task,runtime,subjectId,navigate}:Omit<Props,'runtime'|'connected'|'subjectId'>&{runtime:WorkRuntime;subjectId:string}){
 const client:WorkFactClient=useMemo(()=>getFactClient(runtime,subjectId),[runtime,subjectId]);
 const references=task.request.workContext.attemptRefs,referenceKey=JSON.stringify(references),ownerKey=connectionKey(runtime),readKey=JSON.stringify([task.taskId,task.caseId,task.version,referenceKey,ownerKey]);
 const [state,setState]=useState<{key:string;items:SelectedAttempt[];error:boolean}|null>(null),[retry,setRetry]=useState(0);
 const readEpoch=useRef(0);
 useEffect(()=>{
  const reads=readEpoch;let active=true,inFlight=false;
  const current=(ticket:number)=>active&&ticket===reads.current&&connectionKey(runtime)===ownerKey&&navigator.onLine&&!document.hidden;
  const hide=()=>{reads.current++;setState(null);};
  const read=async()=>{
   if(!active||inFlight||!navigator.onLine||document.hidden)return;inFlight=true;const ticket=++reads.current;
   try{const facts=await client.readCase(task);if(current(ticket))setState({key:readKey,items:selectedRequestAttempts(facts,references),error:false});}
   catch{if(current(ticket))setState({key:readKey,items:[],error:true});}
   finally{inFlight=false;}
  };
  const resume=()=>{hide();void read();};
  void read();const timer=window.setInterval(()=>void read(),15000);
  window.addEventListener('offline',hide);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  return()=>{active=false;reads.current++;window.clearInterval(timer);window.removeEventListener('offline',hide);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};
 },[client,runtime,ownerKey,readKey,task,references,retry]);
 const reading=state?.key===readKey?state:null,items=reading?.items??[],names=useMemberNames(runtime,subjectId,true,items.flatMap(item=>item.attempt?[item.attempt.actorId]:[]));
 const navigateTo=(path:string)=>{if(navigate)navigate(path);else location.assign(path);};
 return <section className="request-selected-attempts" aria-label="已有尝试与实际观察"><h2>已有尝试与实际观察</h2>
  <p className="muted">这里沿用发起者选定的当时记录；做法、实际观察和仍未知的部分分别保留。</p>
  {!reading?<p><output>{navigator.onLine?'正在核对选定记录的当前阅读范围…':'当前离线，选定引用仍保留。连接恢复后会重新读取背景。'}</output></p>:reading.error?<output>这些背景暂时无法读取，求助说明仍可阅读。<button type="button" className="text-action" onClick={()=>setRetry(value=>value+1)}>重新读取背景</button></output>:
   <ol>{items.map(({reference,attempt})=><li key={reference.id+':'+reference.version}>{attempt?<article>
    <header><MemberLink subjectId={attempt.actorId} ownId={subjectId} name={names[attempt.actorId]??undefined} navigate={navigateTo}/><span>{attemptState[attempt.status]??'保留当时记录状态'}</span></header>
    <h3>尝试的做法</h3><p className="request-reading-prose">{attempt.strategy}</p>
    {attempt.summary?<><h3>记录到的观察</h3><p className="request-reading-prose">{attempt.summary}</p></>:<p className="muted">这条记录尚未附上实际观察。</p>}
    {attempt.reportedOutcome&&<p>{reportedOutcome[attempt.reportedOutcome]??'保留当时的结果判断'}</p>}
    {attempt.failureReason&&<p className="request-reading-prose">{attempt.failureReason}</p>}
    <ReadingDetails><ReadingSummary>这次使用的输入与版本</ReadingSummary>{attempt.inputScopeSummary&&<p className="request-reading-prose">{attempt.inputScopeSummary}</p>}<p>选定记录第 {reference.version} 版</p></ReadingDetails>
   </article>:<p>一条选定的当时记录目前不可读取。原引用保留，可以先就求助说明继续交流。</p>}</li>)}</ol>}
 </section>;
}
