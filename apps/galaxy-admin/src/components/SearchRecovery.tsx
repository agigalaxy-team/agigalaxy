'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {timeLabel} from './business-types';
import {searchStates,sourceTypes} from './operations-task-types';
import type {SearchFailure,SearchFailurePage,SearchRecoveryJob,SearchRetryResult} from './operations-task-types';
import {operationsFailure,operationsRequest,OperationsRequestError} from '../lib/operations-client';
import {useOperationsRead} from '../lib/use-operations-read';

const recoveryLabel=(job:SearchFailure)=>job.automaticRecoveryPending?'已安排自动恢复':job.automaticRecoveryExhausted?'本代自动恢复已用尽':job.recoveryAttempts?'本代已安排 '+job.recoveryAttempts+' 次':'尚未安排自动恢复';
type Selection={jobId:string;path:string};
type ListLocation={path:string;after:string};
export function SearchRecovery({initial,initialError,path:requestedPath,after:requestedAfter,csrfToken,canManage}:{initial:SearchFailurePage|null;initialError:string;path:string;after:string;csrfToken:string;canManage:boolean}){
  const [selection,setSelection]=useState<Selection|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState<SearchRecoveryJob|null>(null),[heldLocation,setHeldLocation]=useState<ListLocation|null>(null),[message,setMessage]=useState(''),[actionError,setActionError]=useState('');
  const locked=busy||pending!==null,{path,after}=locked&&heldLocation?heldLocation:{path:requestedPath,after:requestedAfter};
  const page=useOperationsRead<SearchFailurePage>({path,initial:path===requestedPath?initial:null,initialError:path===requestedPath?initialError:'',failureMessage:'检索失败记录暂时无法取得。'});
  const target=selection?.path===path?selection:null;
  const current=useOperationsRead<{job:SearchRecoveryJob|null}>({path:target?'/v1/operations/search/failures/'+target.jobId:null,failureMessage:'这条来源的检索状态暂时无法取得。'});
  const inFlight=useRef(false),mutation=useRef<AbortController|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;mutation.current?.abort();};},[]);
  const result=current.value?.job,job=result&&target&&result.jobId===target.jobId?result:null;
  useEffect(()=>{if(!locked){setHeldLocation(null);setSelection(previous=>previous?.path===requestedPath?previous:null);}},[locked,requestedPath]);
  useEffect(()=>{
    if(!pending||busy||!current.verified||!current.value)return;
    const latest=current.value.job;
    if(!latest||latest.jobId!==pending.jobId)return;
    if(latest.generation!==pending.generation){
      setPending(null);setActionError('');setMessage('来源已有新一代任务，未对新记录再次发起重试。');void page.read();
    }else if(['pending','running','completed'].includes(latest.state)||latest.state==='failed'&&(latest.attempts<pending.attempts||latest.recoveryAttempts!==pending.recoveryAttempts)){
      setPending(null);setActionError('');setMessage('已读取原任务，当前为“'+(searchStates[latest.state]??'状态未识别')+'”。');void page.read();
    }
  },[pending,busy,current.value,current.verified,page.read]);
  useEffect(()=>{
    if(!pending||busy)return;
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,count=0;
    const poll=async()=>{if(stopped||!navigator.onLine||document.visibilityState!=='visible')return;await current.read();if(!stopped&&++count<3)timer=setTimeout(()=>void poll(),3000);};
    timer=setTimeout(()=>void poll(),1500);return()=>{stopped=true;if(timer)clearTimeout(timer);};
  },[pending,busy,current.read]);
  useEffect(()=>{
    if(!job||pending||busy||!current.verified||current.loading||document.visibilityState!=='visible')return;
    const running=['pending','running'].includes(job.state);
    if(!running&&!job.automaticRecoveryPending)return;
    const wait=running?3000:Math.min(30000,Math.max(5000,Date.parse(job.recoveryAt??'')-Date.now()||5000));
    const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void current.read();},wait);
    return()=>clearTimeout(timer);
  },[job,pending,busy,current.verified,current.loading,current.read]);
  async function retry(){
    if(!canManage||!job||job.state!=='failed'||job.automaticRecoveryPending||inFlight.current||pending||!current.verified||current.loading)return;
    const selected=job,controller=new AbortController();mutation.current=controller;inFlight.current=true;setBusy(true);setMessage('');setActionError('');
    setHeldLocation({path,after});
    try{
      const result=await operationsRequest<SearchRetryResult>('/v1/operations/search/failures/'+selected.jobId+'/retry',{csrfToken,body:{expectedGeneration:selected.generation},signal:controller.signal});
      if(!alive.current)return;
      if(result.jobId!==selected.jobId||result.generation!==selected.generation||result.state!=='pending'){setPending(selected);setActionError('返回结果暂未确认，正在读取原任务。');}
      else setMessage('已安排重新检索。');
      await current.read();void page.read();
    }catch(error){
      if(!alive.current||controller.signal.aborted)return;
      const unknown=!(error instanceof OperationsRequestError)||error.status>=500;
      if(unknown){setPending(selected);setActionError('重试结果暂未确认，请查询原任务。');}
      else setActionError(operationsFailure(error,'这次重试未被接受，请读取当前记录。'));
      await current.read();
    }finally{inFlight.current=false;if(alive.current)setBusy(false);if(mutation.current===controller)mutation.current=null;}
  }
  return <section className="galaxy-business-users galaxy-search-recovery"><header><h1>检索恢复</h1><button type="button" disabled={page.loading} onClick={()=>{void page.read();if(target)void current.read();}}>{page.loading?'正在读取…':'刷新失败记录'}</button></header>
    {page.error&&<p className="galaxy-error" role="alert">{page.error}<button type="button" disabled={page.loading} onClick={()=>void page.read()}>重新读取</button></p>}
    {page.loading&&!page.value&&<p role="status">正在读取失败记录…</p>}
    {page.value&&<><div className="galaxy-table-scroll"><table><thead><tr><th>来源</th><th>来源代次</th><th>执行尝试</th><th>自动恢复</th><th>计划恢复时间</th></tr></thead><tbody>{page.value.items.map(item=><tr key={item.jobId}><th><button type="button" disabled={locked} aria-label={'查看检索任务 '+item.jobId} onClick={()=>{setSelection({jobId:item.jobId,path});setMessage('');setActionError('');}}>{sourceTypes[item.sourceType]??'来源记录'}</button><p><code>{item.sourceId}</code></p></th><td>第 {item.generation} 代</td><td>{item.attempts} 次</td><td>{recoveryLabel(item)}</td><td>{timeLabel(item.recoveryAt)}</td></tr>)}</tbody></table></div>{!page.value.items.length&&<p>当前没有待处理的检索失败记录。</p>}<nav aria-label="检索失败分页">{after&&<Link href="/admin/operations/search-recovery" aria-disabled={locked||undefined} tabIndex={locked?-1:undefined} onClick={event=>{if(locked)event.preventDefault();}}>返回首批记录</Link>}{page.value.nextAfter&&<Link href={'/admin/operations/search-recovery?after='+encodeURIComponent(page.value.nextAfter)} aria-disabled={locked||undefined} tabIndex={locked?-1:undefined} onClick={event=>{if(locked)event.preventDefault();}}>下一页</Link>}</nav></>}
    {target&&<section aria-label="当前检索任务"><header><h2>来源检索状态</h2><button type="button" disabled={current.loading||busy} onClick={()=>void current.read()}>{current.loading?'正在读取…':'读取当前状态'}</button></header>
      {current.error&&<p className="galaxy-error" role="alert">{current.error}</p>}
      {actionError&&<p className="galaxy-error" role="alert">{actionError}{pending&&<button type="button" disabled={current.loading||busy} onClick={()=>void current.read()}>查询原任务</button>}</p>}
      {message&&<output role="status">{message}</output>}
      {current.loading&&!current.value&&<p role="status">正在读取原来源的检索状态…</p>}
      {current.value&&!job&&<p>{pending?'原任务已不存在，无法确认这次重试结果。':'这条检索任务已不存在。'}</p>}
      {job&&<><dl><dt>来源类型</dt><dd>{sourceTypes[job.sourceType]??'来源记录'}</dd><dt>来源编号</dt><dd><code>{job.sourceId}</code></dd><dt>任务编号</dt><dd><code>{job.jobId}</code></dd><dt>来源代次</dt><dd>{job.generation}</dd><dt>状态</dt><dd>{searchStates[job.state]??'状态未识别'}</dd><dt>执行尝试</dt><dd>{job.attempts} 次</dd><dt>自动恢复</dt><dd>{recoveryLabel(job)}</dd><dt>计划恢复时间</dt><dd>{timeLabel(job.recoveryAt)}</dd></dl>
        {job.automaticRecoveryPending&&job.state==='failed'&&<p>自动恢复已安排，等待执行。</p>}
        {canManage&&job.state==='failed'&&!job.automaticRecoveryPending&&<button type="button" disabled={locked||current.loading||!current.verified} onClick={()=>void retry()}>{busy?'正在提交…':'重新检索这条来源'}</button>}
      </>}
    </section>}
  </section>;
}
