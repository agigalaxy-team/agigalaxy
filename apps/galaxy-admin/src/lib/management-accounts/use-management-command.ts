'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {settingsManagementReceiptPath,type SettingsPendingReceipt} from "../settings-draft-memory";
import {operationsRequest,OperationsRequestError} from "../operations-client";
import {permissionOperationResult} from "../permissions/permissions-view-model";
import {managementAccountErrors,managementAccountsBase,managementReceiptMatches,managementRecoveredAssignment} from './management-accounts-view-model';
import type {ManagementCommandKind,ManagementCommandReceipt} from "../../components/management-accounts/management-accounts-types";
import type {AssignmentSave,PermissionOperationRead} from "../../components/permissions/permissions-types";

export type ManagementCommandIntent={operationId:string;owner:string;csrfToken:string;path:string;targetOperatorId:string|null;kind:ManagementCommandKind|'assignment-save';body:Record<string,unknown>;recorded:boolean;readOnly:boolean;rejectionCode?:string};
export type ManagementCommandResolved={kind:'management';value:ManagementCommandReceipt}|{kind:'assignment';value:AssignmentSave};
const isTerminal=(value:ManagementCommandReceipt)=>value.state==='completed'||value.state==='partial'||value.state==='failed';

/** Secrets remain in one private ref, separate from React pending state and
 * authored drafts. A received reservation is thereafter recovered by GET. */
export function useManagementCommand({operatorId,csrfToken,canRead,canSubmit,onResult,onRejected}:{operatorId:string;csrfToken:string;canRead:boolean;canSubmit:(intent:ManagementCommandIntent)=>boolean;onResult:(value:ManagementCommandResolved,terminal:boolean)=>void;onRejected:()=>void}){
 const [pending,setPending]=useState<ManagementCommandIntent|null>(null),[requesting,setRequesting]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[wakeup,setWakeup]=useState(0);
 const original=useRef<ManagementCommandIntent|null>(null),secret=useRef<string|null>(null),active=useRef<AbortController|null>(null),alive=useRef(false),inFlight=useRef(false),latest=useRef({operatorId,csrfToken,canRead,canSubmit,onResult,onRejected});
 useLayoutEffect(()=>{latest.current={operatorId,csrfToken,canRead,canSubmit,onResult,onRejected};});
 const run=useCallback(async(first=false)=>{
  const intent=original.current;
  if(!intent||!alive.current||inFlight.current||!latest.current.canRead||intent.owner!==latest.current.operatorId||intent.csrfToken!==latest.current.csrfToken||!navigator.onLine||document.visibilityState==='hidden')return;
  const controller=new AbortController();active.current=controller;inFlight.current=true;setRequesting(true);
  const current=()=>alive.current&&!controller.signal.aborted&&original.current===intent&&intent.owner===latest.current.operatorId&&intent.csrfToken===latest.current.csrfToken;
  const deliver=(result:ManagementCommandResolved)=>{
   if(!current())return;intent.recorded=true;secret.current=null;
   const terminal=result.kind==='assignment'||isTerminal(result.value);
   if(terminal){original.current=null;setPending(null);setError('');}else{setPending({...intent});setError('');}
   latest.current.onResult(result,terminal);
  };
  function assignment(value:AssignmentSave){
   const body=intent!.body,row=value?.assignment;
   if(value?.operationId!==intent!.operationId||!row||row.operatorId!==intent!.targetOperatorId||row.roleId!==body.roleId||row.enabled!==body.enabled||body.id&&row.id!==body.id)throw Error('Unbound assignment result');
   deliver({kind:'assignment',value});
  }
  function account(value:ManagementCommandReceipt){
   if(!managementReceiptMatches(value,{operationId:intent!.operationId,kind:intent!.kind as ManagementCommandKind,targetOperatorId:intent!.targetOperatorId}))throw Error('Unbound management result');
   deliver({kind:'management',value});
  }
  try{
   let post=first;
   if(!first){
    if(intent.kind==='assignment-save'){
     const result=await operationsRequest<PermissionOperationRead>(managementAccountsBase+'/'+intent.targetOperatorId+'/assignments/operations/'+intent.operationId,{signal:controller.signal});
     if(!current())return;
     if(result.state==='recorded'){
      if(intent.readOnly){const value=managementRecoveredAssignment(result,intent,intent.owner);if(!value)throw Error('Unbound restored assignment');deliver({kind:'assignment',value});return;}
      const value=permissionOperationResult(result,{path:'/v1/operations/permissions/assignments',body:{...intent.body,operatorId:intent.targetOperatorId}},intent.owner);
      if(!value||!('assignment' in value))throw Error('Unbound original assignment');assignment(value);return;
     }
     if(result.state!=='not-recorded'||result.operationId!==intent.operationId)throw Error('Original assignment unavailable');
    }else{
     const result=await operationsRequest<ManagementCommandReceipt>(managementAccountsBase+'/operations/'+intent.operationId,{signal:controller.signal});
     if(!current())return;
     if(result.state!=='not-recorded'){account(result);return;}
     if(result.operationId!==intent.operationId)throw Error('Original management result unavailable');
    }
    if(intent.rejectionCode){original.current=null;secret.current=null;setPending(null);setError(managementAccountErrors[intent.rejectionCode]??'账户已有更新，请按当前记录继续。');latest.current.onRejected();return;}
    post=!intent.readOnly&&!intent.recorded&&latest.current.canSubmit(intent);
   }
   if(!post||intent.readOnly||!latest.current.canSubmit(intent)){setError(intent.readOnly?'尚未取得这次处理的结果，系统会继续查询。':'当前无法继续这次处理，系统会继续读取已有结果。');return;}
   const needsSecret=intent.kind==='create'||intent.kind==='password-reset';
   if(needsSecret&&secret.current===null){setError('本次密码步骤的结果尚未确定，系统会继续读取已有结果。');return;}
   const body=needsSecret?{...intent.body,temporaryPassword:secret.current}:intent.body;
   const value=await operationsRequest<ManagementCommandReceipt|AssignmentSave>(intent.path,{csrfToken:intent.csrfToken,body,signal:controller.signal});
   if(!current())return;
   if(intent.kind==='assignment-save')assignment(value as AssignmentSave);else account(value as ManagementCommandReceipt);
  }catch(failure){
   if(!current())return;
   // Only these pre-effect parse/CAS failures prove this intent did not write.
   // Authorization/read/transport errors continue through the original GET.
   const known=failure instanceof OperationsRequestError&&(failure.code==='invalid_management_accounts_request'||failure.status===409&&['management_identity_target_changed','management_operation_pending','operations_permissions_version_changed','operations_permissions_target_changed','operations_assignment_exists'].includes(failure.code));
   if(known){intent.rejectionCode=failure.code;setPending({...intent});setError('正在更新当前记录…');}
   else{if(failure instanceof OperationsRequestError&&[401,403].includes(failure.status))secret.current=null;setError(failure instanceof OperationsRequestError&&[401,403].includes(failure.status)?'当前无法读取这次处理的结果。':attempt>=2?'连接暂时中断，系统正在恢复。':'');}
  }finally{
   if(active.current===controller){active.current=null;inFlight.current=false;if(alive.current){setRequesting(false);setAttempt(value=>value+1);}}
  }
 },[attempt]);
 useLayoutEffect(()=>{alive.current=true;original.current=null;secret.current=null;setPending(null);setError('');setAttempt(0);return()=>{alive.current=false;active.current?.abort();active.current=null;original.current=null;secret.current=null;inFlight.current=false;};},[operatorId,csrfToken]);
 useLayoutEffect(()=>{if(!canRead)secret.current=null;},[canRead]);
 useEffect(()=>{
  const resume=()=>{if(document.visibilityState==='visible'&&navigator.onLine)setWakeup(value=>value+1);};
  window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
  return()=>{window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume);};
 },[]);
 useEffect(()=>{if(!pending||requesting||!canRead)return;const timer=setTimeout(()=>void run(),Math.min(10000,1500*2**Math.min(attempt,3)));return()=>clearTimeout(timer);},[pending,requesting,attempt,wakeup,run,canRead]);
 return {pending,requesting,error,locked:pending!==null,
  resume:(locator:SettingsPendingReceipt)=>{
   const path=settingsManagementReceiptPath(locator);if(!path||original.current||!latest.current.canRead)return;
   const intent:ManagementCommandIntent={operationId:locator.operationId,owner:operatorId,csrfToken,path,targetOperatorId:locator.targetOperatorId??null,kind:locator.kind as ManagementCommandIntent['kind'],body:{},recorded:true,readOnly:true};
   original.current=intent;secret.current=null;setPending(intent);setAttempt(0);setError('');void run();
  },
  submit:(input:Omit<ManagementCommandIntent,'operationId'|'owner'|'csrfToken'|'recorded'|'readOnly'>,password?:string)=>{
   if(original.current||Object.hasOwn(input.body,'temporaryPassword'))return;
   const operationId=crypto.randomUUID(),intent:ManagementCommandIntent={...input,body:{...structuredClone(input.body),operationId},operationId,owner:operatorId,csrfToken,recorded:false,readOnly:false};
   if(!latest.current.canSubmit(intent))return;
   original.current=intent;secret.current=password??null;setPending(intent);setAttempt(0);setError('');void run(true);
  }};
}
