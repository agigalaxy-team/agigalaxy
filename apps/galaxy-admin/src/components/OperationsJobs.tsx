'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {timeLabel} from './business-types';
import {canCancelJob,operationQueues,operationStates,queueLabels} from './operations-task-types';
import type {OperationJob,OperationJobPage,OperationQueue} from './operations-task-types';
import {operationsFailure,operationsRequest,OperationsRequestError} from '../lib/operations-client';
import {useOperationsRead} from '../lib/use-operations-read';

type Intent={action:'cancel'|'retry';job:OperationJob};
const taskState=(job:OperationJob)=>operationStates[job.state]??'状态未识别';
const changedAfterRetry=(before:OperationJob,after:OperationJob)=>after.retryCount!==before.retryCount||after.startedAt!==before.startedAt||after.completedAt!==before.completedAt;

export function OperationsJobs({initial,initialError,path,queue,after,csrfToken,canManage}:{initial:OperationJobPage|null;initialError:string;path:string;queue:OperationQueue;after:string;csrfToken:string;canManage:boolean}){
  const page=useOperationsRead<OperationJobPage>({path,initial,initialError,failureMessage:'任务记录暂时无法取得。'});
  const [selectedId,setSelectedId]=useState<string|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState<Intent|null>(null),[message,setMessage]=useState(''),[actionError,setActionError]=useState('');
  const current=useOperationsRead<{job:OperationJob|null}>({path:selectedId?'/v1/operations/jobs/'+queue+'/'+selectedId:null,failureMessage:'这条任务的状态暂时无法取得。'});
  const mutation=useRef<AbortController|null>(null),inFlight=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;mutation.current?.abort();};},[]);
  const job=current.value?.job??null;
  useEffect(()=>{
    if(!pending||busy||!current.verified||!current.value)return;
    const latest=current.value.job;
    if(!latest)return;
    if(latest.id!==pending.job.id||latest.queue!==pending.job.queue)return;
    if(latest.state==='cancelled'){
      setPending(null);setActionError('');setMessage(pending.action==='cancel'?'任务已取消。':'任务已取消，没有重新启动。');void page.read();
    }else if(pending.action==='cancel'&&['completed','failed'].includes(latest.state)){
      setPending(null);setActionError('');setMessage('任务已结束，当前为“'+taskState(latest)+'”。');void page.read();
    }else if(pending.action==='retry'&&(['created','retry','active','completed'].includes(latest.state)||latest.state==='failed'&&changedAfterRetry(pending.job,latest))){
      setPending(null);setActionError('');setMessage(latest.state==='failed'?'任务已重新尝试，当前仍执行失败。':'已安排重试，当前为“'+taskState(latest)+'”。');void page.read();
    }
  },[pending,busy,current.value,current.verified,page.read]);
  useEffect(()=>{
    if(!pending||busy)return;
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,count=0;
    const poll=async()=>{
      if(stopped||!navigator.onLine||document.visibilityState!=='visible')return;
      await current.read();
      if(!stopped&&++count<3)timer=setTimeout(()=>void poll(),3000);
    };
    timer=setTimeout(()=>void poll(),1500);
    return()=>{stopped=true;if(timer)clearTimeout(timer);};
  },[pending,busy,current.read]);
  useEffect(()=>{
    if(!job||!canCancelJob(job)||pending||busy||!current.verified||current.loading||document.visibilityState!=='visible')return;
    const wait=job.state==='active'?3000:Math.min(30000,Math.max(5000,Date.parse(job.availableAt??'')-Date.now()||5000));
    const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void current.read();},wait);
    return()=>clearTimeout(timer);
  },[job,pending,busy,current.verified,current.loading,current.read]);
  async function act(action:Intent['action']){
    if(!canManage||inFlight.current||pending||!job||!current.verified||current.loading)return;
    if(action==='cancel'?!canCancelJob(job):job.state!=='failed')return;
    const intent:Intent={action,job},controller=new AbortController();mutation.current=controller;inFlight.current=true;setBusy(true);setMessage('');setActionError('');
    try{
      const latest=await operationsRequest<OperationJob|null>('/v1/operations/jobs/'+queue+'/'+job.id+'/'+action,{csrfToken,body:{},signal:controller.signal});
      if(!alive.current)return;
      setMessage(latest?(action==='cancel'?(latest.state==='cancelled'?'任务已取消。':'当前为“'+taskState(latest)+'”。'):'已安排重试，当前为“'+taskState(latest)+'”。'):'操作已返回，正在读取当前记录。');
      await current.read();void page.read();
    }catch(error){
      if(!alive.current||controller.signal.aborted)return;
      const unknown=!(error instanceof OperationsRequestError)||error.status>=500;
      if(unknown){setPending(intent);setActionError('操作结果暂未确认，请查询原任务状态。');}
      else setActionError(operationsFailure(error,'这次操作未被接受，请读取当前任务状态。'));
      await current.read();
    }finally{inFlight.current=false;if(alive.current)setBusy(false);if(mutation.current===controller)mutation.current=null;}
  }
  const locked=busy||pending!==null;
  return <section className="galaxy-business-users galaxy-operations-jobs"><header><h1>持续任务</h1><button type="button" disabled={page.loading} onClick={()=>{void page.read();if(selectedId)void current.read();}}>{page.loading?'正在读取…':'刷新任务'}</button></header>
    <form method="get" action="/admin/operations/jobs" className="galaxy-user-search"><label>任务队列<select name="queue" defaultValue={queue}>{operationQueues.map(value=><option key={value} value={value}>{queueLabels[value]}</option>)}</select></label><button type="submit">查看</button></form>
    {page.error&&<p className="galaxy-error" role="alert">{page.error}<button type="button" disabled={page.loading} onClick={()=>void page.read()}>重新读取</button></p>}
    {page.loading&&!page.value&&<p role="status">正在读取任务…</p>}
    {page.value&&<><div className="galaxy-table-scroll"><table><caption>{queueLabels[queue]}</caption><thead><tr><th>任务</th><th>状态</th><th>重试计数 / 上限</th><th>创建时间</th><th>开始时间</th></tr></thead><tbody>{page.value.items.map(item=>{const value=job?.id===item.id?job:item;return <tr key={item.id}><th><button type="button" aria-label={'查看任务 '+item.id} disabled={locked} onClick={()=>{setSelectedId(item.id);setActionError('');setMessage('');}}>查看任务</button><p><code>{item.id}</code></p></th><td>{taskState(value)}</td><td>{value.retryCount} / {value.retryLimit}</td><td>{timeLabel(value.createdAt)}</td><td>{timeLabel(value.startedAt)}</td></tr>;})}</tbody></table></div>{!page.value.items.length&&<p>这个队列还没有任务记录。</p>}<nav aria-label="任务分页">{after&&<Link href={'/admin/operations/jobs?'+new URLSearchParams({queue})}>返回首批任务</Link>}{page.value.nextAfter&&<Link href={'/admin/operations/jobs?'+new URLSearchParams({queue,after:page.value.nextAfter})}>下一页</Link>}</nav></>}
    {selectedId&&<section aria-label="当前任务"><header><h2>任务状态</h2><button type="button" disabled={current.loading||busy} onClick={()=>void current.read()}>{current.loading?'正在读取…':'读取当前状态'}</button></header>
      {current.error&&<p role="alert" className="galaxy-error">{current.error}</p>}
      {actionError&&<p role="alert" className="galaxy-error">{actionError}{pending&&<button type="button" disabled={current.loading||busy} onClick={()=>void current.read()}>查询原任务</button>}</p>}
      {message&&<output role="status">{message}</output>}
      {current.loading&&!current.value&&<p role="status">正在读取这条任务…</p>}
      {current.value&&!job&&<p>{pending?'原任务记录已不存在，无法确认这次操作的结果。':'这条任务记录已不存在。'}</p>}
      {job&&<><dl><dt>任务编号</dt><dd><code>{job.id}</code></dd><dt>状态</dt><dd>{taskState(job)}</dd><dt>重试计数 / 上限</dt><dd>{job.retryCount} / {job.retryLimit}</dd><dt>创建时间</dt><dd>{timeLabel(job.createdAt)}</dd><dt>可执行时间</dt><dd>{timeLabel(job.availableAt)}</dd><dt>开始时间</dt><dd>{timeLabel(job.startedAt)}</dd><dt>结束时间</dt><dd>{timeLabel(job.completedAt)}</dd>{job.resourceId&&<><dt>关联对象</dt><dd><code>{job.resourceId}</code></dd></>}{job.subjectId&&<><dt>来源 ID</dt><dd><code>{job.subjectId}</code></dd></>}{job.error&&<><dt>错误标记</dt><dd><code>{job.error}</code></dd></>}</dl>
        {canManage&&<div>{canCancelJob(job)&&<button type="button" disabled={locked||current.loading||!current.verified} onClick={()=>void act('cancel')}>{busy?'正在提交…':'取消任务'}</button>}{job.state==='failed'&&<button type="button" disabled={locked||current.loading||!current.verified} onClick={()=>void act('retry')}>{busy?'正在提交…':'重试这条失败任务'}</button>}</div>}
      </>}
    </section>}
  </section>;
}
