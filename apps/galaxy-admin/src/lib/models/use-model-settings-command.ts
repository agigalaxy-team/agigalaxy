'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from "../operations-client";
import {modelSettingsClone,modelSettingsErrors,modelSettingsSafeConfiguration} from './model-settings-view-model';
import type {ModelSettingsConfiguration,ModelSettingsOperation,ModelSettingsOperationResult,ModelSettingsOverview} from "../../components/models/model-settings-types";

const base='/v1/operations/model-settings';
const readable=<T extends {readExpiresAt:number},>(value:T|null)=>value&&value.readExpiresAt*1000>Date.now()?value:null;
type RequestIntent={operationId:string;kind:ModelSettingsOperation['kind'];path:string;body:Record<string,unknown>;attempted:boolean};
type SaveFlow={csrfToken:string;mode:'draft'|'apply'|'apply-existing';configuration:ModelSettingsConfiguration;revision:number;versionId:string|null;keys:{modelId:string;apiKey:string}[];keyIndex:number;stage:'credentials'|'draft'|'apply';request:RequestIntent|null;polls:number;failures:number};
type CommandState={busy:boolean;pending:boolean;message:string;error:string;operation:ModelSettingsOperation|null;step:ModelSettingsOperation['kind']|null;mode:SaveFlow['mode']|null;recoveryRequired:boolean};
type ModelCommandOptions={csrfToken:string;overview:ModelSettingsOverview|null;denied:boolean;read:()=>Promise<ModelSettingsOverview|undefined>;onSaved:(configuration:ModelSettingsConfiguration,revision:number)=>void;onCredential:(modelId:string,reference:string)=>void;onDone:()=>Promise<unknown>;onDenied:()=>void};

export function useModelSettingsCommand(options:ModelCommandOptions){
 const [state,setState]=useState<CommandState>({busy:false,pending:false,message:'',error:'',operation:null,step:null,mode:null,recoveryRequired:false});
 const latest=useRef(options);latest.current=options;
 const flow=useRef<SaveFlow|null>(null),alive=useRef(false),inFlight=useRef(false),controller=useRef<AbortController|null>(null),generation=useRef(0),runner=useRef<()=>Promise<void>>(async()=>{});
 function erase(intent:SaveFlow|null){if(!intent)return;intent.keys.forEach(key=>{key.apiKey='';});if(intent.request?.kind==='credential-provision')delete intent.request.body.apiKey;}
 const stop=useCallback((discard=false)=>{generation.current++;controller.current?.abort();controller.current=null;if(discard){erase(flow.current);flow.current=null;}},[]);
 useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;stop(true);};},[stop]);
 useEffect(()=>{
  const suspend=()=>stop(false),resume=()=>{if(navigator.onLine&&document.visibilityState==='visible'){if(flow.current)flow.current.failures=0;setState(previous=>({...previous,recoveryRequired:false,error:previous.pending?'':previous.error}));void runner.current();}},visible=()=>document.visibilityState==='hidden'?suspend():resume();
  window.addEventListener('offline',suspend);window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',visible);
  return()=>{window.removeEventListener('offline',suspend);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',visible);};
 },[stop]);
 useEffect(()=>{if(!options.overview)stop(false);},[options.overview,stop]);
 useEffect(()=>{if(!options.denied)return;stop(true);setState(previous=>({...previous,busy:false,pending:false,message:'',operation:null,step:null,recoveryRequired:false}));},[options.denied,stop]);
 useLayoutEffect(()=>{if(flow.current&&flow.current.csrfToken!==options.csrfToken){stop(true);setState(previous=>({...previous,busy:false,pending:false,operation:null,step:null,recoveryRequired:false,error:'管理登录已变化，原操作不再提交；请查看当前记录。'}));}},[options.csrfToken,stop]);
 const run=useCallback(async()=>{
  const intent=flow.current;if(!intent||inFlight.current||!alive.current||!navigator.onLine||document.visibilityState==='hidden'||!readable(latest.current.overview)||intent.csrfToken!==latest.current.csrfToken)return;
  const requestGeneration=++generation.current,active=new AbortController();controller.current=active;inFlight.current=true;
  setState(previous=>({...previous,busy:true,pending:true,error:'',recoveryRequired:false}));
  const current=()=>alive.current&&!active.signal.aborted&&generation.current===requestGeneration;
  const hasCurrentRead=()=>current()&&intent.csrfToken===latest.current.csrfToken&&!!readable(latest.current.overview);
  try{
   while(hasCurrentRead()){
    if(!intent.request){
     const operationId=crypto.randomUUID();
     if(intent.stage==='credentials'){
      const key=intent.keys[intent.keyIndex];if(!key){intent.stage='draft';continue;}
      intent.request={operationId,kind:'credential-provision',path:base+'/credentials',body:{operationId,modelRecordId:key.modelId,apiKey:key.apiKey},attempted:false};
     }else if(intent.stage==='draft'){
      intent.request={operationId,kind:'draft',path:base+'/draft',body:{operationId,expectedRevision:intent.revision,configuration:modelSettingsSafeConfiguration(intent.configuration),reason:intent.mode==='apply'?'人工保存并应用模型设置':'人工保存模型配置草稿'},attempted:false};
     }else{
      if(!intent.versionId)throw new Error('model_settings_draft_changed');
      intent.request={operationId,kind:'apply',path:base+'/apply',body:{operationId,expectedRevision:intent.revision,versionId:intent.versionId,reason:'人工应用模型设置'},attempted:false};
     }
    }
    const request=intent.request;setState(previous=>({...previous,step:request.kind,message:''}));let result:ModelSettingsOperationResult;
    const post=async()=>{request.attempted=true;return operationsRequest<ModelSettingsOperationResult>(request.path,{csrfToken:intent.csrfToken,body:request.body,signal:active.signal});};
    if(!request.attempted)result=await post();else{
     try{result=await operationsRequest<ModelSettingsOperationResult>(base+'/operations/'+request.operationId,{signal:active.signal});}
     catch(error){if(error instanceof OperationsRequestError&&error.status===404)result=await post();else throw error;}
     if(result.phase==='prepared'&&request.kind!=='draft')result=await post();
    }
    if(!hasCurrentRead())return;
    if(result.phase!=='applied')intent.failures=0;setState(previous=>({...previous,operation:result}));
    if(result.phase==='failed'){
     erase(intent);flow.current=null;setState(previous=>({...previous,pending:false,step:null,message:'',error:modelSettingsErrors[result.errorCode??'']??'设置未能保存，修改已保留。'}));await latest.current.read();return;
    }
    if(result.phase!=='applied'){intent.polls++;return;}
    if(request.kind==='credential-provision'){
     if(!result.credentialRef)throw new Error('model_settings_credential_unavailable');
     const key=intent.keys[intent.keyIndex];key.apiKey='';delete request.body.apiKey;
     intent.configuration.models=intent.configuration.models.map(model=>model.id===key.modelId?{...model,credentialRef:result.credentialRef}:model);
     latest.current.onCredential(key.modelId,result.credentialRef);intent.keyIndex++;intent.request=null;intent.polls=0;intent.failures=0;continue;
    }
    if(request.kind==='draft'){
     intent.versionId=result.versionId;
     // A reconciled POST can have no revision; a fresh overview supplies the next CAS.
     const fresh=await latest.current.read();if(!current())return;
     if(!fresh){intent.polls++;intent.failures++;setState(previous=>({...previous,step:intent.mode==='apply'?'apply':'draft',recoveryRequired:intent.failures>=3,error:intent.failures>=3?'暂时无法连接配置服务，草稿已保存。':''}));return;}
     if(fresh.draft?.id!==intent.versionId)throw new Error('model_settings_draft_changed');
     intent.revision=fresh.revision;latest.current.onSaved(intent.configuration,fresh.revision);intent.request=null;intent.polls=0;intent.failures=0;
     if(intent.mode==='apply'){
      if(!fresh.capabilities.canApply)throw new Error('model_settings_apply_unavailable');
      intent.stage='apply';continue;
     }
    }else{
     const fresh=await latest.current.read();if(!current())return;
     if(fresh)latest.current.onSaved(intent.configuration,fresh.revision);
    }
    erase(intent);flow.current=null;setState(previous=>({...previous,pending:false,step:null,recoveryRequired:false,message:request.kind==='draft'?'草稿已保存，尚未应用。':'配置已生效。',error:''}));await latest.current.onDone();return;
   }
  }catch(error){
   if(!current())return;
   const denied=error instanceof OperationsRequestError&&[401,403].includes(error.status),known=error instanceof OperationsRequestError?error.status<500:error instanceof Error&&error.message.startsWith('model_settings_');
   const code=error instanceof OperationsRequestError?error.code:error instanceof Error?error.message:'';
   if(known){erase(intent);flow.current=null;if(denied)latest.current.onDenied();else void latest.current.read();}
   else{intent.polls++;intent.failures++;}
   setState(previous=>({...previous,pending:!known,message:'',step:known?null:previous.step,recoveryRequired:!known&&intent.failures>=3,error:known?(modelSettingsErrors[code]??(code==='model_settings_apply_unavailable'?'草稿已保存，当前暂不能应用。':operationsFailure(error,'设置未能保存，修改已保留。'))):intent.failures>=3?'暂时无法连接配置服务，修改已保留。':''}));
  }finally{if(controller.current===active)controller.current=null;inFlight.current=false;if(alive.current)setState(previous=>({...previous,busy:false}));}
 },[]);
 runner.current=run;
 useEffect(()=>{if(!state.pending||state.busy||state.recoveryRequired||!options.overview||!flow.current)return;const intent=flow.current,delay=intent.failures?Math.min(8000,1000*(1+intent.failures)):1500+Math.min(intent.polls,8)*500,timer=setTimeout(()=>{void run();},delay);return()=>clearTimeout(timer);},[state.pending,state.busy,state.recoveryRequired,state.operation,options.overview,run]);
 const clearConflict=useCallback(()=>setState(previous=>!previous.pending&&[modelSettingsErrors.model_settings_revision_changed,modelSettingsErrors.model_settings_draft_changed].includes(previous.error)?{...previous,error:''}:previous),[]);
 return{...state,receipt:state.pending&&flow.current?.request?{operationId:flow.current.request.operationId,kind:flow.current.request.kind}:null,locked:state.pending||state.busy,clearConflict,retry:async()=>{if(flow.current){flow.current.failures=0;flow.current.polls=0;}setState(previous=>({...previous,error:'',recoveryRequired:false}));const fresh=await latest.current.read();if(fresh)await run();},
  start:(input:{mode:SaveFlow['mode'];configuration:ModelSettingsConfiguration;revision:number;versionId?:string;keys:Record<string,string>})=>{
   if(flow.current||inFlight.current||!readable(latest.current.overview))return;
   flow.current={csrfToken:latest.current.csrfToken,mode:input.mode,configuration:modelSettingsClone(input.configuration),revision:input.revision,versionId:input.versionId??null,keys:Object.entries(input.keys).filter(([,apiKey])=>!!apiKey).map(([modelId,apiKey])=>({modelId,apiKey})),keyIndex:0,stage:input.mode==='apply-existing'?'apply':'credentials',request:null,polls:0,failures:0};
   setState({busy:false,pending:true,message:'',error:'',operation:null,step:input.mode==='apply-existing'?'apply':Object.values(input.keys).some(Boolean)?'credential-provision':'draft',mode:input.mode,recoveryRequired:false});void run();
  }};
}
