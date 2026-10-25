'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from './operations-client';
import {agentOsErrors,type AgentOsCommand,type AgentOsDomain} from './agentos-client';

export type WorkbenchIntent={path:string;body:Record<string,unknown>;label:string;csrfToken:string;domain:AgentOsDomain;lookupPath?:string;attempted:boolean};
// Same-tab memory only. No original message, CSRF or command body is persisted.
const retainedIntents=new Map<string,WorkbenchIntent>();
type Props={operatorId:string|null;csrfToken:string;canWrite:boolean;domain:AgentOsDomain;permittedDomains:AgentOsDomain[];memoryLane?:string;currentToken:(domain:AgentOsDomain)=>Promise<string|null>;validateResult?:(value:AgentOsCommand,intent:WorkbenchIntent)=>boolean;onCommitted:(value:AgentOsCommand,path:string,body:Record<string,unknown>)=>void|Promise<void>;onProgress?:()=>void|Promise<unknown>;onConflict:()=>void;onDenied:()=>void};

export function useWorkbenchCommand({operatorId,csrfToken,canWrite,domain,permittedDomains,memoryLane='',currentToken,validateResult,onCommitted,onProgress,onConflict,onDenied}:Props){
 const memoryKey=operatorId?operatorId+(memoryLane?':'+memoryLane:''):null;
 const restored=useRef(memoryKey?retainedIntents.get(memoryKey):undefined);
 const [pending,setPending]=useState<WorkbenchIntent|null>(restored.current??null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[attempt,setAttempt]=useState(0);
 const ambiguous=useRef(!!restored.current),requestToken=useRef(csrfToken||restored.current?.csrfToken||'');
 const alive=useRef(false),inFlight=useRef(false),active=useRef<AbortController|null>(null),intent=useRef<WorkbenchIntent|null>(restored.current??null),callbacks=useRef({canWrite,permittedDomains,currentToken,validateResult,onCommitted,onProgress,onConflict,onDenied}),sendRef=useRef<(value:WorkbenchIntent)=>Promise<AgentOsCommand|undefined>>(async()=>undefined);
 const permissionKey=permittedDomains.join(',');
 useLayoutEffect(()=>{callbacks.current={canWrite,permittedDomains,currentToken,validateResult,onCommitted,onProgress,onConflict,onDenied};});
 useLayoutEffect(()=>{
  if(!intent.current||permittedDomains.includes(intent.current.domain))return;
  ambiguous.current=true;active.current?.abort();active.current=null;inFlight.current=false;setBusy(false);
 },[permissionKey]);
 useLayoutEffect(()=>{
  if(!csrfToken)return;
  if(requestToken.current&&requestToken.current!==csrfToken){active.current?.abort();active.current=null;inFlight.current=false;intent.current=null;ambiguous.current=false;if(memoryKey)retainedIntents.delete(memoryKey);setPending(null);setBusy(false);setError('');setMessage('');}
  requestToken.current=csrfToken;
 },[csrfToken,memoryKey]);
 const send=useCallback(async(value:WorkbenchIntent)=>{
  if(!alive.current||inFlight.current||!callbacks.current.permittedDomains.includes(value.domain)||!csrfToken||value.csrfToken!==csrfToken||!navigator.onLine||document.visibilityState==='hidden')return;
  const controller=new AbortController();active.current=controller;inFlight.current=true;setBusy(true);
  let accepted=false,readingOriginal=false;
  const write=async()=>{
   const current=await callbacks.current.currentToken(value.domain);
   if(controller.signal.aborted||!alive.current||current!==value.csrfToken||requestToken.current!==value.csrfToken||!callbacks.current.permittedDomains.includes(value.domain)||!navigator.onLine||document.visibilityState==='hidden')return undefined;
   // This flag is set before fetch, including network failures with no ACK.
   value.attempted=true;
   return operationsRequest<AgentOsCommand>(value.path,{csrfToken:value.csrfToken,body:value.body,signal:controller.signal});
  };
  try{
   let result:AgentOsCommand|undefined;
   if((ambiguous.current||value.attempted)&&value.lookupPath){
    readingOriginal=true;
    try{
     result=await operationsRequest<AgentOsCommand>(value.lookupPath,{signal:controller.signal});
     // A prepared projection cannot disprove a delayed original POST.
     // Recovery is GET-only for every attempted card intent.
    }catch(failure){
     if(!(failure instanceof OperationsRequestError)||failure.status!==404||value.attempted)throw failure;
     readingOriginal=false;result=await write();
    }
   }else result=await write();
   if(!result||controller.signal.aborted||!alive.current)return;
   if(value.lookupPath&&result.operationId!==value.body.operationId)throw new Error('Invalid original conversation result');
   const cardIntent=typeof value.body.cardId==='string',cardResult=result as AgentOsCommand&{cardId?:unknown;result?:{operationId?:unknown;state?:unknown}|null};
   if(cardIntent&&cardResult.cardId!==value.body.cardId)throw new Error('Invalid original card result');
   if(result.state!=='not-recorded'&&callbacks.current.validateResult&&!callbacks.current.validateResult(result,value))throw new Error('Invalid original intent result');
   const cardTerminal=!cardIntent||cardResult.result?.operationId===value.body.operationId&&(result.state==='completed'&&cardResult.result?.state==='completed'||result.state==='not-available'&&['cancelled','failed','not-available'].includes(String(cardResult.result?.state)));
   if(['unknown','dispatching','not-recorded'].includes(result.state??'')||cardIntent&&!cardTerminal){
    ambiguous.current=true;setAttempt(previous=>previous+1);await callbacks.current.onProgress?.();return;
   }
   accepted=true;intent.current=null;if(memoryKey)retainedIntents.delete(memoryKey);setPending(null);setError('');setMessage(result.state==='not-started'?'本次未启动，输入已保留。':value.label);
   await callbacks.current.onCommitted(result,value.path,value.body);return result;
  }catch(failure){
   if(controller.signal.aborted||!alive.current)return;
   if(accepted){setError('操作已记录，当前内容暂时无法读取。');return;}
   const known=failure instanceof OperationsRequestError&&((failure.status<500&&![408,429].includes(failure.status)&&!(readingOriginal&&failure.status===404))||!readingOriginal&&['operations_agentos_not_configured','operations_agentos_model_not_configured','operations_agentos_conversation_not_ready','operations_agentos_conversation_transport_unavailable'].includes(failure.code));
   if(known){intent.current=null;if(memoryKey)retainedIntents.delete(memoryKey);setPending(null);if(failure.status===409)callbacks.current.onConflict();if([401,403].includes(failure.status))callbacks.current.onDenied();setError(agentOsErrors[failure.code]??operationsFailure(failure,'这次操作未能完成。'));}
   else{ambiguous.current=true;setError('');setAttempt(previous=>previous+1);}
  }finally{if(active.current===controller){active.current=null;inFlight.current=false;if(alive.current)setBusy(false);}}
 },[csrfToken,memoryKey]);
 useLayoutEffect(()=>{sendRef.current=send;},[send]);
 const cancel=useCallback(()=>{active.current?.abort();active.current=null;inFlight.current=false;intent.current=null;ambiguous.current=false;if(memoryKey)retainedIntents.delete(memoryKey);setPending(null);setBusy(false);setError('');setMessage('');},[memoryKey]);
 useEffect(()=>{
  alive.current=true;
  const offline=()=>{if(intent.current)ambiguous.current=true;active.current?.abort();active.current=null;inFlight.current=false;setBusy(false);};
  const resume=()=>{if(intent.current)void sendRef.current(intent.current);};
  window.addEventListener('offline',offline);window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
  return()=>{alive.current=false;active.current?.abort();window.removeEventListener('offline',offline);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
 },[]);
 useEffect(()=>{if(!pending||busy||!permittedDomains.includes(pending.domain))return;const timer=setTimeout(()=>void sendRef.current(pending),Math.min(10000,1500*2**Math.min(attempt,3)));return()=>clearTimeout(timer);},[pending,busy,attempt,permissionKey]);
 return{pending,busy,error,message,cancel,locked:busy||pending!==null,submit:(path:string,body:Record<string,unknown>,label:string,lookup?:(operationId:string)=>string,fixedOperationId?:string)=>{
  if(intent.current||!callbacks.current.canWrite||!csrfToken||!navigator.onLine)return Promise.resolve(undefined);
  const operationId=fixedOperationId??crypto.randomUUID(),value:WorkbenchIntent={path,body:{...structuredClone(body),operationId},label,csrfToken,domain,lookupPath:lookup?.(operationId),attempted:false};
  ambiguous.current=false;intent.current=value;if(memoryKey)retainedIntents.set(memoryKey,value);setPending(value);setAttempt(0);setError('');setMessage('');return sendRef.current(value);
 }};
}
