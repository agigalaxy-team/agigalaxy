'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from "../operations-client";
import {searchQualityOperationPath,searchQualityOperationResult,searchQualityPending,searchQualityPhase} from './search-quality-view-model';
import type {SearchQualityLease,SearchQualityOperation,SearchQualityOperationResult,SearchQualityOverview} from "../../components/search/search-quality-types";

const errors:Record<string,string>={
 search_quality_revision_changed:'配置已有更新，你的草稿已保留。',search_quality_draft_changed:'已保存的草稿已有更新，请查看当前版本。',search_quality_operation_pending:'另一项配置正在处理，请等待当前结果。',search_quality_operation_conflict:'这次提交的内容不一致，请查看版本记录。',search_quality_native_drift:'搜索服务设置已有变化，暂不能应用或恢复。',search_quality_native_busy:'搜索服务正在处理其他配置，稍后可继续。',search_quality_version_unavailable:'此版本当前不可用，请重新读取记录。',search_quality_version_not_applied:'此草稿未曾生效，不能作为历史配置恢复。',search_quality_native_task_failed:'搜索服务未能应用此配置，原生效版本保留。',search_quality_native_readback_mismatch:'搜索服务尚未返回生效结果。',discovery_search_not_connected:'搜索服务尚未连接。',invalid_search_quality_request:'请检查同义词、排序和变更说明。',operations_permission_denied:'当前权限不允许这项操作。',business_admin_denied:'当前管理身份已变化，请重新登录。',
};
type CommandIntent={csrfToken:string;kind:SearchQualityOperation['kind'];body:Record<string,unknown>;operationId:string};
type CommandOptions={csrfToken:string;data:SearchQualityOverview|null;denied:boolean;onComplete:(value:SearchQualityOperationResult)=>void|Promise<void>;onConflict:()=>void};
export function useSearchQualityCommand(options:CommandOptions){
 const [operation,setOperation]=useState<SearchQualityOperationResult|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[pendingIntent,setPendingIntent]=useState(false),[recoveryRequired,setRecoveryRequired]=useState(false),[kind,setKind]=useState<SearchQualityOperation['kind']>('draft');
 const intent=useRef<CommandIntent|null>(null),tracked=useRef<SearchQualityOperationResult|null>(null),active=useRef<AbortController|null>(null),alive=useRef(false),inFlight=useRef(false),finished=useRef(new Set<string>()),failures=useRef(0),paused=useRef(false),latest=useRef(options),requestRef=useRef<(mode:'post'|'lookup')=>Promise<void>>(async()=>{});latest.current=options;
 const stop=useCallback(()=>{active.current?.abort();active.current=null;inFlight.current=false;if(alive.current)setBusy(false);},[]);
 const reconnect=useCallback(()=>{if(!navigator.onLine||document.visibilityState==='hidden')return;failures.current=0;paused.current=false;setRecoveryRequired(false);setError('');void requestRef.current('lookup');},[]);
 useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;stop();intent.current=null;tracked.current=null;};},[stop]);
 useLayoutEffect(()=>{if(!options.data)stop();if(options.denied){intent.current=null;tracked.current=null;setPendingIntent(false);setOperation(null);setRecoveryRequired(false);setError('');}},[options.data,options.denied,stop]);
 useEffect(()=>{const offline=()=>{stop();if(intent.current||tracked.current&&searchQualityPending(tracked.current))setError('网络已断开，连接恢复后会继续。');},visible=()=>{if(document.visibilityState==='visible')reconnect();else stop();};window.addEventListener('offline',offline);window.addEventListener('online',reconnect);window.addEventListener('focus',reconnect);document.addEventListener('visibilitychange',visible);return()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',reconnect);window.removeEventListener('focus',reconnect);document.removeEventListener('visibilitychange',visible);};},[stop,reconnect]);
 const accept=useCallback(async(value:unknown)=>{const result=searchQualityOperationResult(value);if(!result)throw new Error('invalid operation result');tracked.current=result;setOperation(result);setKind(result.kind);setError('');failures.current=0;paused.current=false;setRecoveryRequired(false);if(!searchQualityPending(result)&&!finished.current.has(result.operationId)){finished.current.add(result.operationId);intent.current=null;setPendingIntent(false);setMessage(searchQualityPhase(result));if(result.phase==='failed')setError(errors[result.errorCode??'']??'本次配置未生效，请查看当前版本。');await latest.current.onComplete(result);}return result;},[]);
 useLayoutEffect(()=>{if(intent.current&&intent.current.csrfToken!==options.csrfToken){stop();intent.current=null;tracked.current=null;setPendingIntent(false);setOperation(null);setRecoveryRequired(false);setError('管理登录已变化，原操作不再提交；请查看当前记录。');}},[options.csrfToken,stop]);
 const request=useCallback(async(mode:'post'|'lookup')=>{
  const original=intent.current,id=original?.operationId??tracked.current?.operationId,data=latest.current.data;
  if(!id||inFlight.current||!alive.current||!navigator.onLine||document.visibilityState==='hidden'||!data||data.readExpiresAt*1000<=Date.now()||latest.current.denied||original&&original.csrfToken!==latest.current.csrfToken)return;
  const controller=new AbortController();active.current=controller;inFlight.current=true;if(mode==='post')setBusy(true);
  const live=()=>alive.current&&!controller.signal.aborted&&active.current===controller&&(!original||original.csrfToken===latest.current.csrfToken);
  const post=async()=>{const fresh=latest.current.data;if(!fresh||fresh.readExpiresAt*1000<=Date.now()){controller.abort();throw new Error('read lease expired');}const allowed=original&&((original.kind==='draft'?fresh.capabilities.canConfigure:original.kind==='apply'?fresh.capabilities.canPublish:fresh.capabilities.canRestore)||fresh.configuration.pending?.operationId===original.operationId);if(!allowed)throw new OperationsRequestError(403,'operations_permission_denied');return operationsRequest('/v1/operations/search-quality/'+original!.kind,{csrfToken:original!.csrfToken,body:{...original!.body,operationId:original!.operationId},signal:controller.signal});};
  let writing=mode==='post';
  try{
   let raw:unknown;
   if(mode==='post'&&original)raw=await post();
   else try{raw=await operationsRequest(searchQualityOperationPath(id)!,{signal:controller.signal});}catch(failure){if(!(failure instanceof OperationsRequestError)||failure.status!==404||!original)throw failure;writing=true;raw=await post();}
   if(!live())return;
   // Only a confirmed prepared intent may be resumed. Pending or unknown native
   // results are looked up with the same ID, never submitted a second time.
   if(!writing&&original&&searchQualityOperationResult(raw)?.phase==='prepared'){writing=true;raw=await post();if(!live())return;}
   await accept(raw);
  }catch(failure){
   if(!live())return;const known=failure instanceof OperationsRequestError&&failure.status<500&&![408,429].includes(failure.status),denied=failure instanceof OperationsRequestError&&[401,403].includes(failure.status);
   if(known&&(writing||denied||failure.status===404)){intent.current=null;setPendingIntent(false);tracked.current=null;setOperation(null);if(denied||failure.status===409||failure.status===404)latest.current.onConflict();setError(errors[failure.code]??operationsFailure(failure,failure.status===404?'这条配置记录已不可用，请查看当前配置。':'这次操作未被接受，修改已保留。'));paused.current=false;setRecoveryRequired(false);}
   else{failures.current++;paused.current=failures.current>=3;setRecoveryRequired(paused.current);setError(paused.current?'暂时无法连接搜索服务，修改已保留。':'');}
  }finally{if(active.current===controller){active.current=null;inFlight.current=false;if(alive.current)setBusy(false);}}
 },[accept]);
 useLayoutEffect(()=>{requestRef.current=request;},[request]);
 const pending=pendingIntent||!!operation&&searchQualityPending(operation);
 useEffect(()=>{if(!pending)return;const timer=setInterval(()=>{if(!paused.current)void requestRef.current('lookup');},2500);return()=>clearInterval(timer);},[pending]);
 const watch=useCallback((value:SearchQualityOperation|null,meta:SearchQualityLease|null)=>{if(!value||!meta||finished.current.has(value.operationId)||intent.current)return;const result={...meta,...value};tracked.current=result;setKind(value.kind);setOperation(previous=>previous?.operationId===value.operationId&&previous.updatedAt===value.updatedAt?previous:result);},[]);
 return {busy,error,message,operation,pending,recoveryRequired,kind,receipt:pending&&intent.current?{operationId:intent.current.operationId,kind:intent.current.kind}:null,watch,retry:reconnect,submit:(action:CommandIntent['kind'],body:Record<string,unknown>)=>{if(inFlight.current||intent.current||!navigator.onLine||!latest.current.data)return;intent.current={csrfToken:latest.current.csrfToken,kind:action,body:structuredClone(body),operationId:crypto.randomUUID()};failures.current=0;paused.current=false;setRecoveryRequired(false);setKind(action);setPendingIntent(true);setOperation(null);tracked.current=null;setError('');setMessage('');void requestRef.current('post');}};
}
