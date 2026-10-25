'use client';
import {useCallback,useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsRequest,OperationsRequestError} from './operations-client';
import {SettingsDraftMemoryContext} from './use-settings-draft-memory';
import type {SettingsDraftScope,SettingsPendingReceipt} from './settings-draft-memory';

type Row=Record<string,unknown>;
export type SettingsRecoveredReceipt={operationId:string;kind:string;phase:string|null;versionId:string|null;modelRecordId:string|null;credentialRef:string|null;result:Row|null};
const object=(value:unknown):Row|null=>!!value&&typeof value==='object'&&!Array.isArray(value)?value as Row:null;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=(value:unknown)=>typeof value==='string'&&uuid.test(value)?value.toLowerCase():null;
const paths={models:'model-settings/operations',strategies:'strategies/operations',smtp:'smtp/operations',recommendation:'recommendation/operations',rules:'rules/operations',search:'search-quality/operations',messaging:'messaging/operations',maintenance:'maintenance/command-results'} as const;
// Account pages own different target-bound receipt contracts. Their memory
// slots do not make them consumers of the legacy settings receipt parser.
export type SettingsReceiptScope=Extract<SettingsDraftScope,keyof typeof paths>;

/** A receipt is not a saved request. In particular, no body or API Key is kept
 * here, and a return to this page can only read the original operation. */
export function settingsReceiptResult(scope:SettingsReceiptScope,pending:SettingsPendingReceipt,value:unknown):SettingsRecoveredReceipt|null{
 const row=object(value);if(!row||id(row.operationId)!==pending.operationId||typeof row.checkedAt!=='number'||!Number.isFinite(row.checkedAt)||row.checkedAt<0||typeof row.readExpiresAt!=='number'||!Number.isFinite(row.readExpiresAt)||row.readExpiresAt<row.checkedAt||row.readExpiresAt-row.checkedAt>31||row.readExpiresAt*1000<=Date.now()||row.metadataOnly!==true)throw Error('Invalid settings receipt');
 if(row.state==='not-recorded'||row.state==='unknown')return null;
 if(row.kind!==pending.kind)throw Error('Different settings receipt');
 const phase=typeof row.phase==='string'?row.phase:null;
 if(scope==='models'||scope==='search'){
  if(!['prepared','submitting','pending','task-pending','applied','failed','result-unknown'].includes(phase??''))throw Error('Invalid settings phase');
  if(phase!=='applied'&&phase!=='failed')return null;
 }else if(row.state!=='recorded')throw Error('Invalid settings receipt state');
 return {operationId:pending.operationId,kind:pending.kind,phase,versionId:id(row.versionId),modelRecordId:id(row.modelRecordId),credentialRef:typeof row.credentialRef==='string'&&/^model-key:[0-9a-f-]{36}$/i.test(row.credentialRef)?row.credentialRef:null,result:object(row.result)};
}

export function useSettingsReceiptRecovery({scope,live,ready,denied=false,onRecorded,onDenied,refresh}:{scope:SettingsReceiptScope;live:SettingsPendingReceipt|null;ready:boolean;denied?:boolean;onRecorded:(receipt:SettingsRecoveredReceipt)=>void|Promise<void>;onDenied?:()=>void;refresh?:()=>Promise<unknown>}){
 const session=useContext(SettingsDraftMemoryContext),[pending,setPending]=useState<SettingsPendingReceipt|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[wakeup,setWakeup]=useState(0);
 const owner=useRef<typeof session>(null),local=useRef<SettingsPendingReceipt|null>(null),active=useRef<AbortController|null>(null),attempts=useRef(0),suspended=useRef(false),latest=useRef({ready,denied,onRecorded,onDenied,refresh});latest.current={ready,denied,onRecorded,onDenied,refresh};
 useLayoutEffect(()=>{
  if(!session?.current()){owner.current=null;local.current=null;setPending(null);return;}
  if(owner.current!==session){owner.current=session;local.current=null;attempts.current=0;suspended.current=false;setError('');setMessage('');setPending(session.pending(scope));}
  if(live){if(local.current?.operationId!==live.operationId){setError('');setMessage('');}session.setPending(scope,live);local.current=live;setPending(null);return;}
  if(local.current){const original=local.current;local.current=null;if(denied){setPending(original);}else{if(session.pending(scope)?.operationId===original.operationId)session.setPending(scope,null);setPending(null);}}
 },[session,scope,live?.operationId,live?.kind,denied]);
 useEffect(()=>{
  if(!pending||live||!session?.current()||!ready||denied||suspended.current||attempts.current>=3||!navigator.onLine||document.visibilityState==='hidden')return;
  const controller=new AbortController();active.current=controller;let timer:ReturnType<typeof setTimeout>|undefined;setBusy(true);
  const current=()=>!controller.signal.aborted&&session.current();
  void(async()=>{
   try{
    const value=await operationsRequest('/v1/operations/'+paths[scope]+'/'+pending.operationId,{signal:controller.signal});if(!current())return;
    const result=settingsReceiptResult(scope,pending,value);
    if(result){session.setPending(scope,null);setPending(null);setError('');setMessage(result.phase==='failed'?'已读取上次处理记录，请查看当前设置。':scope==='models'&&result.kind==='draft'?'上次草稿已保存，尚未应用。':'已读取上次处理记录。');try{await latest.current.onRecorded(result);}catch{if(current())setError('处理记录已取得，当前设置暂时无法读取。');}return;}
    attempts.current++;setError(attempts.current>=3?'上次处理的结果暂未取得。':'');
   }catch(failure){
    if(!current())return;
    if(failure instanceof OperationsRequestError&&[401,403].includes(failure.status)){suspended.current=true;session.clear(scope);setError('当前无法读取上次处理结果。');latest.current.onDenied?.();}
    else{attempts.current++;setError(attempts.current>=3?'上次处理的结果暂未取得。':'');}
   }finally{if(current()){setBusy(false);if(!suspended.current&&attempts.current<3)timer=setTimeout(()=>setWakeup(value=>value+1),2500);}if(active.current===controller)active.current=null;}
  })();
  return()=>{controller.abort();if(timer)clearTimeout(timer);if(active.current===controller)active.current=null;};
 },[session,scope,pending?.operationId,live?.operationId,ready,denied,wakeup]);
 const retry=useCallback(()=>{attempts.current=0;suspended.current=false;setError('');if(!latest.current.ready&&latest.current.refresh)void latest.current.refresh().catch(()=>{}).finally(()=>setWakeup(value=>value+1));else setWakeup(value=>value+1);},[]);
 useEffect(()=>{const pause=()=>active.current?.abort(),resume=()=>{if(navigator.onLine&&document.visibilityState==='visible'&&pending&&!suspended.current)retry();};window.addEventListener('offline',pause);window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);return()=>{window.removeEventListener('offline',pause);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};},[retry,pending]);
 return {pending:!!pending,operationId:pending?.operationId??null,busy:busy&&ready&&!denied,error,message,retry};
}

export function SettingsReceiptNotice({recovery}:{recovery:ReturnType<typeof useSettingsReceiptRecovery>}){
 if(!recovery.pending&&!recovery.message&&!recovery.error)return null;
 return <p role="status" className="settings-draft-wait"><span>{recovery.error||(recovery.pending?'正在读取上次处理结果。':recovery.message)}</span>{recovery.pending&&recovery.error&&<button type="button" disabled={recovery.busy} onClick={recovery.retry}>重新读取</button>}</p>;
}
