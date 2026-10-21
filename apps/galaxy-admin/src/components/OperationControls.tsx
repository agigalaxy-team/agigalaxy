'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from '../lib/operations-client';

type Intent={path:string;body:Record<string,unknown>;label:string};
const messages:Record<string,string>={
  account_settings_changed:'资料已有更新，请按当前记录继续。',
  operations_version_changed:'记录已有更新，请按当前内容继续。',
  operation_conflict:'原操作内容不一致，请返回当前记录。',
  business_admin_operation_conflict:'原操作内容不一致，请查看当前记录。',
  operations_source_changed:'来源已有更新，请按当前内容继续。',
  operations_policy_unavailable:'当前规则暂时不可用，请稍后继续。',
};
export function useOperationCommand<T>({csrfToken,canWrite,onCommitted,onConflict,errorMessages={}}:{csrfToken:string;canWrite:boolean;onCommitted:(value:T)=>void|Promise<void>;onConflict?:()=>void;errorMessages?:Record<string,string>}){
  const [pending,setPending]=useState<Intent|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[attempt,setAttempt]=useState(0);
  const alive=useRef(false),inFlight=useRef(false),controller=useRef<AbortController|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
  const send=useCallback(async(intent:Intent,retry:number):Promise<T|undefined>=>{
    if(!canWrite||inFlight.current||!alive.current)return;
    const active=new AbortController();controller.current=active;inFlight.current=true;
    setBusy(true);setError('');setMessage('');setPending(intent);setAttempt(retry);
    let accepted=false;
    try{
      const value=await operationsRequest<T>(intent.path,{csrfToken,body:intent.body,signal:active.signal});
      if(!alive.current)return;
      accepted=true;setPending(null);setMessage(intent.label);await onCommitted(value);return value;
    }catch(failure){
      if(!alive.current||active.signal.aborted)return;
      if(accepted){setError('已保存，当前状态暂时无法读取。');return;}
      const known=failure instanceof OperationsRequestError&&failure.status<500;
      if(known){setPending(null);if(failure.status===409)onConflict?.();}
      const detail=failure instanceof OperationsRequestError?errorMessages[failure.code]??messages[failure.code]:undefined;
      setError(detail??operationsFailure(failure,known?'这次操作未被接受，请查看当前记录。':'结果暂未确认，正在继续原操作。'));
    }finally{inFlight.current=false;if(controller.current===active)controller.current=null;if(alive.current)setBusy(false);}
  },[canWrite,csrfToken,onCommitted,onConflict,errorMessages]);
  useEffect(()=>{
    if(!pending||busy||attempt!==0||!canWrite)return;
    const timer=setTimeout(()=>{if(navigator.onLine)void send(pending,1);},1500);
    return()=>clearTimeout(timer);
  },[pending,busy,attempt,canWrite,send]);
  return {busy,pending,error,message,locked:busy||pending!==null,
    submit:(path:string,body:Record<string,unknown>,label:string)=>pending?Promise.resolve(undefined):send({path,body:{...body,operationId:crypto.randomUUID()},label},0),
    retry:()=>pending?send(pending,attempt+1):Promise.resolve(undefined)};
}
export function CommandFeedback({command}:{command:{busy:boolean;pending:unknown;error:string;message:string;retry:()=>Promise<unknown>}}){
  return <>{command.error&&<p className="galaxy-error" role="alert">{command.error}{!!command.pending&&!command.busy&&<button type="button" onClick={()=>void command.retry()}>继续原操作</button>}</p>}{command.message&&<output role="status">{command.message}</output>}{command.busy&&<p role="status">正在保存…</p>}</>;
}
export function ReadStatus({loading,error,retry,empty}:{loading:boolean;error:string;retry:()=>Promise<unknown>;empty?:boolean}){
  return <>{loading&&<p role="status">正在读取…</p>}{error&&<p className="galaxy-error" role="alert">{error}<button type="button" disabled={loading} onClick={()=>void retry()}>重新读取</button></p>}{!loading&&!error&&empty&&<p>暂无记录。</p>}</>;
}
export function AccountReference({id,label}:{id:string;label?:string|null}){
  return <a href={'/admin/operations/users?account='+encodeURIComponent(id)}>{label||'查看账户'}</a>;
}
