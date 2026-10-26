'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsRequest,OperationsRequestError,operationsFailure} from "../operations-client";
import {cleanupCodes} from './file-cleanup-view-model';
import type {CleanupOperation,CleanupPlan,CleanupReceipt} from "../../components/files/file-cleanup-types";

type Intent={path:string;body:Record<string,unknown>;csrfToken:string;kind:'create'|'approve'|'cancel';sent:boolean};
export function useCleanupCommand({csrfToken,canRead,canCreate,canApprove,canCancel,onCommitted,onConflict}:{csrfToken:string;canRead:boolean;canCreate:boolean;canApprove:boolean;canCancel:boolean;onCommitted:(value:CleanupReceipt)=>void|Promise<void>;onConflict:()=>void}){
 const [pending,setPending]=useState<Intent|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[attempt,setAttempt]=useState(0),[running,setRunning]=useState(false),[wake,setWake]=useState(0);
 const intent=useRef<Intent|null>(null),active=useRef<AbortController|null>(null),alive=useRef(false),latest=useRef({csrfToken,canRead,canCreate,canApprove,canCancel,onCommitted,onConflict});
 useLayoutEffect(()=>{latest.current={csrfToken,canRead,canCreate,canApprove,canCancel,onCommitted,onConflict};});
 const allowed=(kind:Intent['kind'])=>kind==='create'?latest.current.canCreate:kind==='approve'?latest.current.canApprove:latest.current.canCancel;
 useEffect(()=>{alive.current=true;const pause=()=>{active.current?.abort();setRunning(false);},resume=()=>setWake(value=>value+1);window.addEventListener('offline',pause);window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
  return()=>{alive.current=false;active.current?.abort();intent.current=null;window.removeEventListener('offline',pause);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};},[]);
 useEffect(()=>{if(intent.current&&intent.current.csrfToken!==csrfToken){active.current?.abort();intent.current=null;setPending(null);setRunning(false);setError('管理登录已变化，请查看当前记录。');}},[csrfToken]);
 useEffect(()=>{if(intent.current&&!canRead){active.current?.abort();setRunning(false);}},[canRead]);
 const send=useCallback(async(current:Intent)=>{
  if(active.current||!alive.current||!latest.current.canRead||!navigator.onLine||document.visibilityState==='hidden'||current.csrfToken!==latest.current.csrfToken)return;
  const controller=new AbortController();active.current=controller;setRunning(true);let committed:CleanupReceipt|null=null;
  try{
   if(current.sent){const found=await operationsRequest<CleanupOperation>('/v1/operations/files/cleanup/operations/'+current.body.operationId,{signal:controller.signal});
    if(found.state==='recorded'){const plan=await operationsRequest<CleanupPlan>('/v1/operations/files/cleanup/plans/'+found.planId,{signal:controller.signal});committed={operationId:found.operationId,planId:found.planId,kind:found.kind,plan,replayed:true};}}
   if(!committed){if(!allowed(current.kind))throw new OperationsRequestError(403,'operations_permission_denied');current.sent=true;committed=await operationsRequest<CleanupReceipt>(current.path,{body:current.body,csrfToken:current.csrfToken,signal:controller.signal});}
   if(!alive.current||controller.signal.aborted||intent.current!==current)return;
   intent.current=null;setPending(null);setError('');setMessage(current.kind==='create'?'清理范围已列明，请审阅具体文件。':current.kind==='approve'?'已确认这份计划，系统会逐项核对并清理。':'已取消后续清理。');await latest.current.onCommitted(committed);
  }catch(failure){if(!alive.current||controller.signal.aborted)return;
   if(failure instanceof OperationsRequestError&&failure.status<500&&![408,429].includes(failure.status)){intent.current=null;setPending(null);if(failure.status===409)latest.current.onConflict();setError(cleanupCodes[failure.code]??operationsFailure(failure,'本次处理未完成，请查看当前计划。'));}
   else setError(attempt>=2?'连接暂时中断，系统会自动接续。':'');
  }finally{if(active.current===controller){active.current=null;if(alive.current){setRunning(false);setAttempt(value=>value+1);}}}
 },[attempt]);
 useEffect(()=>{if(!pending||running)return;const timer=setTimeout(()=>void send(pending),Math.min(15000,1000*2**Math.min(attempt,4)));return()=>clearTimeout(timer);},[pending,running,attempt,wake,canRead,canCreate,canApprove,canCancel,send]);
 return{locked:pending!==null,error,message,pending,submit:(kind:Intent['kind'],path:string,body:Record<string,unknown>)=>{if(intent.current||!allowed(kind))return;const next={kind,path,body:{...structuredClone(body),operationId:crypto.randomUUID()},csrfToken,sent:false};intent.current=next;setPending(next);setAttempt(0);setError('');setMessage('');void send(next);}};
}
