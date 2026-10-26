'use client';
import {useCallback,useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from "../operations-client";
import {SettingsDraftMemoryContext} from "../use-settings-draft-memory";
import {systemSettingsBase,systemSettingsOperation} from './system-settings-view-model';
import type {SystemSettingsOperation,SystemSettingsCommandSection} from "../../components/system-settings/system-settings-types";

export type SystemSettingsCommandLocator={operationId:string;kind:string;versionId?:string;expectedRevision?:number;connectionId?:string};
type Step={section:SystemSettingsCommandSection;kind:SystemSettingsOperation['kind'];versionId?:string;expectedRevision?:number;connectionId?:string};
type Intent={locator:SystemSettingsCommandLocator;step:Step;path:string;body:Record<string,unknown>|null;post:boolean;resolve:((value:SystemSettingsOperation|null)=>void)|null};
const kinds=['save','test','apply','credential'] as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errors:Record<string,string>={
 invalid_system_settings_request:'请检查填写的设置。',
 system_settings_version_changed:'设置已有更新，你的修改已保留。',
 system_settings_operation_changed:'这次处理的内容与原记录不一致，请重新读取设置。',
 system_settings_credential_binding_mismatch:'连接地址已变化，请为这个连接重新填写凭据。',
 system_settings_credential_unavailable:'连接凭据暂不可用。',
 system_settings_configuration_incomplete:'请补齐连接设置，再测试或应用。',
 system_settings_permission_denied:'当前没有修改这项设置的权限。',
 system_settings_authorization_unavailable:'设置授权服务暂不可用。',
 system_settings_native_not_configured:'配置服务尚未接通。',
 system_settings_native_unavailable:'配置服务暂时无法连接。',
 system_settings_control_not_configured:'这项服务的配置通道尚未接通。',
 system_settings_target_unavailable:'这项服务暂不可用。',
 system_settings_source_changed:'官网内容已有更新，请读取后应用。',
};
const noEffectCodes=new Set(['invalid_system_settings_request','system_settings_version_changed','system_settings_operation_changed','system_settings_credential_binding_mismatch','system_settings_configuration_incomplete']);
function stepFor(locator:SystemSettingsCommandLocator):Step|null{
 if(!uuid.test(locator.operationId)||locator.versionId!==undefined&&!uuid.test(locator.versionId)||locator.connectionId!==undefined&&!uuid.test(locator.connectionId)||locator.expectedRevision!==undefined&&(!Number.isSafeInteger(locator.expectedRevision)||locator.expectedRevision<0))return null;
 const [section,kind,extra]=locator.kind.split('.');
 return !extra&&(section==='mail'||section==='service-connections'||section==='general'&&['save','apply'].includes(kind))&&(kinds as readonly string[]).includes(kind)?{section,kind:kind as Step['kind'],...(locator.versionId?{versionId:locator.versionId}:{}),...(locator.expectedRevision!==undefined?{expectedRevision:locator.expectedRevision}:{}),...(locator.connectionId?{connectionId:locator.connectionId}:{})}:null;
}

/** The live POST body is private memory. The page memory keeps a closed GET
 * locator only; returning to the page can never resubmit a password or key. */
export function useSystemSettingsCommand({csrfToken,canRead,readVersion,canSubmit,onComplete,onConflict,onDenied}:{
 csrfToken:string;canRead:boolean;readVersion:number|null;canSubmit:(step:Step)=>boolean;
 onComplete:(operation:SystemSettingsOperation,locator:SystemSettingsCommandLocator)=>void|Promise<void>;onConflict:()=>void;onDenied:()=>void;
}){
 const session=useContext(SettingsDraftMemoryContext),[pending,setPending]=useState<SystemSettingsCommandLocator|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[wakeup,setWakeup]=useState(0),[feedbackSection,setFeedbackSection]=useState<SystemSettingsCommandSection|null>(null);
 const owner=useRef<typeof session>(null),original=useRef<Intent|null>(null),active=useRef<AbortController|null>(null),inFlight=useRef(false),alive=useRef(false),attempts=useRef(0),suspended=useRef(false);
 const latest=useRef({csrfToken,canRead,canSubmit,onComplete,onConflict,onDenied,session});latest.current={csrfToken,canRead,canSubmit,onComplete,onConflict,onDenied,session};
 const finish=useCallback((operation:SystemSettingsOperation|null,feedback:string,failed=false)=>{
  const intent=original.current;original.current=null;active.current?.abort();active.current=null;inFlight.current=false;
  if(owner.current?.current())owner.current.setPending('system-settings',null);
  setPending(null);setBusy(false);setMessage(failed?'':feedback);setError(failed?feedback:'');intent?.resolve?.(operation);
 },[]);
 useLayoutEffect(()=>{
  alive.current=true;
  return()=>{alive.current=false;active.current?.abort();inFlight.current=false;original.current?.resolve?.(null);original.current=null;};
 },[]);
 useLayoutEffect(()=>{
  if(owner.current===session)return;
  active.current?.abort();active.current=null;inFlight.current=false;original.current?.resolve?.(null);original.current=null;
  owner.current=session;attempts.current=0;suspended.current=false;setError('');setMessage('');setBusy(false);setFeedbackSection(null);
  const saved=session?.current()?session.pending('system-settings'):null,step=saved?stepFor(saved):null;
  if(saved&&step){const locator={operationId:saved.operationId,kind:saved.kind,...(saved.versionId?{versionId:saved.versionId}:{}),...(saved.expectedRevision!==undefined?{expectedRevision:saved.expectedRevision}:{}),...(saved.connectionId?{connectionId:saved.connectionId}:{})};original.current={locator,step,path:'',body:null,post:false,resolve:null};setPending(locator);setFeedbackSection(step.section);}else setPending(null);
 },[session]);
 const send=useCallback(async()=>{
  const intent=original.current,current=latest.current;
  if(!alive.current||!intent||inFlight.current||!current.session?.current()||owner.current!==current.session||!current.canRead||!navigator.onLine||document.visibilityState==='hidden')return;
  if(intent.post&&(!intent.body||!current.canSubmit(intent.step))){finish(null,'当前无法继续保存，修改已保留。',true);return;}
  const controller=new AbortController();active.current=controller;inFlight.current=true;setBusy(true);
  const valid=()=>alive.current&&!controller.signal.aborted&&original.current===intent&&latest.current.session===current.session&&current.session?.current()&&current.csrfToken===latest.current.csrfToken;
  try{
   let value:unknown;
   if(intent.post){intent.post=false;value=await operationsRequest(intent.path,{csrfToken:current.csrfToken,body:intent.body!,signal:controller.signal});}
   else value=await operationsRequest((intent.step.section==='general'?'/api/system-settings/general/operations/':systemSettingsBase+'/operations/')+intent.locator.operationId,{signal:controller.signal});
   if(!valid())return;
   const operation=systemSettingsOperation(value,{operationId:intent.locator.operationId,...intent.step});
   if(!operation){
    if(intent.body&&latest.current.canSubmit(intent.step)){intent.post=true;attempts.current=0;setError('');}
    else finish(null,'未找到这次处理记录，请查看当前设置后继续。',true);
    return;
   }
   // Once the server has this identifier, only its original result is read.
   intent.body=null;attempts.current=0;setError('');
   if(operation.state==='accepted'||operation.state==='unknown')return;
   const label=operation.state==='failed'?'设置处理失败，请查看各项结果。':operation.state==='partial'?'部分设置已应用，请查看各项结果。':operation.kind==='save'?'配置已保存。':operation.kind==='credential'?'连接凭据已保存，尚未应用。':operation.kind==='test'?'测试已完成。':'设置已应用。';
   let refreshed=true;try{await latest.current.onComplete(operation,intent.locator);}catch{refreshed=false;}
   if(!valid())return;finish(operation,refreshed?label:label+' 当前设置暂时无法读取。',operation.state==='failed');
  }catch(failure){
   if(!valid())return;
   if(failure instanceof OperationsRequestError&&(noEffectCodes.has(failure.code)||intent.step.section==='general'&&failure.status===409&&failure.code==='system_settings_source_changed')){
    if(failure.code==='system_settings_version_changed'||failure.code==='system_settings_source_changed')latest.current.onConflict();
    finish(null,errors[failure.code]??'请检查当前设置。',true);return;
   }
   if(failure instanceof OperationsRequestError&&[401,403].includes(failure.status)){
    intent.body=null;suspended.current=true;setError('当前无法读取处理结果。');latest.current.onDenied();
   }else{attempts.current++;setError(attempts.current>=3?'连接暂时中断，正在重连。':'');}
  }finally{
   if(active.current===controller){active.current=null;inFlight.current=false;if(alive.current)setBusy(false);}
   if(alive.current&&original.current===intent)setWakeup(value=>value+1);
  }
 },[finish]);
 useEffect(()=>{
  if(!pending||busy||!canRead||suspended.current)return;
  const timer=setTimeout(()=>void send(),Math.min(10000,attempts.current?1000*2**Math.min(attempts.current,3):1500));
  return()=>clearTimeout(timer);
 },[pending,busy,canRead,wakeup,send]);
 useEffect(()=>{
  if(canRead&&suspended.current){suspended.current=false;setWakeup(value=>value+1);}
  if(!canRead&&original.current)original.current.body=null;
 },[canRead,readVersion]);
 useEffect(()=>{
  const offline=()=>{if(original.current)original.current.body=null;active.current?.abort();active.current=null;inFlight.current=false;setBusy(false);setError('网络已断开，恢复后会读取处理结果。');};
  const resume=()=>{if(navigator.onLine&&document.visibilityState==='visible'){attempts.current=0;setWakeup(value=>value+1);}};
  window.addEventListener('offline',offline);window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
  return()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
 },[]);
 const run=useCallback((section:SystemSettingsCommandSection,kind:Step['kind'],body:Record<string,unknown>):Promise<SystemSettingsOperation|null>=>{
  const current=latest.current,versionId=typeof body.versionId==='string'?body.versionId:undefined,expectedRevision=typeof body.expectedRevision==='number'?body.expectedRevision:undefined,connectionId=kind==='credential'&&typeof body.connectionId==='string'?body.connectionId:undefined,step:Step={section,kind,...(versionId?{versionId}:{}),...(expectedRevision!==undefined?{expectedRevision}:{}),...(connectionId?{connectionId}:{})};
  if(original.current||!current.session?.current()||!current.canRead||!current.canSubmit(step))return Promise.resolve(null);
  const operationId=crypto.randomUUID(),locator={operationId,kind:section+'.'+kind,...(versionId?{versionId}:{}),...(expectedRevision!==undefined?{expectedRevision}:{}),...(connectionId?{connectionId}:{})},path=section==='general'?'/api/system-settings/general/'+(kind==='save'?'versions':'apply'):kind==='credential'?systemSettingsBase+'/credentials':systemSettingsBase+'/'+section+'/'+(kind==='save'?'versions':kind);
  return new Promise(resolve=>{
   original.current={locator,step,path,body:{...structuredClone(body),operationId},post:true,resolve};
   current.session!.setPending('system-settings',locator);attempts.current=0;suspended.current=false;setPending(locator);setFeedbackSection(section);setError('');setMessage('');void send();
  });
 },[send]);
 const retry=useCallback(()=>{attempts.current=0;suspended.current=false;setError('');setWakeup(value=>value+1);},[]);
 return {run,pending,busy,locked:pending!==null,error,message,section:feedbackSection,retry,clearFeedback:()=>{setError('');setMessage('');}};
}
