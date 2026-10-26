'use client';
import {useContext,useEffect,useRef,useState} from 'react';
import type {FeedbackSaved} from "../../components/feedback/feedback-types";
import {useOperationCommand} from "../use-operation-command";
import {operationsRequest,OperationsRequestError} from "../operations-client";
import {useOperationsRead} from "../use-operations-read";
import {SettingsDraftMemoryContext} from "../use-settings-draft-memory";
import {feedbackExpectedSelection,feedbackOriginalReceipt,feedbackPendingReceipt,feedbackPostAcknowledged,feedbackReceiptPath} from './feedback-draft-memory';
import type {FeedbackOriginalReceipt,FeedbackPendingReceipt} from './feedback-draft-memory';

type CurrentIntent=Omit<FeedbackPendingReceipt,'operationId'>&{operationId?:string};
export function useFeedbackCommand({csrfToken,ready,canRead,canWrite,onCommitted,onConflict,onReadDenied,errorMessages}:{csrfToken:string;ready:boolean;canRead:boolean;canWrite:boolean;onCommitted:(feedbackId:string)=>void|Promise<void>;onConflict:()=>void;onReadDenied:()=>void;errorMessages:Record<string,string>}){
 const session=useContext(SettingsDraftMemoryContext),owner=useRef<typeof session>(null),intent=useRef<CurrentIntent|null>(null),resolved=useRef('');
 const [resumed,setResumed]=useState<FeedbackPendingReceipt|null>(null),[recoveryMessage,setRecoveryMessage]=useState('');
 const latest=useRef({onCommitted,onReadDenied});latest.current={onCommitted,onReadDenied};
 function finish(locator:FeedbackPendingReceipt){
  if(session?.current()&&session.pending('feedback')?.operationId===locator.operationId)session.setPending('feedback',null);
  intent.current=null;return latest.current.onCommitted(locator.feedbackId);
 }
 const command=useOperationCommand<FeedbackSaved|FeedbackOriginalReceipt>({csrfToken,canWrite:ready&&canRead&&!resumed&&(canWrite||!!intent.current),errorMessages,onConflict,
  validateResult:(value,pending)=>{
   const locator=intent.current?feedbackPendingReceipt({...intent.current,operationId:pending.body.operationId}):null;
   if(!locator||pending.path!=='/v1/operations/feedback/'+locator.feedbackId+'/events'||!('state'in value?feedbackOriginalReceipt(value,locator):feedbackPostAcknowledged(value,locator)))throw Error('Original feedback result unavailable');
   intent.current=locator;
  },
  onCommitted:value=>{const locator=intent.current?feedbackPendingReceipt({...intent.current,operationId:value.operationId}):null;if(!locator)throw Error('Original feedback target unavailable');return finish(locator);},
  recover:async(pending,{signal})=>{
   const locator=intent.current?feedbackPendingReceipt({...intent.current,operationId:pending.body.operationId}):null;
   if(!locator||pending.path!=='/v1/operations/feedback/'+locator.feedbackId+'/events')throw Error('Original feedback locator unavailable');
   let raw:unknown;try{raw=await operationsRequest(feedbackReceiptPath(locator),{signal});}catch(error){if(error instanceof OperationsRequestError&&[401,403].includes(error.status))latest.current.onReadDenied();throw error;}
   const receipt=feedbackOriginalReceipt(raw,locator,await feedbackExpectedSelection(pending.body));
   if(!receipt)throw Error('Original feedback result not observed');
   return{state:'recorded',value:receipt};
  }
 });
 const restoredRead=useOperationsRead<unknown>({path:resumed&&ready&&canRead?feedbackReceiptPath(resumed):null,failureMessage:'上次处理结果暂时无法读取。',clearOnOffline:true});
 // Passive restoration follows the page's fresh-read draft initialization.
 // A saved locator can only GET the original result, never reconstruct a POST.
 useEffect(()=>{
  if(!session?.current()||!ready)return;
  if(owner.current!==session){owner.current=session;const saved=feedbackPendingReceipt(session.pending('feedback'));if(saved){setResumed(saved);return;}}
  if(command.pending&&intent.current){const locator=feedbackPendingReceipt({...intent.current,operationId:command.pending.body.operationId});if(locator)session.setPending('feedback',locator);}
  else if(!resumed)session.setPending('feedback',null);
 },[session,ready,command.pending,resumed]);
 useEffect(()=>{
  if(!resumed||!ready||!canRead||!session?.current())return;
  const receipt=restoredRead.verified?feedbackOriginalReceipt(restoredRead.value,resumed):null;
  if(receipt&&resolved.current!==resumed.operationId){
   resolved.current=resumed.operationId;session.setPending('feedback',null);setResumed(null);setRecoveryMessage('上次处理已完成。');
   void Promise.resolve().then(()=>{if(session.current()&&owner.current===session)return latest.current.onCommitted(resumed.feedbackId);}).catch(()=>{if(session.current()&&owner.current===session)setRecoveryMessage('上次处理已完成，请刷新查看最新内容。');});
   return;
  }
  if(/登录|权限|未获准/.test(restoredRead.error)){latest.current.onReadDenied();return;}
  if(restoredRead.loading||restoredRead.refreshing)return;
  const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void restoredRead.read();},5000);return()=>clearTimeout(timer);
 },[session,resumed,ready,canRead,restoredRead.value,restoredRead.verified,restoredRead.error,restoredRead.loading,restoredRead.refreshing,restoredRead.read]);
 return{...command,locked:command.locked||!!resumed,pending:command.pending??resumed,error:resumed?restoredRead.error:command.error,message:command.message||recoveryMessage,
  submit:(feedbackId:string,body:Record<string,unknown>,label:string)=>{
   if(!ready||!canRead||!canWrite||resumed||command.locked||!Number.isSafeInteger(body.expectedRevision))return Promise.resolve(undefined);
   intent.current={kind:'event',feedbackId,expectedRevision:Number(body.expectedRevision)};setRecoveryMessage('');
   return command.submit('/v1/operations/feedback/'+feedbackId+'/events',body,label);
  },
  retry:()=>resumed?restoredRead.read():command.retry()
 };
}
