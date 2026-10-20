import React,{useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Paperclip} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {LoadingFeedback} from './interaction-feedback';
import {useReadTasks} from './use-read-task';
import {forumAttachmentError,type createForumAttachmentsClient,type forumDraftAttachmentSchema} from './forum-attachment-client.mjs';
import type {z} from 'zod/v4';
import type {forumAttachmentSourceSchema} from '../../galaxy-official/src/shared/forum-attachments-v1-schema.mjs';
import './forum-attachments.css';

export type ForumDraftAttachment=z.infer<typeof forumDraftAttachmentSchema>;
export type ForumAttachmentClient=ReturnType<typeof createForumAttachmentsClient>;
export type ForumAttachmentView={attachmentId:string;name?:string;mediaType?:string;size?:number;sha256?:string;state:string;expiresAt?:string|null};
export type ForumAttachmentSource=z.infer<typeof forumAttachmentSourceSchema>;
const pendingStates=new Set(['preparing','prepared','uploading','unconfirmed','scan-pending','scanning']);
const terminalStates=new Set(['blocked','erased','revoked','expired','unavailable']);
const size=(bytes?:number)=>typeof bytes!=='number'?'':bytes<1048576?Math.max(1,Math.ceil(bytes/1024))+' KB':(bytes/1048576).toFixed(bytes%1048576?1:0)+' MB';
const stateLabel=(state:string)=>({preparing:'正在准备…',prepared:'待上传',uploading:'正在上传…',unconfirmed:'正在确认上传结果…',failed:'上传未完成', 'scan-pending':'正在检查…',scanning:'正在检查…',available:'已就绪',blocked:'文件未通过检查',erased:'文件已清理',revoked:'文件已撤回',expired:'文件已到期',unavailable:'文件暂时不可用'} as Record<string,string>)[state]??'文件暂时不可用';

function updatedRecord(previous:ForumDraftAttachment,value:ForumAttachmentView&{uploadRetryAt?:string|null;uploadRetryable?:boolean}){
 if(value.attachmentId!==previous.id||value.sha256!==previous.sha256||previous.size!==undefined&&value.size!==previous.size)throw Error('attachment_receipt_mismatch');
 return {...previous,...(value.name?{name:value.name}:{}),...(value.mediaType?{mediaType:value.mediaType}:{}),...(value.size?{size:value.size}:{}),state:value.state,uploadRetryAt:value.uploadRetryAt??null,uploadRetryable:value.uploadRetryable??false};
}

type ComposerProps={client:ForumAttachmentClient;draftId:string;value:ForumDraftAttachment[];onChange:(value:ForumDraftAttachment[])=>Promise<void>;disabled?:boolean;canUpload:boolean;offline?:boolean;onLogin:()=>void;onBusyChange:(value:boolean)=>void};
export function ForumAttachmentComposer({client,draftId,value,onChange,disabled=false,canUpload,offline=false,onLogin,onBusyChange}:ComposerProps){
 const [limits,setLimits]=useState<{supported:boolean;maxFileBytes:number;maxFilesPerMessage:number}|null>(null),[error,setError]=useState(''),[working,setWorking]=useState(false);
 const [localFileIds,setLocalFileIds]=useState<Set<string>>(()=>new Set()),[uploadIds,setUploadIds]=useState<Set<string>>(()=>new Set());
 const inputId=useId(),input=useRef<HTMLInputElement>(null),reselect=useRef<string|null>(null),files=useRef(new Map<string,File>()),uploads=useRef(new Map<string,AbortController>()),alive=useRef(false);
 const selection=useRef({value,onChange,disabled,canUpload});
 useLayoutEffect(()=>{selection.current={value,onChange,disabled,canUpload};},[value,onChange,disabled,canUpload]);
 const reads=useReadTasks(draftId),busyCount=useRef(0);
 const rememberFile=useCallback((id:string,file:File)=>{files.current.set(id,file);setLocalFileIds(previous=>new Set(previous).add(id));},[]);
 const forgetFile=useCallback((id:string)=>{files.current.delete(id);setLocalFileIds(previous=>{const next=new Set(previous);next.delete(id);return next;});},[]);
 const setWorkingState=useCallback((change:number)=>{busyCount.current=Math.max(0,busyCount.current+change);const active=busyCount.current>0;if(alive.current){setWorking(active);onBusyChange(active);}},[onBusyChange]);
 const saveRecord=useCallback(async(record:ForumDraftAttachment)=>{
  if(!alive.current||selection.current.disabled||!selection.current.value.some(item=>item.id===record.id&&item.sha256===record.sha256))throw new DOMException('File selection changed','AbortError');
  const values=selection.current.value.map(item=>item.id===record.id?record:item);selection.current={...selection.current,value:values};await selection.current.onChange(values);
 },[]);
 const uploadFile=useCallback(async(record:ForumDraftAttachment,file:File)=>{
  if(!alive.current||selection.current.disabled||!selection.current.canUpload||uploads.current.has(record.id))return;
  const control=new AbortController();uploads.current.set(record.id,control);setUploadIds(previous=>new Set(previous).add(record.id));setWorkingState(1);setError('');
  try{await client.upload(record,file,{signal:control.signal,onState:saveRecord});}
  catch(reason){if(alive.current&&!control.signal.aborted&&selection.current.value.some(item=>item.id===record.id)){
   setError(forumAttachmentError(reason));
   const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';
   const transient=['attachment_upload_in_progress','attachment_upload_capacity','request_timeout','official_account_unavailable'].includes(code);
   const rejected=['attachment_file_changed','attachment_receipt_mismatch'].includes(code)||!transient&&!!reason&&typeof reason==='object'&&'outcome'in reason&&reason.outcome==='rejected';
   if(code==='attachment_file_changed')forgetFile(record.id);
   await saveRecord({...selection.current.value.find(item=>item.id===record.id)!,state:rejected?'failed':'unconfirmed'}).catch(()=>{});
  }}finally{uploads.current.delete(record.id);if(alive.current)setUploadIds(previous=>{const next=new Set(previous);next.delete(record.id);return next;});setWorkingState(-1);}
 },[client,saveRecord,setWorkingState,forgetFile]);
 const refresh=useCallback(async()=>{
  if(!alive.current||document.hidden||!selection.current.canUpload)return;
  await reads.run({lane:'receipts',key:JSON.stringify(selection.current.value.map(item=>[item.id,item.sha256]))},async({signal})=>{
   for(const item of selection.current.value){
    if(signal.aborted||!alive.current)return;if(uploads.current.has(item.id)||terminalStates.has(item.state))continue;
    let receipt:ForumAttachmentView&{uploadRetryAt?:string|null;uploadRetryable?:boolean};
    try{receipt=await client.read(item.id,{signal});}catch(reason){
     if(signal.aborted||!alive.current)return;
     const code=reason&&typeof reason==='object'&&'code'in reason?reason.code:null;
     if(['attachment_unavailable','not_found'].includes(String(code))){const file=files.current.get(item.id);if(file&&pendingStates.has(item.state))void uploadFile(item,file);continue;}
     throw reason;
    }
    if(signal.aborted||!alive.current)return;const current=selection.current.value.find(value=>value.id===item.id&&value.sha256===item.sha256);if(!current)continue;
    const next=updatedRecord(current,receipt);if(JSON.stringify(current)!==JSON.stringify(next))await saveRecord(next);
    const file=files.current.get(item.id);if(file&&next.uploadRetryable&&pendingStates.has(next.state))void uploadFile(next,file);
   }
  },{onError:reason=>{if(alive.current&&!(reason instanceof DOMException&&reason.name==='AbortError'))setError(forumAttachmentError(reason));}});
 },[client,reads,saveRecord,uploadFile]);
 useEffect(()=>{const controllers=uploads.current;alive.current=true;return()=>{alive.current=false;for(const control of controllers.values())control.abort();controllers.clear();onBusyChange(false);};},[client,draftId,onBusyChange]);
 const ids=value.map(item=>item.id).join(':');
 const readConfig=useCallback(()=>reads.run({lane:'config',key:'config'},()=>client.config(),{onSuccess:setLimits,onError:reason=>setError(forumAttachmentError(reason))}),[client,reads]);
 useEffect(()=>{void readConfig();},[readConfig]);
 useEffect(()=>{void refresh();},[ids,canUpload,refresh]);
 const waiting=value.some(item=>pendingStates.has(item.state));
 useEffect(()=>{if(!canUpload||!ids)return;const tick=()=>void refresh(),timer=waiting?window.setInterval(tick,2500):null;window.addEventListener('online',tick);window.addEventListener('focus',tick);return()=>{if(timer!==null)window.clearInterval(timer);window.removeEventListener('online',tick);window.removeEventListener('focus',tick);};},[canUpload,ids,waiting,refresh]);
 async function chooseFiles(chosen:File[]){
  if(!chosen.length||disabled||!canUpload||!limits?.supported)return;
  const original=reselect.current;reselect.current=null;
  if(original){const record=selection.current.value.find(item=>item.id===original);if(record){rememberFile(original,chosen[0]);await uploadFile(record,chosen[0]);}return;}
  const maximum=Math.min(4,limits.maxFilesPerMessage);
  if(chosen.length+selection.current.value.length>maximum){setError('每条内容最多添加 '+maximum+' 个文件。');return;}
  setWorkingState(1);setError('');
  try{for(const file of chosen){
   if(!alive.current||selection.current.disabled||!selection.current.canUpload)return;
   const record=await client.plan(file,limits);if(!alive.current||selection.current.disabled||!selection.current.canUpload)return;
   const next=[...selection.current.value,record];selection.current={...selection.current,value:next};await selection.current.onChange(next);rememberFile(record.id,file);await uploadFile(record,file);
  }}catch(reason){if(alive.current)setError(forumAttachmentError(reason));}finally{setWorkingState(-1);}
 }
 async function remove(record:ForumDraftAttachment){
  uploads.current.get(record.id)?.abort();forgetFile(record.id);const next=selection.current.value.filter(item=>item.id!==record.id);selection.current={...selection.current,value:next};
  try{await selection.current.onChange(next);}catch(reason){setError(forumAttachmentError(reason));}
 }
 return <section className="forum-attachment-composer" aria-label="附件">
  <div className="forum-attachment-tools">{canUpload?<Button type="button" variant="ghost" disabled={disabled||working||!limits?.supported||value.length>=Math.min(4,limits?.maxFilesPerMessage??4)} onClick={()=>{reselect.current=null;if(input.current){input.current.multiple=true;input.current.click();}}}><Paperclip size={16} aria-hidden="true"/>添加文件</Button>:<Button type="button" variant="ghost" disabled={disabled||offline} onClick={onLogin}><Paperclip size={16} aria-hidden="true"/>{offline?'联网后添加文件':'登录后添加文件'}</Button>}{limits?.supported&&canUpload&&<span>每个文件不超过 {size(limits.maxFileBytes)}</span>}{limits?.supported===false&&<span>暂时不能上传文件</span>}</div>
  <input ref={input} id={inputId} className="forum-file-input" type="file" tabIndex={-1} multiple disabled={disabled||working||!canUpload||!limits?.supported} aria-label="选择附件" onChange={event=>{const chosen=Array.from(event.target.files??[]);event.currentTarget.value='';void chooseFiles(chosen);}}/>
  {value.length>0&&<ul className="forum-draft-files">{value.map(record=><li key={record.id}><Paperclip size={18} aria-hidden="true"/><div><strong>{record.name||'原附件'}</strong><span>{size(record.size)} · {stateLabel(record.state)}</span></div><div className="forum-file-actions">{canUpload&&!disabled&&!uploadIds.has(record.id)&&(['failed','prepared','preparing'].includes(record.state)||record.state==='uploading'&&record.uploadRetryable||record.state==='unconfirmed')&&<button type="button" className="text-link" onClick={()=>{const file=files.current.get(record.id);if(file)void uploadFile(record,file);else{reselect.current=record.id;if(input.current){input.current.multiple=false;input.current.click();}}}}>{localFileIds.has(record.id)?'继续上传':'选择原文件'}</button>}<button type="button" className="text-link" disabled={disabled} aria-label={'移除 '+(record.name||'原附件')} onClick={()=>void remove(record)}>移除</button></div></li>)}</ul>}
  <LoadingFeedback active={working||!limits&&!error} label={working?'正在上传文件…':'正在准备文件上传…'} scopeKey={draftId}/>
  {error&&<p className="forum-file-error" role="alert">{error}{canUpload&&<button type="button" className="text-link" onClick={()=>{setError('');void readConfig();void refresh();}}>重试</button>}</p>}
 </section>;
}

export function ForumAttachmentFiles({client,items,source}:{client:ForumAttachmentClient;items:ForumAttachmentView[];source:ForumAttachmentSource}){
 const [working,setWorking]=useState<string|null>(null),[error,setError]=useState('');
 const [clock,setClock]=useState(()=>Date.now());
 const scope=JSON.stringify(source),alive=useRef(false),control=useRef<AbortController|null>(null),lock=useRef(false);
 useEffect(()=>{alive.current=true;const stop=()=>control.current?.abort(),hidden=()=>{if(document.hidden)stop();else setClock(Date.now());};window.addEventListener('offline',stop);document.addEventListener('visibilitychange',hidden);return()=>{alive.current=false;stop();window.removeEventListener('offline',stop);document.removeEventListener('visibilitychange',hidden);};},[client,scope]);
 useEffect(()=>{const next=Math.min(...items.flatMap(item=>item.expiresAt&&Number.isFinite(Date.parse(item.expiresAt))&&Date.parse(item.expiresAt)>clock?[Date.parse(item.expiresAt)]:[]));if(!Number.isFinite(next))return;const timer=window.setTimeout(()=>setClock(Date.now()),Math.min(2147483647,Math.max(0,next-Date.now()+1)));return()=>window.clearTimeout(timer);},[items,clock]);
 const download=useCallback(async(item:ForumAttachmentView)=>{
  if(lock.current)return;lock.current=true;setWorking(item.attachmentId);setError('');const transfer=new AbortController();control.current=transfer;
   try{const bytes=await client.download(item,source,{signal:transfer.signal});if(!alive.current||transfer.signal.aborted||document.hidden)return;
   const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),link=document.createElement('a');link.href=url;link.download=item.name||'银河附件';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(reason){if(alive.current&&!transfer.signal.aborted)setError(forumAttachmentError(reason));}finally{lock.current=false;if(alive.current)setWorking(null);}
 },[client,source]);
 if(!items.length)return null;
 return <section className="forum-content-files" aria-label="附件"><ul>{items.map(item=>{const expired=!!item.expiresAt&&Date.parse(item.expiresAt)<=clock,available=item.state==='available'&&!expired;return <li key={item.attachmentId}><Paperclip size={19} aria-hidden="true"/><div><strong>{item.name||'附件'}</strong><span>{size(item.size)}{!available?' · '+stateLabel(expired?'expired':item.state):''}</span></div>{available&&<Button type="button" variant="ghost" disabled={!!working} onClick={()=>void download(item)}>{working===item.attachmentId?'正在下载…':'下载'}</Button>}</li>;})}</ul>{error&&<p className="forum-file-error" role="alert">{error}</p>}</section>;
}
