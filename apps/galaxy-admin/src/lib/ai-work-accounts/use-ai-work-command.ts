'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {settingsAiWorkReceiptPath,type SettingsPendingReceipt} from "../settings-draft-memory";
import {operationsRequest,OperationsRequestError} from "../operations-client";
import {aiWorkBase,aiWorkErrors,aiWorkReceiptMatches,aiWorkRestoredReceiptMatches} from './ai-work-accounts-view-model';
import type {AiWorkCommandKind,AiWorkDetail,AiWorkDomain,AiWorkReceipt} from "../../components/ai-work-accounts/ai-work-accounts-types";

type IntentSource={accountId:string;version:number;authorizationVersion:number;objectVersion:number;roleVersion:number|null};
export type Intent={operationId:string;kind:AiWorkCommandKind;domain:AiWorkDomain;path:string;body:Record<string,unknown>;readOnly:boolean;attempted:boolean;source:IntentSource|null;rejection?:string};

function intentSource(detail:AiWorkDetail|null,intent:Intent):IntentSource|null{
 if(!detail||detail.account.domain!==intent.domain||detail.readExpiresAt*1000<=Date.now())return null;
 const assignment=intent.kind==='assignment-save'?detail.assignments.find(row=>row.roleId===intent.body.roleId):null;
 if(intent.kind==='assignment-save'&&(intent.body.id??null)!==(assignment?.id??null))return null;
 return{accountId:detail.account.id,version:detail.account.version,authorizationVersion:detail.account.authorizationVersion,objectVersion:intent.kind==='assignment-save'?assignment?.version??0:detail.account.version,roleVersion:intent.kind==='assignment-save'?detail.roles.find(role=>role.id===intent.body.roleId)?.version??null:null};
}
function sameIntentSource(detail:AiWorkDetail|null,intent:Intent){
 const source=intentSource(detail,intent),original=intent.source;
 return !!source&&!!original&&source.accountId===original.accountId&&source.version===original.version&&source.authorizationVersion===original.authorizationVersion&&source.objectVersion===original.objectVersion&&source.objectVersion===intent.body.expectedVersion&&source.roleVersion===original.roleVersion;
}
export function canSubmitIntent(detail:AiWorkDetail|null,intent:Intent){return !!detail&&detail.account.domain===intent.domain&&detail.readExpiresAt*1000>Date.now()&&(intent.kind==='profile-save'?detail.capabilities.canEditProfile:intent.kind==='state-save'?detail.capabilities.canChangeState:detail.capabilities.canAssignRoles&&(intent.body.enabled===false||detail.roles.some(role=>role.id===intent.body.roleId&&role.canAssign)));}

export function useAiWorkCommand({owner,csrfToken,canRead,detail,canSubmit,onResult,onConflict}:{owner:string;csrfToken:string;canRead:boolean;detail:AiWorkDetail|null;canSubmit:(intent:Intent)=>boolean;onResult:(value:AiWorkReceipt)=>void;onConflict:()=>void}){
 const [pending,setPending]=useState<Intent|null>(null),[requesting,setRequesting]=useState(false),[attempt,setAttempt]=useState(0),[error,setError]=useState(''),[wake,setWake]=useState(0),[retryRead,setRetryRead]=useState<{operationId:string;expiresAt:number}|null>(null);
 const original=useRef<Intent|null>(null),missing=useRef<typeof retryRead>(null),active=useRef<AbortController|null>(null),alive=useRef(false),busy=useRef(false),latest=useRef({owner,csrfToken,canRead,detail,canSubmit,onResult,onConflict});
 const rememberMissing=(value:typeof retryRead)=>{missing.current=value;setRetryRead(value);};
 useLayoutEffect(()=>{latest.current={owner,csrfToken,canRead,detail,canSubmit,onResult,onConflict};});
 useLayoutEffect(()=>{alive.current=true;setPending(null);original.current=null;rememberMissing(null);return()=>{alive.current=false;active.current?.abort();active.current=null;busy.current=false;original.current=null;missing.current=null;};},[owner,csrfToken]);
 const send=useCallback(async(first=false,manual=false)=>{
  const intent=original.current,identity=latest.current;if(!intent||busy.current||!alive.current||!identity.canRead||!navigator.onLine||document.hidden)return;
  if(manual&&(intent.readOnly||!intent.attempted||!intent.source||missing.current?.operationId!==intent.operationId||missing.current.expiresAt<=Date.now()||!identity.canSubmit(intent)||!sameIntentSource(identity.detail,intent)))return;
  const controller=new AbortController();active.current=controller;busy.current=true;setRequesting(true);
  const current=()=>alive.current&&!controller.signal.aborted&&original.current===intent&&latest.current.owner===identity.owner&&latest.current.csrfToken===identity.csrfToken;
  let posting=false;
  try{
   let value:AiWorkReceipt|undefined;
   if(!first||intent.attempted||intent.readOnly){
    const result=await operationsRequest<AiWorkReceipt>(aiWorkBase+'/operations/'+intent.operationId,{signal:controller.signal});if(!current())return;
    if(result.state==='recorded'){rememberMissing(null);value=result;}
    else if(result.state!=='not-recorded'||result.operationId!==intent.operationId)throw Error('Original result unavailable');
    else if(intent.rejection){original.current=null;setPending(null);rememberMissing(null);setError(aiWorkErrors[intent.rejection]??'当前记录已有变化，请查看后继续。');latest.current.onConflict();return;}
    else{if(!Number.isFinite(result.readExpiresAt)||result.readExpiresAt*1000<=Date.now())throw Error('Original result lease unavailable');rememberMissing({operationId:intent.operationId,expiresAt:result.readExpiresAt*1000});}
   }
   if(!value){
    // A missing receipt cannot prove that an attempted request had no effect.
    // Automatic recovery is GET-only after the first request. A manual retry
    // needs the retained body and fresh, unchanged source and authority.
    if((intent.attempted&&!manual)||intent.readOnly||!latest.current.canSubmit(intent)){setError('尚未取得这次处理的结果，系统会继续查询。');return;}
    if(manual){
     if(missing.current?.operationId!==intent.operationId||missing.current.expiresAt<=Date.now())return;
     const fresh=await operationsRequest<AiWorkDetail>(aiWorkBase+'/'+intent.domain,{signal:controller.signal});if(!current())return;
     if(!sameIntentSource(fresh,intent)){setError('这项资料已有更新，原操作结果仍在查询。');rememberMissing(null);latest.current.onConflict();return;}
     if(!canSubmitIntent(fresh,intent)||!latest.current.canRead||!latest.current.canSubmit(intent)){setError('当前不能办理这次操作，原结果仍在查询。');rememberMissing(null);latest.current.onConflict();return;}
    }
    if(!current()||!navigator.onLine||document.hidden)return;
    rememberMissing(null);intent.attempted=true;posting=true;setPending({...intent});
    value=await operationsRequest<AiWorkReceipt>(intent.path,{body:intent.body,csrfToken:identity.csrfToken,signal:controller.signal});
   }
   if(!current())return;
   const valid=intent.readOnly?aiWorkRestoredReceiptMatches(value,intent):aiWorkReceiptMatches(value,intent);
   if(!valid)throw Error('Unbound AI account result');
   original.current=null;setPending(null);rememberMissing(null);setError('');latest.current.onResult(value);
  }catch(failure){
   if(!current())return;
   rememberMissing(null);
   if(posting&&!intent.readOnly&&failure instanceof OperationsRequestError&&failure.status>=400&&failure.status<500&&![408,429].includes(failure.status)&&['invalid_operations_ai_work_request','operations_ai_work_version_changed','operations_ai_work_assignment_changed','operations_ai_work_operation_conflict','operations_ai_work_role_denied','operations_ai_work_not_initialized','operations_role_not_found','operations_permission_denied','business_admin_denied'].includes(failure.code)){intent.rejection=failure.code;setPending({...intent});}
   setError(failure instanceof OperationsRequestError&&[401,403].includes(failure.status)?'当前无法读取这次处理的结果。':attempt>=2?'连接暂时中断，系统正在恢复。':'');
  }finally{if(active.current===controller){active.current=null;busy.current=false;if(alive.current){setRequesting(false);setAttempt(value=>value+1);}}}
 },[attempt]);
 useEffect(()=>{const resume=()=>{if(!document.hidden&&navigator.onLine)setWake(value=>value+1);};window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);return()=>{window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};},[]);
 useEffect(()=>{if(!pending||requesting||!canRead)return;const timer=setTimeout(()=>void send(),Math.min(10000,1500*2**Math.min(attempt,3)));return()=>clearTimeout(timer);},[pending,requesting,canRead,attempt,wake,send]);
 const retryState=pending&&!pending.readOnly&&pending.attempted&&retryRead?.operationId===pending.operationId&&retryRead.expiresAt>Date.now()&&canRead&&detail?(sameIntentSource(detail,pending)?canSubmit(pending)?'ready':'unavailable':'changed'):null;
 return{pending,error,locked:pending!==null,requesting,retryState,retry:()=>void send(false,true),
  submit:(domain:AiWorkDomain,kind:AiWorkCommandKind,body:Record<string,unknown>)=>{if(original.current)return false;const operationId=crypto.randomUUID(),intent:Intent={operationId,domain,kind,path:aiWorkBase+'/'+domain+(kind==='assignment-save'?'/assignments':'/commands'),body:{...structuredClone(body),operationId},readOnly:false,attempted:false,source:null};if(!latest.current.canSubmit(intent))return false;intent.source=intentSource(latest.current.detail,intent);original.current=intent;setPending({...intent});setAttempt(0);setError('');rememberMissing(null);void send(true);return true;},
  resume:(locator:SettingsPendingReceipt)=>{const path=settingsAiWorkReceiptPath(locator);if(!path||!locator.domain||original.current||!latest.current.canRead)return;const intent:Intent={operationId:locator.operationId,domain:locator.domain,kind:locator.kind as AiWorkCommandKind,path,body:{},readOnly:true,attempted:true,source:null};original.current=intent;setPending({...intent});setAttempt(0);setError('');rememberMissing(null);void send();},
 };
}
