'use client';
import {useCallback,useEffect} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {isProductRecovered,recoverProductCommand,validateProductOperation,productRecoveryPendingMessage} from '../lib/product-command-recovery';
import type {ProductRecovered} from '../lib/product-command-recovery';
import {useOperationsRead} from '../lib/use-operations-read';
import {CommandFeedback,ReadStatus,useOperationCommand} from './OperationControls';
import type {RetentionPolicy,RetentionResult,RetentionRun,RetentionRuns,RetentionTargetKey} from './operations-product-types';
import {retentionLabels} from './operations-product-types';
import {timeLabel} from './business-types';
const states:Record<RetentionRun['state'],string>={queued:'等待处理',completed:'已完成',failed:'失败',cancelled:'已取消'};
function Result({value}:{value:RetentionResult|null}){return value?<dl className="galaxy-operational-facts">{value.privateConversationArchives!==undefined&&<><dt>会话副本</dt><dd>{value.privateConversationArchives}</dd></>}{value.removed!==undefined&&<><dt>导出记录</dt><dd>{value.removed}</dd></>}{value.informationChangeReceipts!==undefined&&<><dt>变化回执</dt><dd>{value.informationChangeReceipts}</dd></>}{value.informationWatchReceipts!==undefined&&<><dt>关注回执</dt><dd>{value.informationWatchReceipts}</dd></>}</dl>:null;}
export function Retention({selected,after,csrfToken,canManage}:{selected:string;after:string;csrfToken:string;canManage:boolean}){
  const router=useRouter();
  const policy=useOperationsRead<RetentionPolicy>({path:'/v1/operations/retention',failureMessage:'到期清理状态暂时无法取得。'});
  const runs=useOperationsRead<RetentionRuns>({path:'/v1/operations/retention/runs?'+new URLSearchParams({limit:'25',...(after?{after}:{})}),failureMessage:'清理记录暂时无法取得。'});
  const id=selected,current=useOperationsRead<{run:RetentionRun}>({path:id?'/v1/operations/retention/runs/'+id:null,failureMessage:'这次清理状态暂时无法取得。'});
  const committed=useCallback(async(value:{run:RetentionRun}|ProductRecovered)=>{const id=isProductRecovered(value)?value.family==='retention'?value.runId:null:value.run.id;if(!id)throw Error('Unexpected receipt');router.replace('/admin/operations/retention?run='+id);void runs.read();void policy.read();},[router,runs.read,policy.read]);
  const command=useOperationCommand<{run:RetentionRun}|ProductRecovered>({csrfToken,canWrite:canManage&&policy.verified,canRecover:policy.verified||runs.verified,recover:recoverProductCommand,validateResult:validateProductOperation,recoveryPendingMessage:productRecoveryPendingMessage,onCommitted:committed});
  useEffect(()=>{if(current.value?.run.state!=='queued'||current.loading)return;const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible'){void current.read();void runs.read();void policy.read();}},3000);return()=>clearTimeout(timer);},[current.value,current.loading,current.read,runs.read,policy.read]);
  function schedule(target:RetentionTargetKey){void command.submit('/v1/operations/retention/runs',{target},'已安排到期清理。');}
  return <section className="galaxy-business-users"><header><h1>到期清理</h1></header><ReadStatus loading={policy.loading} error={policy.error} retry={policy.read}/>{policy.value&&<div className="galaxy-dashboard-regions">{policy.value.targets.map(target=><section className="galaxy-dashboard-region" key={target.key}><h2>{target.label}</h2><p>{target.backlog} 条符合现有到期条件</p><p className="galaxy-operation-basis">{target.maximumRootsPerRun!==null?'每次最多处理 '+target.maximumRootsPerRun+' 个关注及其到期回执':'每次最多处理 '+target.maximumRowsPerRun+' 条到期记录'}</p>{target.observations.map(item=><div key={item.component}><p>{item.component} · {timeLabel(item.checkedAt)}{item.errorCode?' · 最近处理失败':''}</p>{item.errorCode?<code>{item.errorCode}</code>:<Result value={item.result}/>}</div>)}{!target.observations.length&&<p className="galaxy-operation-basis">尚未取得最近一次自动处理记录。</p>}{canManage&&<button type="button" disabled={command.locked||policy.loading||!policy.verified||target.backlog===0} onClick={()=>schedule(target.key)}>处理这批到期记录</button>}</section>)}</div>}<CommandFeedback command={command}/>
    {id&&<section><h2>当前清理</h2><ReadStatus loading={current.loading} error={current.error} retry={current.read}/>{current.value&&<><p>{retentionLabels[current.value.run.target]} · {states[current.value.run.state]}</p><Result value={current.value.run.result}/>{current.value.run.errorCode&&<p className="galaxy-error"><code>{current.value.run.errorCode}</code></p>}{current.value.run.jobId&&<Link href="/admin/operations/jobs?queue=retention-cleanup">查看执行队列</Link>}</>}</section>}
    <section><h2>处理记录</h2><ReadStatus loading={runs.loading} error={runs.error} retry={runs.read}/>{runs.value&&<>{!runs.value.items.length?<p>没有手动清理记录。</p>:<ol className="galaxy-records">{runs.value.items.map(run=><li key={run.id}><Link href={'/admin/operations/retention?run='+run.id}>{retentionLabels[run.target]}</Link><span>{states[run.state]} · {timeLabel(run.createdAt)}</span><Result value={run.result}/></li>)}</ol>}{runs.value.nextAfter&&<Link href={'/admin/operations/retention?after='+encodeURIComponent(runs.value.nextAfter)}>更早记录</Link>}</>}</section>
  </section>;
}
