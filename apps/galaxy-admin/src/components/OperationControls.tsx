'use client';
import Link from 'next/link';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from '../lib/operations-client';

type Intent={path:string;body:Record<string,unknown>;label:string;csrfToken:string};
type OperationRecovery<T>=(intent:Readonly<Intent>,options:{signal:AbortSignal})=>Promise<{state:'recorded';value:T}|{state:'not-recorded'}>;
type OperationResultValidation<T>=(value:T,intent:Readonly<Pick<Intent,'path'|'body'>>)=>void;
const documentIsHidden=()=>document.visibilityState==='hidden';
const originalResultUnavailable='请求已发送，结果尚未确认。已暂停重复提交，请保留当前页面并查看原操作记录。';
const messages:Record<string,string>={
  account_settings_changed:'资料已有更新，请按当前记录继续。',
  operations_version_changed:'记录已有更新，请按当前内容继续。',
  operation_conflict:'原操作内容不一致，请返回当前记录。',
  business_admin_operation_conflict:'原操作内容不一致，请查看当前记录。',
  operations_source_changed:'来源已有更新，请按当前内容继续。',
  operations_policy_unavailable:'当前规则暂时不可用，请稍后继续。',
};
export function useOperationCommand<T>({csrfToken,canWrite,onCommitted,onConflict,errorMessages={},recover,canRecover=false,validateResult,recoveryPendingMessage}:{csrfToken:string;canWrite:boolean;onCommitted:(value:T)=>void|Promise<void>;onConflict?:()=>void;errorMessages?:Record<string,string>;recover?:OperationRecovery<T>;canRecover?:boolean;validateResult?:OperationResultValidation<T>;recoveryPendingMessage?:string}){
  const [pending,setPending]=useState<Intent|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[attempt,setAttempt]=useState(0);
  const alive=useRef(false),inFlight=useRef(false),controller=useRef<AbortController|null>(null),original=useRef<Intent|null>(null),attempted=useRef(new WeakSet<Intent>()),latest=useRef({csrfToken,canWrite,onCommitted,onConflict,errorMessages,recover,canRecover,validateResult,recoveryPendingMessage});
  useLayoutEffect(()=>{latest.current={csrfToken,canWrite,onCommitted,onConflict,errorMessages,recover,canRecover,validateResult,recoveryPendingMessage};});
  const [online,setOnline]=useState(true),[requesting,setRequesting]=useState(false),[wakeup,setWakeup]=useState(0);
  useEffect(()=>{
    alive.current=true;setOnline(navigator.onLine);
    const pause=()=>{setOnline(false);controller.current?.abort();controller.current=null;inFlight.current=false;setBusy(false);setRequesting(false);};
    const resume=()=>{setOnline(navigator.onLine);setWakeup(value=>value+1);};
    window.addEventListener('offline',pause);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
    return()=>{alive.current=false;controller.current?.abort();window.removeEventListener('offline',pause);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};
  },[]);
  useEffect(()=>{
    if(!original.current||original.current.csrfToken===csrfToken)return;
    controller.current?.abort();controller.current=null;inFlight.current=false;original.current=null;
    setPending(null);setBusy(false);setRequesting(false);setError('管理登录已变化，请重新查看当前记录。');setMessage('');
  },[csrfToken]);
  const send=useCallback(async(intent:Intent,retry:number):Promise<T|undefined>=>{
    const wasAttempted=attempted.current.has(intent);
    // A delayed first request can still commit after a lost ACK. Without a
    // caller-owned original-result reader, neither the timer nor retry may POST it again.
    if(wasAttempted&&!latest.current.recover){setError(originalResultUnavailable);return;}
    const recovering=retry>0&&wasAttempted&&!!latest.current.recover;
    if((!latest.current.canWrite&&!(recovering&&latest.current.canRecover))||intent.csrfToken!==latest.current.csrfToken||inFlight.current||!alive.current||!navigator.onLine||documentIsHidden())return;
    const active=new AbortController();controller.current=active;inFlight.current=true;setRequesting(true);
    if(retry===0){setBusy(true);setError('');setMessage('');}setPending(intent);setAttempt(retry);
    let accepted=false;
    try{
      let value:T;
      if(recovering&&latest.current.recover){
        const receipt=await latest.current.recover(intent,{signal:active.signal});
        if(!alive.current||active.signal.aborted||original.current!==intent||intent.csrfToken!==latest.current.csrfToken||(!latest.current.canWrite&&!latest.current.canRecover)||!navigator.onLine||documentIsHidden())return;
        if(receipt.state==='recorded')value=receipt.value;
        else if(receipt.state==='not-recorded'){if(!latest.current.canWrite)throw Error('Original operation result unavailable');attempted.current.add(intent);value=await operationsRequest<T>(intent.path,{csrfToken:intent.csrfToken,body:intent.body,signal:active.signal});}
        else throw Error('Original operation result unavailable');
      }else{
        // Offline/hidden may retain an intent before any send. Only an actual
        // POST attempt changes it into an unknown result requiring recovery.
        attempted.current.add(intent);
        value=await operationsRequest<T>(intent.path,{csrfToken:intent.csrfToken,body:intent.body,signal:active.signal});
      }
      if(!alive.current||active.signal.aborted||original.current!==intent||intent.csrfToken!==latest.current.csrfToken)return;
      // An unbound 2xx result is still unknown. Preserve the exact original
      // intent so the caller's recovery reads its receipt before any commit.
      try{latest.current.validateResult?.(value,{path:intent.path,body:intent.body});}
      catch{throw Error('Original operation result unavailable');}
      accepted=true;original.current=null;setPending(null);setError('');setMessage(intent.label);await latest.current.onCommitted(value);return value;
    }catch(failure){
      if(!alive.current||active.signal.aborted)return;
      if(accepted){setError('操作已完成，最新内容暂时无法读取。');return;}
      const known=failure instanceof OperationsRequestError&&failure.status<500;
      if(known){original.current=null;setPending(null);if(failure.status===409)latest.current.onConflict?.();
        const detail=latest.current.errorMessages[failure.code]??messages[failure.code];setError(detail??operationsFailure(failure,'这次操作未完成，请查看当前记录。'));
      }else setError(!latest.current.recover?originalResultUnavailable:retry>=2?(latest.current.recoveryPendingMessage??'连接暂时中断，系统正在重连。'):'');
    }finally{if(controller.current===active){controller.current=null;inFlight.current=false;if(alive.current){setBusy(false);setRequesting(false);}}}
  },[]);
  const recoveryAllowed=!!recover&&canRecover&&!!pending&&attempted.current.has(pending);
  useEffect(()=>{
    if(!pending||requesting||(!canWrite&&!recoveryAllowed)||!online||attempted.current.has(pending)&&!recover)return;
    const timer=setTimeout(()=>{void send(pending,attempt+1);},Math.min(10000,1500*2**Math.min(attempt,3)));
    return()=>clearTimeout(timer);
  },[pending,requesting,attempt,canWrite,recoveryAllowed,online,wakeup,send,recover]);
  return {busy,requesting,pending,error,message,online,locked:busy||pending!==null,
    submit:(path:string,body:Record<string,unknown>,label:string)=>{if(original.current||!canWrite)return Promise.resolve(undefined);const intent={path,body:{...structuredClone(body),operationId:crypto.randomUUID()},label,csrfToken};original.current=intent;setPending(intent);setAttempt(0);setError('');setMessage('');if(!navigator.onLine){setOnline(false);return Promise.resolve(undefined);}return send(intent,0);},
    retry:()=>original.current?send(original.current,attempt+1):Promise.resolve(undefined)};
}
export function CommandFeedback({command}:{command:{busy:boolean;pending:unknown;error:string;message:string;online?:boolean;retry:()=>Promise<unknown>}}){
  if(command.pending)return <p className="galaxy-operation-progress" role="status">{command.online===false?'网络已断开，连接恢复后会继续。':command.error||'正在处理…'}</p>;
  return <>{command.error?<p className="galaxy-error" role="alert">{command.error}</p>:command.message?<output role="status">{command.message}</output>:command.busy?<p role="status">正在处理…</p>:null}</>;
}
export function ReadStatus({loading,error,retry,empty}:{loading:boolean;error:string;retry:()=>Promise<unknown>;empty?:boolean}){
  return <>{loading&&<p role="status">正在读取…</p>}{error&&<p className="galaxy-error" role="alert">{error}<button type="button" disabled={loading} onClick={()=>void retry()}>重新读取</button></p>}{!loading&&!error&&empty&&<p>暂无记录。</p>}</>;
}
export function AccountReference({id,label}:{id:string;label?:string|null}){
  return <Link href={'/admin/operations/users?account='+encodeURIComponent(id)} prefetch={false}>{label||'查看账户'}</Link>;
}
