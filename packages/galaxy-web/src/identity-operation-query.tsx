import React,{useEffect,useEffectEvent,useLayoutEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import type {AccountRuntime} from './account-workspace-types';

const operationNames:Record<string,string>={bootstrap:'建立身份','set-recovery':'保存恢复码',recover:'接回原身份','declare-recovery-saved':'保存新恢复码'};
const stateNames:Record<string,string>={committed:'已完成',requested:'处理中',expired:'已到期',canceled:'已取消',prepared:'尚未提交','result-unknown':'正在确认结果','signed-awaiting-result':'正在确认结果'};
const continueNames:Record<string,string>={bootstrap:'继续建立身份','set-recovery':'继续保存恢复码',recover:'输入恢复码继续','declare-recovery-saved':'继续保存新码'};
const appliedByRuntime=new WeakMap<object,Set<string>>();
type Operation={kind:string;operationId:string;subjectId:string;state:string};
type Receipt={state:string;canContinueOriginalCommit:boolean;requiresOriginalPreparation:boolean};
type ContinueResult=Awaited<ReturnType<AccountRuntime['continueIdentityOperation']>>;
type Props={runtime:AccountRuntime|null;owner:string;busy:boolean;run:(action:()=>Promise<void>)=>Promise<void>;onContinue:(result:ContinueResult)=>void|Promise<void>;onReview?:(operation:Operation)=>void|Promise<void>;displayedOperationId?:string;completedRecoveryId?:string;recoveryFormOpen?:boolean};

export function IdentityOperationQuery(props:Props){
 return props.runtime?<IdentityOperationSession key={props.owner} {...props} runtime={props.runtime}/>:null;
}
function IdentityOperationSession({runtime,busy,run,onContinue,onReview,displayedOperationId,completedRecoveryId,recoveryFormOpen=false}:Props&{runtime:AccountRuntime}){
 const [operations,setOperations]=useState<Operation[]>([]),[receipts,setReceipts]=useState<Record<string,Receipt>>({});
 const [error,setError]=useState(''),[readError,setReadError]=useState(''),[failed,setFailed]=useState<string|null>(null),[applying,setApplying]=useState(false);
 const [appliedIds,setAppliedIds]=useState(()=>new Set(appliedByRuntime.get(runtime)??[]));
 const lifecycle=useRef({epoch:0,active:false,reading:false,applying:false,attempted:new Set<string>()});
 const controls=useRef({busy,run,onContinue,onReview,completedRecoveryId}),refreshCurrent=useRef<()=>void>(()=>{});
 useLayoutEffect(()=>{controls.current={busy,run,onContinue,onReview,completedRecoveryId};},[busy,run,onContinue,onReview,completedRecoveryId]);
 async function continueOriginal(operationId:string){
  const session=lifecycle.current;if(!session.active||session.applying||controls.current.busy)return;
  const request=session.epoch;session.applying=true;session.attempted.add(operationId);setApplying(true);setError('');
  const valid=()=>session.active&&request===session.epoch;
  try{await controls.current.run(async()=>{
   try{const result=await runtime.continueIdentityOperation(operationId,{confirmed:true});
    if(!valid())return;
    const applied=appliedByRuntime.get(runtime)??new Set<string>();applied.add(operationId);appliedByRuntime.set(runtime,applied);
    setAppliedIds(new Set(applied));setFailed(null);await controls.current.onContinue(result);
   }catch{if(valid()){setFailed(operationId);setError('暂时无法继续上次的接续，身份资料仍保留。');}}
  });}finally{if(valid()){session.applying=false;setApplying(false);}}
 }
 const resumeOriginal=useEffectEvent((operationId:string)=>continueOriginal(operationId));
 useEffect(()=>{
  const session=lifecycle.current,request=++session.epoch;session.active=true;session.reading=false;session.applying=false;
  const valid=()=>session.active&&request===session.epoch;
  const refresh=async()=>{
   if(!valid()||document.hidden||session.reading||controls.current.busy||session.applying)return;
   session.reading=true;
   try{
    const rows:Operation[]=await runtime.pendingIdentityOperations();if(!valid())return;
    setOperations(rows);
    const next:Record<string,Receipt>={};
    for(const row of rows){try{next[row.operationId]=await runtime.queryIdentityOperation(row.operationId);}catch{/* Retain the original operation until a later read establishes its state. */}if(!valid())return;}
    setReceipts(next);setReadError('');
    const ready=rows.find(row=>(next[row.operationId]?.state==='committed'||next[row.operationId]?.canContinueOriginalCommit)&&!(row.kind==='recover'&&row.operationId===controls.current.completedRecoveryId)&&!appliedByRuntime.get(runtime)?.has(row.operationId)&&!session.attempted.has(row.operationId));
    if(ready)await resumeOriginal(ready.operationId);
   }catch{if(valid())setReadError('暂时无法读取上次的进度，连接恢复后会继续。');}
   finally{if(valid())session.reading=false;}
  };
  refreshCurrent.current=()=>void refresh();void refresh();
  const timer=setInterval(()=>void refresh(),15000);document.addEventListener('visibilitychange',refresh);
  return()=>{session.active=false;session.epoch++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
 },[runtime]);
 useEffect(()=>{if(!busy)refreshCurrent.current();},[busy]);
 const visible=operations.filter(row=>!appliedIds.has(row.operationId)&&!(row.kind==='recover'&&row.operationId===completedRecoveryId));
 const active=visible.filter(row=>!['expired','canceled'].includes(receipts[row.operationId]?.state??row.state)&&row.operationId!==displayedOperationId&&!(recoveryFormOpen&&row.kind==='recover'&&receipts[row.operationId]?.requiresOriginalPreparation));
 const closed=visible.filter(row=>['expired','canceled'].includes(receipts[row.operationId]?.state??row.state));
 if(!active.length&&!closed.length&&!error&&!readError)return null;
 return <section className="identity-continuity" aria-label="身份接续">
  {active.map(row=><div className="identity-continuity-item" key={row.operationId}>
   <p>{receipts[row.operationId]?.requiresOriginalPreparation?'上次'+(operationNames[row.kind]??'身份接续')+'还未完成。':'正在确认上次'+(operationNames[row.kind]??'身份接续')+'的结果…'}</p>
   {receipts[row.operationId]?.requiresOriginalPreparation&&onReview&&<Button variant="outline" disabled={busy||applying} onClick={()=>onReview(row)}>{continueNames[row.kind]??'继续接续'}</Button>}
   {failed===row.operationId&&<Button variant="outline" disabled={busy||applying} onClick={()=>void continueOriginal(row.operationId)}>再试一次</Button>}
  </div>)}
  {(error||readError)&&<output className="message error">{error||readError}</output>}
  {visible.length>0&&<details className="identity-continuity-details"><summary>{active.length?'接续详情':'以前的接续'}</summary>{visible.map(row=><div key={row.operationId}><p>{operationNames[row.kind]??'身份接续'} · {stateNames[receipts[row.operationId]?.state??row.state]??'正在确认结果'}</p><code>{row.operationId}</code></div>)}</details>}
 </section>;
}

