import { ReadingDetails, ReadingSummary } from './reading-details';
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Copy} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {z} from 'zod/v4';
import {createWorkContinuationLink,workContinuationPrompt,workContinuationObjectSchema} from '../../galaxy-edge-mcp/src/native-v2/work-continuation-link.mjs';
import './agent-work-continuation.css';

export type AgentWorkObject=z.infer<typeof workContinuationObjectSchema>;
type Runtime={api:{endpoint:string;snapshot:()=>{subjectId:string}|null};receiptStatus:{captureLease:()=>{assertCurrent:()=>void}}};
export type AgentWorkContinuationProps={runtime:Runtime|null;subjectId?:string;object:AgentWorkObject;title:string;purpose?:string;
 selectedMaterials?:Array<{object:AgentWorkObject;label:string}>;returnTo?:string;onNeedIdentity?:()=>void};
type Feedback={key:string;notice:string;request:string;manual:boolean;error:boolean};

// Only user-selected references leave this page. The Native reader verifies
// the current identity/service and source permission again; the link grants
// nothing, contains no body, and does not inherit any room synchronization.
export function AgentWorkContinuation({runtime,subjectId,object,title,purpose='理解这份内容，并继续原来的事情',selectedMaterials=[],returnTo,onNeedIdentity}:AgentWorkContinuationProps){
 const [feedback,setFeedback]=useState<Feedback|null>(null),[working,setWorking]=useState<string|null>(null),life=useRef({active:false,sequence:0}),inFlight=useRef<string|null>(null);
 useEffect(()=>{const lifecycle=life.current;lifecycle.active=true;return()=>{lifecycle.active=false;lifecycle.sequence++;};},[]);
 const destination=returnTo??window.location.pathname+window.location.search+window.location.hash;
 const key=JSON.stringify([runtime?.api.endpoint,subjectId,object,selectedMaterials,destination,purpose]),currentKey=useRef(key);useLayoutEffect(()=>{currentKey.current=key;},[key]);
 const shown=feedback?.key===key?feedback:null;
 async function copy(){
  if(inFlight.current===key)return;
  const binding=runtime?.api.snapshot();
  if(!runtime||!subjectId||binding?.subjectId!==subjectId){onNeedIdentity?.();return;}
  const lifecycle=life.current,ticket=++lifecycle.sequence;let lease:ReturnType<Runtime['receiptStatus']['captureLease']>|null=null;
  const current=()=>{if(!lifecycle.active||ticket!==lifecycle.sequence||currentKey.current!==key)return false;try{lease?.assertCurrent();return true;}catch{return false;}};
  inFlight.current=key;setWorking(key);
  try{
   lease=runtime.receiptStatus.captureLease();
   lease.assertCurrent();
   const link=createWorkContinuationLink(window.location.origin,{version:1,endpoint:runtime.api.endpoint,subjectId,object,purpose,selectedMaterials:selectedMaterials.map(material=>material.object),returnTo:destination});
   const request=workContinuationPrompt(title,purpose,link);if(!current())return;
   try{await navigator.clipboard.writeText(request);if(current())setFeedback({key,notice:'请求已复制。贴到正在处理这件事的 AI 对话，就可以沿用当前身份继续。',request,manual:false,error:false});}
   catch{if(current())setFeedback({key,notice:'浏览器没有完成复制。可以在下面选择请求全文，复制给正在使用的 AI。',request,manual:true,error:false});}
  }catch{if(current())setFeedback({key,notice:'暂时无法准备这次接续。原页面和选择仍保留，请核对当前连接后再试。',request:'',manual:false,error:true});}
  finally{if(lifecycle.active&&ticket===lifecycle.sequence){inFlight.current=null;setWorking(null);}}
 }
 const identityReady=!!runtime&&!!subjectId&&runtime.api.snapshot()?.subjectId===subjectId;
 return <div className="agent-work-continuation">
  <Button variant="outline" type="button" disabled={!identityReady&&!onNeedIdentity} aria-disabled={working===key} onClick={()=>void copy()}><Copy size={16} aria-hidden="true"/>{working===key?'正在准备…':'用自己的 AI 继续'}</Button>
  {shown&&<p className={shown.error?'message error':'agent-work-notice'} role={shown.error?'alert':'status'}>{shown.notice}</p>}
  {shown?.request&&<ReadingDetails mode="inline" open={shown.manual}><ReadingSummary>查看要交给 AI 的请求</ReadingSummary><p>只带入这个页面{selectedMaterials.length?'和你选择的 '+selectedMaterials.length+' 份资料':''}的引用。客户端会按当前许可重新读取；不会发布、发送消息或开启同步。</p><textarea aria-label="给自己的 AI 的请求" readOnly rows={4} value={shown.request} onFocus={event=>event.currentTarget.select()}/></ReadingDetails>}
 </div>;
}
