'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {emptyMessageQueue,parseMessageQueue,restoreUnattempted,enqueueMessage,reserveMessage,markMessageAttempted,settleMessage,bindProvisionalLane,pauseMessageLane,resumeMessageLane,editQueuedMessage,removeQueuedMessage,messageQueueStorageKey,returnBusyMessage,markBusyLaneReady,type BusyLane,type MessageQueueState,type QueuedMessage,type PausedLane} from './workbench-message-queue';

export function useWorkbenchMessageQueue(operatorId:string|null) {
 const key=operatorId?messageQueueStorageKey(operatorId):null;
 const current=useRef<MessageQueueState>(emptyMessageQueue()),loaded=useRef(false),[state,setState]=useState<MessageQueueState>(emptyMessageQueue()),[error,setError]=useState(''),[ready,setReady]=useState(false);
 const save=useCallback((next:MessageQueueState)=>{if(!key)return false;try{window.sessionStorage.setItem(key,JSON.stringify(next));current.current=next;setState(next);setError('');return true;}catch{setError('待发队列保存失败，未发送。');return false;}},[key]);
 useEffect(()=>{if(!key)return;try{const next=restoreUnattempted(parseMessageQueue(window.sessionStorage.getItem(key)));window.sessionStorage.setItem(key,JSON.stringify(next));current.current=next;setState(next);loaded.current=true;setReady(true);}catch{setError('待发队列无法读取或保存，未发送。');}},[key]);
 const enqueue=useCallback((item:QueuedMessage)=>{if(!loaded.current)return false;try{return save(enqueueMessage(current.current,item));}catch{return false;}},[save]);
 const reserve=useCallback((itemId:string,operationId:string)=>{if(!loaded.current)return false;try{return save(reserveMessage(current.current,itemId,operationId));}catch{return false;}},[save]);
 const attempted=useCallback((operationId:string)=>{try{return save(markMessageAttempted(current.current,operationId));}catch{return false;}},[save]);
 const settle=useCallback((operationId:string,requeue=false)=>save(settleMessage(current.current,operationId,requeue)),[save]);
 const unreserve=useCallback((operationId:string)=>save(restoreUnattempted(current.current,operationId)),[save]);
 const bind=useCallback((operationId:string,conversationId:string)=>{try{return save(bindProvisionalLane(current.current,operationId,conversationId));}catch{return false;}},[save]);
 const pause=useCallback((operationId:string)=>save(pauseMessageLane(current.current,operationId)),[save]);
 const resume=useCallback((lane:PausedLane)=>save(resumeMessageLane(current.current,lane)),[save]);
 const returnBusy=useCallback((operationId:string,blockingOperationId:string,conversationId:string)=>{try{return save(returnBusyMessage(current.current,operationId,blockingOperationId,conversationId));}catch{return false;}},[save]);
 const busyReady=useCallback((lane:BusyLane,conversationId:string)=>save(markBusyLaneReady(current.current,lane,conversationId)),[save]);
 const remove=useCallback((id:string)=>save(removeQueuedMessage(current.current,id)),[save]);
 const edit=useCallback((id:string,text:string)=>{try{return save(editQueuedMessage(current.current,id,text));}catch{return false;}},[save]);
 const clear=useCallback(()=>{if(key)try{window.sessionStorage.removeItem(key);}catch{}current.current=emptyMessageQueue();setState(current.current);loaded.current=false;setReady(false);},[key]);
 return {state,current,ready,error,enqueue,reserve,attempted,settle,unreserve,bind,pause,resume,returnBusy,busyReady,remove,edit,clear};
}
