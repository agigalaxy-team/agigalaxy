import React,{useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Sparkles} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {z} from 'zod/v4';
import {createWorkContinuationLink,workContinuationPrompt,workContinuationObjectSchema} from '../../galaxy-edge-mcp/src/native-v2/work/continuation-link.mjs';
import './agent-work-continuation.css';
import {hasLocalGalaxyWindow,returnToLocalGalaxyWindow,subscribeLocalGalaxyWindow} from './local-galaxy-window.mjs';

export type AgentWorkObject=z.infer<typeof workContinuationObjectSchema>;
type Runtime={api:{endpoint:string;snapshot:()=>{subjectId:string}|null};receiptStatus:{captureLease:()=>{assertCurrent:()=>void}}};
export type AgentWorkContinuationProps={runtime:Runtime|null;subjectId?:string;object:AgentWorkObject;title:string;purpose?:string;
 selectedMaterials?:Array<{object:AgentWorkObject;label:string}>;returnTo?:string;onNeedIdentity?:()=>void};
type Feedback={key:string;notice:string;request:string;manual:boolean;error:boolean};

// Only user-selected references leave this page. The Native reader verifies
// the current identity/service and source permission again; the link grants
// nothing, contains no body, and does not inherit any room synchronization.
export function AgentWorkContinuation({runtime,subjectId,object,title,purpose='理解这份内容，并继续原来的事情',selectedMaterials=[],returnTo,onNeedIdentity}:AgentWorkContinuationProps){
 const nativeWindow=useSyncExternalStore(subscribeLocalGalaxyWindow,hasLocalGalaxyWindow,()=>false);
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
   try{await navigator.clipboard.writeText(request);if(current())setFeedback({key,notice:'已复制，回到自己的 AI 对话发送即可。',request,manual:false,error:false});}
   catch{if(current())setFeedback({key,notice:'请复制请求，回到自己的 AI 对话发送。',request,manual:true,error:false});}
  }catch{if(current())setFeedback({key,notice:'暂时无法准备这次接续。原页面和选择仍保留，请核对当前连接后再试。',request:'',manual:false,error:true});}
  finally{if(lifecycle.active&&ticket===lifecycle.sequence){inFlight.current=null;setWorking(null);}}
 }
 const identityReady=!!runtime&&!!subjectId&&runtime.api.snapshot()?.subjectId===subjectId;
 return <div className="agent-work-continuation"><Button variant="ghost" type="button" disabled={!nativeWindow&&!identityReady&&!onNeedIdentity} aria-disabled={working===key} onClick={()=>{if(nativeWindow)returnToLocalGalaxyWindow();else void copy();}}><Sparkles size={15} aria-hidden="true"/>{working===key?'正在准备…':nativeWindow?'回到发起窗口':'用自己的 AI 继续'}</Button>
 {shown&&<p className={shown.error?'message error':'agent-work-notice'} role={shown.error?'alert':'status'}>{shown.notice}</p>}
 {shown?.manual&&shown.request&&<label>接续请求<textarea aria-label="给自己的 AI 的请求" readOnly rows={4} value={shown.request} onFocus={event=>event.currentTarget.select()}/></label>}
 </div>;
}
