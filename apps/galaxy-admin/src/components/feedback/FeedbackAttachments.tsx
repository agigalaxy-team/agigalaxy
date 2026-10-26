'use client';

import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {AdminIcon} from '../AdminIcons';
import type {FeedbackAttachment} from "./feedback-types";
import './feedback-attachments.css';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const labels:Record<FeedbackAttachment['state'],string>={prepared:'尚未上传',uploading:'尚未完成上传','scan-pending':'等待扫描',scanning:'正在扫描',
 available:'暂不可读取',blocked:'已隔离',erased:'已移除',revoked:'已撤销',expired:'已到期'};
const size=(value:number)=>value>=1048576?(value/1048576).toFixed(1)+' MB':value>=1024?Math.ceil(value/1024)+' KB':value+' 字节';
const failure=(status:number,code:string)=>status===401?'管理登录已到期，请重新登录。':status===403?'当前登录无法读取此附件，请刷新管理登录后重试。':
 status===404?'此附件已到期、隔离或不可读取，请刷新反馈。':code==='attachment_storage_integrity_failed'||code==='attachment_receipt_mismatch'?'附件未能通过完整性校验，请稍后重试。':'附件暂时无法下载，请稍后重试。';

async function boundedBytes(response:Response,expected:number){
 if(!response.body||Number(response.headers.get('content-length'))>expected)throw Error('attachment_receipt_mismatch');
 const reader=response.body.getReader(),chunks:Uint8Array<ArrayBuffer>[]= [];let length=0;
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>expected){await reader.cancel();throw Error('attachment_receipt_mismatch');}chunks.push(new Uint8Array(part.value));}}
 finally{reader.releaseLock();}
 if(length!==expected)throw Error('attachment_receipt_mismatch');const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}

export function FeedbackAttachments({feedbackId,items,csrfToken}:{feedbackId:string;items:FeedbackAttachment[];csrfToken:string}){
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),active=useRef(false),request=useRef<AbortController|null>(null),locked=useRef(false);
 const latest=useRef({feedbackId,items,csrfToken}),flight=useRef<{item:FeedbackAttachment;feedbackId:string;csrfToken:string}|null>(null),generation=useRef(0);
 latest.current={feedbackId,items,csrfToken};
 const readable=(item:FeedbackAttachment,context={feedbackId,csrfToken})=>latest.current.feedbackId===context.feedbackId&&latest.current.csrfToken===context.csrfToken&&latest.current.items.some(current=>
  current.id===item.id&&current.sha256===item.sha256&&current.byteSize===item.byteSize&&current.availability==='available'&&current.state==='available'&&Date.parse(current.expiresAt)>Date.now());
 useEffect(()=>{active.current=true;return()=>{active.current=false;request.current?.abort();};},[]);
 useLayoutEffect(()=>{if(request.current&&flight.current&&!readable(flight.current.item,flight.current)){
  generation.current++;request.current.abort();request.current=null;flight.current=null;locked.current=false;setBusy('');setError('附件状态已变化，当前不可读取。请刷新反馈。');
 }},[feedbackId,items,csrfToken]);
 async function download(item:FeedbackAttachment){
  if(locked.current||item.availability!=='available')return;
  if(!uuid.test(feedbackId)||!uuid.test(item.id)||!Number.isSafeInteger(item.byteSize)||item.byteSize<1||item.byteSize>67108864||!/^[a-f0-9]{64}$/.test(item.sha256)){setError('附件信息暂时无法确认，请刷新反馈。');return;}
  locked.current=true;setBusy(item.id);setError('');const controller=new AbortController(),version=++generation.current;request.current=controller;flight.current={item,feedbackId,csrfToken};
  try{
   const response=await fetch('/v1/operations/feedback/'+feedbackId+'/attachments/'+item.id+'/content',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
    headers:{'Content-Type':'application/json',Accept:'application/octet-stream','X-Galaxy-Operator-CSRF':csrfToken},body:'{}',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
   if(!response.ok){const value=await response.json().catch(()=>null),code=typeof value?.error==='string'?value.error:value?.error?.code??'';throw Object.assign(Error(code),{status:response.status,code});}
   if(response.headers.get('content-type')?.split(';')[0]!=='application/octet-stream')throw Error('attachment_receipt_mismatch');
   const bytes=await boundedBytes(response,item.byteSize),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
   if(digest!==item.sha256)throw Error('attachment_receipt_mismatch');if(!active.current||controller.signal.aborted||generation.current!==version)return;
   if(!readable(item))throw Object.assign(Error('feedback_attachment_content_unavailable'),{status:404});
   const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),link=document.createElement('a');
   link.href=url;link.download=item.name;link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(reason){if(active.current&&!controller.signal.aborted){const value=reason as {status?:number;code?:string;message?:string};setError(failure(value.status??0,value.code??value.message??''));}}
  finally{if(generation.current===version){locked.current=false;if(active.current){setBusy('');request.current=null;flight.current=null;}}}
 }
 return <section className="galaxy-feedback-attachments"><h3><AdminIcon name="file" size={15}/>附件{items.length?' · '+items.length:''}</h3>
  {items.length?<ul className="galaxy-feedback-attachment-list">{items.map(item=><li key={item.id}><div className="galaxy-feedback-attachment-meta"><strong>{item.name}</strong><span>{size(item.byteSize)} · {item.availability==='available'?'可下载':labels[item.state]??'当前不可读取'}</span></div>
   {item.availability==='available'&&<button type="button" className="galaxy-secondary" disabled={!!busy} onClick={()=>void download(item)}>{busy===item.id?'正在下载…':'下载附件'}</button>}
  </li>)}</ul>:<p>这条反馈没有附件。</p>}
  {error&&<p className="galaxy-error" role="alert">{error}</p>}
 </section>;
}
