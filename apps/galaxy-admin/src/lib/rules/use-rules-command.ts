'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from "../operations-client";
import {rulesClone,rulesErrors} from './rules-view-model';
import type {RulesDetail,RulesKey,RulesOperation,RulesPolicy,RulesReceipt,RulesSaved} from "../../components/rules/rules-types";

const available=<T extends {readExpiresAt:number},>(value:T|null):T|null=>value&&value.readExpiresAt*1000>Date.now()?value:null;
type Request={operationId:string;kind:RulesReceipt['kind'];body:Record<string,unknown>;attempted:boolean;receipt?:RulesReceipt};
type Flow={csrfToken:string;key:RulesKey;mode:'draft'|'publish'|'restore';policy:RulesPolicy;revision:number;reason:string;versionId:string|null;stage:RulesReceipt['kind'];request:Request|null;polls:number;failures:number};
type CommandOptions={csrfToken:string;detail:RulesDetail|null;canWrite:boolean;denied:boolean;read:()=>Promise<RulesDetail|undefined>;onSaved:(key:RulesKey,policy:RulesPolicy,revision:number)=>void;onDone:()=>Promise<unknown>;onDenied:()=>void};
export function useRulesCommand(options:CommandOptions){
 const [state,setState]=useState({busy:false,pending:false,error:'',message:'',stage:'draft' as RulesReceipt['kind'],recoveryRequired:false}),flow=useRef<Flow|null>(null),latest=useRef(options),controller=useRef<AbortController|null>(null),generation=useRef(0),inFlight=useRef(false),alive=useRef(false),runner=useRef<()=>Promise<void>>(async()=>{});latest.current=options;
 const stop=useCallback((discard=false)=>{generation.current++;controller.current?.abort();controller.current=null;inFlight.current=false;if(discard)flow.current=null;if(alive.current)setState(previous=>previous.busy?{...previous,busy:false}:previous);},[]);
 useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;stop(true);};},[stop]);
 useLayoutEffect(()=>{if(!options.detail)stop(false);if(!options.canWrite)stop(true);},[options.detail,options.canWrite,stop]);
 useEffect(()=>{if(options.denied||!options.canWrite){stop(true);setState(previous=>({...previous,busy:false,pending:false,error:'',message:'',recoveryRequired:false}));}},[options.denied,options.canWrite,stop]);
 const reconnect=useCallback(()=>{if(!navigator.onLine||document.visibilityState==='hidden')return;if(flow.current)flow.current.failures=0;setState(previous=>({...previous,recoveryRequired:false,error:''}));void runner.current();},[]);
 useEffect(()=>{const suspend=()=>{stop(false);if(!navigator.onLine&&flow.current)setState(previous=>({...previous,error:'网络已断开，连接恢复后会继续。',recoveryRequired:false}));},visible=()=>{if(document.visibilityState==='visible')reconnect();else stop(false);};window.addEventListener('offline',suspend);window.addEventListener('online',reconnect);window.addEventListener('focus',reconnect);document.addEventListener('visibilitychange',visible);return()=>{window.removeEventListener('offline',suspend);window.removeEventListener('online',reconnect);window.removeEventListener('focus',reconnect);document.removeEventListener('visibilitychange',visible);};},[stop,reconnect]);
 useLayoutEffect(()=>{if(flow.current&&flow.current.csrfToken!==options.csrfToken){stop(true);setState(previous=>({...previous,busy:false,pending:false,recoveryRequired:false,error:'管理登录已变化，原操作不再提交；请查看当前记录。'}));}},[options.csrfToken,stop]);
 const run=useCallback(async()=>{
  const intent=flow.current,currentDetail=available(latest.current.detail);if(!latest.current.canWrite||!intent||inFlight.current||!alive.current||!navigator.onLine||document.visibilityState==='hidden'||!currentDetail||currentDetail.key!==intent.key||intent.csrfToken!==latest.current.csrfToken)return;
  const permitted=(kind:RulesReceipt['kind'],detail:RulesDetail)=>kind==='draft'?detail.capabilities.canEdit:kind==='publish'?detail.capabilities.canPublish:detail.capabilities.canRestore;
  if(!permitted(intent.stage,currentDetail)){stop(true);setState(previous=>({...previous,busy:false,pending:false,error:'当前没有这项规则操作权限。',message:'',recoveryRequired:false}));return;}
  const active=new AbortController(),number=++generation.current;controller.current=active;inFlight.current=true;setState(previous=>({...previous,busy:true,pending:true,error:'',message:'',stage:intent.stage,recoveryRequired:false}));
  const live=()=>alive.current&&!active.signal.aborted&&generation.current===number;
  const canContinue=()=>live()&&intent.csrfToken===latest.current.csrfToken&&latest.current.canWrite&&!!available(latest.current.detail);
  try{
   while(canContinue()){
    if(!intent.request){const operationId=crypto.randomUUID();intent.request={operationId,kind:intent.stage,attempted:false,body:{operationId,expectedRevision:intent.revision,reason:intent.reason,...(intent.stage==='draft'?{policy:intent.policy}:{versionId:intent.versionId})}};}
    const request=intent.request;
    const post=async()=>{request.attempted=true;return operationsRequest<RulesSaved>('/v1/operations/rules/'+intent.key+'/'+request.kind,{csrfToken:intent.csrfToken,body:request.body,signal:active.signal});};
    let receipt=request.receipt;
    if(!receipt){if(!request.attempted)receipt=await post();else{const original=await operationsRequest<RulesOperation>('/v1/operations/rules/operations/'+request.operationId,{signal:active.signal});if(!canContinue())return;receipt=original.state==='recorded'?original:await post();}request.receipt=receipt;intent.failures=0;}
    if(!canContinue())return;
    const fresh=await latest.current.read();if(!live())return;
    const stored=fresh?.draft?.id===receipt.versionId?fresh.draft.policy:fresh?.active.id===receipt.versionId?fresh.active.policy:null;if(stored)intent.policy=rulesClone(stored);
    latest.current.onSaved(intent.key,intent.policy,receipt.revision);
    if(request.kind==='draft'&&intent.mode==='publish'){
     if(!fresh){intent.polls++;intent.failures++;setState(previous=>({...previous,pending:true,recoveryRequired:intent.failures>=3,error:intent.failures>=3?'草稿已保存，暂时无法连接规则服务。':''}));return;}
     if(fresh.key!==intent.key||fresh.revision!==receipt.revision||fresh.draft?.id!==receipt.versionId){flow.current=null;setState(previous=>({...previous,busy:true,pending:false,error:'草稿已保存，当前规则又有更新。合并后可继续发布。',message:'',recoveryRequired:false}));return;}
     if(!fresh.capabilities.canPublish){flow.current=null;setState(previous=>({...previous,busy:true,pending:false,error:'草稿已保存，当前没有发布权限。',message:'',recoveryRequired:false}));return;}
     intent.stage='publish';intent.revision=receipt.revision;intent.versionId=receipt.versionId;intent.request=null;intent.polls=0;intent.failures=0;setState(previous=>({...previous,stage:'publish'}));continue;
    }
    flow.current=null;setState(previous=>({...previous,busy:true,pending:false,error:'',message:request.kind==='draft'?'草稿已保存，尚未发布。':request.kind==='restore'?'历史设置已作为新版本发布。':'规则已发布。',recoveryRequired:false}));await latest.current.onDone();return;
   }
  }catch(error){
   if(!live())return;
   const known=error instanceof OperationsRequestError&&error.status<500&&![408,429].includes(error.status),denied=error instanceof OperationsRequestError&&[401,403].includes(error.status);
   if(known){flow.current=null;if(denied)latest.current.onDenied();else void latest.current.read();}else{intent.polls++;intent.failures++;}
   setState(previous=>({...previous,pending:!known,recoveryRequired:!known&&intent.failures>=3,error:known&&error instanceof OperationsRequestError?(error.code==='operations_command_changed'?'这次提交的内容不一致，修改已保留。':rulesErrors[error.code]??operationsFailure(error,'这次操作未被接受，修改已保留。')):intent.failures>=3?'暂时无法连接规则服务，修改已保留。':''}));
  }finally{if(controller.current===active){inFlight.current=false;controller.current=null;if(alive.current)setState(previous=>({...previous,busy:false}));}}
 },[stop]);
 runner.current=run;
 useEffect(()=>{if(!state.pending||state.busy||state.recoveryRequired||!options.detail||!flow.current)return;const timer=setTimeout(()=>{void run();},Math.min(8000,1500*Math.max(1,flow.current.polls)));return()=>clearTimeout(timer);},[state.pending,state.busy,state.recoveryRequired,options.detail,run]);
 return {...state,receipt:state.pending&&flow.current?.request?{operationId:flow.current.request.operationId,kind:flow.current.request.kind}:null,locked:state.busy||state.pending,retry:reconnect,start:(input:Omit<Flow,'csrfToken'|'request'|'polls'|'failures'|'stage'>)=>{if(flow.current||inFlight.current||!available(latest.current.detail))return;const stage=input.mode==='restore'?'restore':'draft';flow.current={...input,csrfToken:latest.current.csrfToken,policy:rulesClone(input.policy),request:null,polls:0,failures:0,stage};setState({busy:false,pending:true,error:'',message:'',stage,recoveryRequired:false});void run();}};
}
