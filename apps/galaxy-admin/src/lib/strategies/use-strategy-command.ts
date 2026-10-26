'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from "../operations-client";
import {strategiesCommandResult,strategiesOperationPath} from './strategies-view-model';
import type {StrategyCommandIntent,StrategyCommandKind} from "../../components/strategies/strategies-types";

const errors:Record<string,string>={p13_strategy_revision_changed:'策略已有更新，你的输入已保留。',p13_strategy_draft_changed:'已保存的草稿已有更新，请读取当前版本。',p13_operation_conflict:'原操作内容不一致，请查看当前记录。',p13_rehearsal_required:'请先对已保存草稿完成预演。',p13_rehearsal_changed:'预演所用来源已有变化，请重新预演。',p13_goal_required:'请填写共同目标、对应领域目标和具体策略目标。',p13_strategy_paused:'策略当前暂停，不能开始或继续自动执行。',p13_version_blocked:'此版本已停止，不能直接恢复。',p13_active_version_required:'尚无可启停的生效版本。',p13_execution_already_bound:'这个事项已有运行，请查看原运行。',p13_qualification_required:'当前对象不符合处理条件，请查看预演依据。',p13_current_qualification_changed:'来源或原决定已变化，已停止继续处理。',p13_execution_not_found:'此事项当前不可读取。',p13_run_not_found:'此运行当前不可读取。',p13_run_not_paused:'此运行已不再等待人工，请读取当前状态。',p13_pause_input_mismatch:'等待内容已有变化，请读取当前运行。',p13_recovery_target_unavailable:'所选恢复版本当前不可用。',operations_agentos_model_not_configured:'模型尚未配置，本次未启动AI判断。',operations_agentos_human_review_required:'原决定需要人工复核。',invalid_p13_strategy_request:'请检查目标、策略设置和变更说明。',operations_permission_denied:'当前权限不允许这项操作。'};
export function useStrategyCommand({csrfToken,complete,conflict,denied}:{csrfToken:string;complete:(kind:StrategyCommandKind,value:unknown)=>void|Promise<void>;conflict:()=>void;denied:()=>void}){
 const [busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[status,setStatus]=useState('');
 const intent=useRef<(StrategyCommandIntent&{csrfToken:string})|null>(null),active=useRef<AbortController|null>(null),alive=useRef(false),inFlight=useRef(false),repost=useRef(false),callbacks=useRef({complete,conflict,denied}),requestRef=useRef<(lookup:boolean)=>Promise<void>>(async()=>{});
 useLayoutEffect(()=>{callbacks.current={complete,conflict,denied};});
 useEffect(()=>{alive.current=true;const offline=()=>{active.current?.abort();setBusy(false);inFlight.current=false;if(intent.current){setError('');setStatus('网络已断开，输入已保留，连接后会自动接续。');}};window.addEventListener('offline',offline);return()=>{alive.current=false;active.current?.abort();window.removeEventListener('offline',offline);};},[]);
 useLayoutEffect(()=>{if(intent.current&&intent.current.csrfToken!==csrfToken){active.current?.abort();intent.current=null;inFlight.current=false;setBusy(false);setPending(false);setError('管理登录已变化，原操作不再提交；请查看当前记录。');setStatus('');}},[csrfToken]);
 const request=useCallback(async(lookup:boolean)=>{
  const original=intent.current;if(!original||inFlight.current||!alive.current||!navigator.onLine||document.visibilityState==='hidden'||original.csrfToken!==csrfToken)return;
  const controller=new AbortController();active.current=controller;inFlight.current=true;setBusy(true);
  try{
   let raw:unknown;
   if(lookup){const found=await operationsRequest<Record<string,unknown>>(strategiesOperationPath(original.operationId)!,{signal:controller.signal});if(found.state==='not-recorded'){if(repost.current){setStatus('连接暂时不稳定，正在自动接续。');return;}repost.current=true;raw=await operationsRequest(original.path,{csrfToken:original.csrfToken,body:original.body,signal:controller.signal});}else raw=found.kind==='run'?found:found.result;}
   else raw=await operationsRequest(original.path,{csrfToken:original.csrfToken,body:original.body,signal:controller.signal});
   if(controller.signal.aborted||!alive.current)return;
   const result=strategiesCommandResult(original.kind,raw,original.operationId);if(!result)throw new Error('invalid receipt');
   intent.current=null;setPending(false);setError('');setStatus('');setMessage({draft:'草稿已保存',rehearsal:'预演已完成',publish:'新版已用于新事项',control:'启停状态已记录',run:'运行已建立，当前结果见运行详情',continue:'本次选择已记录，当前结果见运行详情'}[original.kind]);
   await callbacks.current.complete(original.kind,result);
  }catch(failure){if(controller.signal.aborted||!alive.current)return;const known=failure instanceof OperationsRequestError&&failure.status<500&&![408,429].includes(failure.status);
   if(known){intent.current=null;setPending(false);if(failure.status===409)callbacks.current.conflict();if([401,403].includes(failure.status))callbacks.current.denied();}
   setError(known?errors[(failure as OperationsRequestError).code]??operationsFailure(failure,'这次操作未被接受。'):'');if(!known)setStatus('连接暂时不稳定，正在自动接续。');
  }finally{if(active.current===controller){active.current=null;inFlight.current=false;if(alive.current)setBusy(false);}}
 },[csrfToken]);
 useLayoutEffect(()=>{requestRef.current=request;},[request]);
 useEffect(()=>{if(!pending)return;const timer=setInterval(()=>void requestRef.current(true),2500),resume=()=>void requestRef.current(true);window.addEventListener('online',resume);window.addEventListener('focus',resume);return()=>{clearInterval(timer);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);};},[pending]);
 return {busy,pending,error,message,status,receipt:pending&&intent.current?{operationId:intent.current.operationId,kind:intent.current.kind}:null,submit:(kind:StrategyCommandKind,path:string,body:Record<string,unknown>)=>{if(intent.current||inFlight.current||!navigator.onLine)return;const operationId=crypto.randomUUID();intent.current={csrfToken,kind,path,operationId,body:{...structuredClone(body),operationId}};repost.current=false;setError('');setMessage('');setStatus({draft:'正在保存草稿…',rehearsal:'正在预演…',publish:'正在发布…',control:'正在更新启停状态…',run:'正在开始处理…',continue:'正在接续处理…'}[kind]);setPending(true);void requestRef.current(false);}};
}
