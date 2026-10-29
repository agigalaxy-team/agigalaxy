'use client';
import {useState} from 'react';
import type {QueuedMessage,ActiveMessage,PausedLane} from '../../lib/workbench/workbench-message-queue';

export function WorkbenchMessageQueue({items,active,paused,conversationId,taskId,provisionalWaiting,onEditingChange,onContinue,onEdit,onRemove}:{items:QueuedMessage[];active:ActiveMessage[];paused:PausedLane|null;conversationId:string|null;taskId:string|null;provisionalWaiting:boolean;onEditingChange:(id:string|null)=>void;onContinue:(lane:PausedLane)=>boolean;onEdit:(id:string,text:string)=>boolean;onRemove:(id:string)=>boolean}){
 const [editing,setEditing]=useState<string|null>(null),[text,setText]=useState('');
 if(!items.length&&!active.length)return null;
 return <section className="wb-message-queue" aria-label="待发队列"><strong>待发队列</strong>{paused&&items.some(item=>item.conversationId===paused.conversationId&&item.taskId===paused.taskId)&&<p role="status">队列已暂停。<button type="button" onClick={()=>onContinue(paused)}>继续发送</button></p>}{active.map(item=><p key={item.operationId} role="status">{item.item.conversationId!==conversationId||item.item.taskId!==taskId?'原对话已变化，原发送结果待核对':item.attempted?'原发送结果待核对':'正在准备发送'}：{item.item.text}</p>)}<ol>{items.map(item=>{
  const awaitingProvisional=provisionalWaiting&&item.conversationId===null&&item.taskId===taskId;const stale=!awaitingProvisional&&(item.conversationId!==conversationId||item.taskId!==taskId);
  return <li key={item.id}>{editing===item.id?<><textarea aria-label="编辑待发消息" value={text} maxLength={12000} onChange={event=>setText(event.target.value)}/><button type="button" disabled={!text.trim()} onClick={()=>{if(onEdit(item.id,text)){onEditingChange(null);setEditing(null);}}}>保存</button><button type="button" onClick={()=>{onEditingChange(null);setEditing(null);}}>取消编辑</button></>:<><p style={{whiteSpace:'pre-wrap'}}>{item.text}</p><button type="button" onClick={()=>{onEditingChange(item.id);setText(item.text);setEditing(item.id);}}>编辑</button><button type="button" onClick={()=>onRemove(item.id)}>取消待发</button></>}{awaitingProvisional?<span role="status">等待原会话处理，尚未发送</span>:stale?<span role="status">原对话已变化，尚未发送</span>:item.needsReview?<span role="status">尚未发送，请编辑后重新排队</span>:null}</li>;
 })}</ol></section>;
}

