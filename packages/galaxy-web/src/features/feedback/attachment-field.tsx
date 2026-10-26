import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Paperclip} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {OfficialAccountModel} from '../../official-account-panel';
import type {useAccountConnection} from '../../account-center';
import {createFeedbackAttachmentsClient,feedbackAttachmentError,feedbackDraftAttachmentsSchema,feedbackAttachmentSpecificationSchema} from './attachments-client.mjs';

export type FeedbackDraftAttachment=ReturnType<typeof feedbackDraftAttachmentsSchema.parse>[number];
type Limits=ReturnType<typeof feedbackAttachmentSpecificationSchema.parse>;
type Connection=ReturnType<typeof useAccountConnection>;
const labels:Record<FeedbackDraftAttachment['state'],string>={preparing:'待上传',prepared:'待上传',uploading:'正在上传',unconfirmed:'等待确认',
 'scan-pending':'待扫描',scanning:'扫描中',available:'可随反馈提交',blocked:'已隔离',erased:'已移除',revoked:'已移除',expired:'已到期',unavailable:'不可用'};
const pendingStates=new Set(['scan-pending','scanning','uploading','unconfirmed']);
const uploadStates=new Set(['preparing','prepared','uploading','unconfirmed']);
const size=(bytes:number)=>bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':bytes>=1024?Math.ceil(bytes/1024)+' KB':bytes+' 字节';

export function FeedbackAttachmentField({operationId,attachments,ownerId,csrf,client,connection,available,disabled,onChange,onBusy}:{
 operationId:string;attachments:FeedbackDraftAttachment[];ownerId:string;csrf:string|undefined;client:NonNullable<OfficialAccountModel['client']>;connection:Connection;
 available:boolean;disabled:boolean;onChange:(items:FeedbackDraftAttachment[])=>void;onBusy:(busy:boolean)=>void;
}){
 const [limits,setLimits]=useState<Limits|null>(null),[configError,setConfigError]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false),[poll,setPoll]=useState(0);
 const current=useRef(attachments),callbacks=useRef({onChange,onBusy}),active=useRef(false),working=useRef(false),reading=useRef(false),files=useRef(new Map<string,File>()),controller=useRef<AbortController|null>(null),picker=useRef<HTMLInputElement>(null);
 current.current=attachments;callbacks.current={onChange,onBusy};
 const source=useMemo(()=>createFeedbackAttachmentsClient({account:{
  assertCurrent:()=>{connection.authority.requireSession(ownerId,csrf);},
  call:(path,input,options)=>client.call(path,input,{session:connection.authority.requireSession(ownerId,csrf),signal:options?.signal}),
  transfer:(path,input,options)=>client.transfer(path,input,{session:connection.authority.requireSession(ownerId,csrf),method:options?.method,signal:options?.signal}),
 }}),[client,connection.authority,ownerId,csrf]);
 useEffect(()=>{const selectedFiles=files.current;active.current=true;return()=>{active.current=false;controller.current?.abort();callbacks.current.onBusy(false);selectedFiles.clear();};},[]);
 useEffect(()=>{let live=true;if(!available)return;setConfigError('');void source.config().then(value=>{if(live)setLimits(value);},reason=>{if(live){setLimits(null);setConfigError(feedbackAttachmentError(reason));}});return()=>{live=false;};},[source,available]);
 function publish(items:FeedbackDraftAttachment[]){if(!active.current)return;current.current=items;callbacks.current.onChange(items);}
 function replace(item:FeedbackDraftAttachment){publish(current.current.map(value=>value.id===item.id?item:value));}
 const refresh=useCallback(async(quiet=false)=>{
  if(!available||disabled||working.current||reading.current||!current.current.length)return;
  reading.current=true;setRefreshing(true);if(!quiet)setError('');const snapshot=current.current;
  try{
   const results=await Promise.allSettled(snapshot.map(item=>source.read(item)));
   if(!active.current)return;
   const values=new Map<string,FeedbackDraftAttachment>();let failure='';
   results.forEach((result,index)=>{const original=snapshot[index];if(result.status==='fulfilled')values.set(original.id,result.value);else{
    if(['feedback_attachment_unavailable','not_found'].includes(result.reason?.code))values.set(original.id,{...original,state:'unavailable'});
    failure=feedbackAttachmentError(result.reason);
   }});
   publish(current.current.map(item=>values.get(item.id)??item));if(failure)setError(failure);
  }finally{reading.current=false;if(active.current){setRefreshing(false);setPoll(value=>value+1);}}
 },[available,disabled,source]);
 const waiting=attachments.some(item=>pendingStates.has(item.state));
 useEffect(()=>{if(!waiting||!available||disabled||busy||poll>=12)return;const timer=setTimeout(()=>void refresh(true),5000);return()=>clearTimeout(timer);},[waiting,available,disabled,busy,poll,refresh]);
 async function perform(action:(signal:AbortSignal)=>Promise<void>){
  if(disabled||working.current||!available)return;working.current=true;setBusy(true);callbacks.current.onBusy(true);setError('');const request=new AbortController();controller.current=request;
  try{await action(request.signal);}catch(reason){if(active.current&&!request.signal.aborted)setError(feedbackAttachmentError(reason));}
  finally{working.current=false;if(active.current){setBusy(false);callbacks.current.onBusy(false);controller.current=null;setPoll(0);}}
 }
 async function upload(record:FeedbackDraftAttachment,file:File,signal:AbortSignal){
  files.current.set(record.id,file);
  try{await source.upload(record,file,{signal,onState:async value=>{if(!signal.aborted)replace(value);}});}
  catch(reason){if(!signal.aborted)replace({...((current.current.find(value=>value.id===record.id))??record),state:'unconfirmed'});throw reason;}
 }
 async function add(selected:File[]){await perform(async signal=>{
  if(!limits?.supported)throw Object.assign(Error('attachment_service_unavailable'),{code:'attachment_service_unavailable'});
  if(current.current.length+selected.length>limits.maxFilesPerFeedback)throw Object.assign(Error('feedback_attachment_count_exceeded'),{code:'feedback_attachment_count_exceeded'});
  for(const file of selected){signal.throwIfAborted();const record=await source.plan(file,operationId,limits);if(!active.current||signal.aborted)return;
   publish([...current.current,record]);await upload(record,file,signal);
  }
 });}
 function retry(record:FeedbackDraftAttachment,file:File){void perform(signal=>upload(record,file,signal));}
 function remove(record:FeedbackDraftAttachment){void perform(async()=>{
  try{await source.revoke(record);}catch(reason){if(!['feedback_attachment_unavailable','not_found'].includes((reason as {code?:string})?.code??''))throw reason;}
  files.current.delete(record.id);publish(current.current.filter(item=>item.id!==record.id));
 });}
 return <section className="feedback-file-field" aria-labelledby="feedback-files-title" aria-busy={busy||refreshing}>
  <header><h2 id="feedback-files-title"><Paperclip size={16} aria-hidden="true"/>附件<span>选填</span></h2>{attachments.length>0&&<button type="button" className="text-link" disabled={disabled||busy||refreshing||!available} onClick={()=>void refresh()}>{refreshing?'正在确认…':'刷新附件状态'}</button>}</header>
  <input ref={picker} className="feedback-file-input" type="file" multiple tabIndex={-1} aria-hidden="true" disabled={disabled||busy||!limits?.supported||!available} onChange={event=>{const selected=Array.from(event.target.files??[]);event.target.value='';if(selected.length)void add(selected);}}/>
  {attachments.length>0&&<ul>{attachments.map(record=><li key={record.id} data-state={record.state}><div className="feedback-file-description"><strong>{record.name}</strong><span>{size(record.size)} · {labels[record.state]}</span></div><div className="feedback-file-controls">
   {uploadStates.has(record.state)&&(files.current.has(record.id)?<button type="button" className="text-link" disabled={disabled||busy||!available} onClick={()=>retry(record,files.current.get(record.id)!)}>继续上传</button>:<label className="feedback-file-reselect"><span>选择原文件</span><input type="file" disabled={disabled||busy||!available} aria-label={'选择原文件 '+record.name} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)retry(record,file);}}/></label>)}
   <button type="button" className="text-link" disabled={disabled||busy||!available} aria-label={'移除附件 '+record.name} onClick={()=>remove(record)}>移除</button>
  </div></li>)}</ul>}
  <div className="feedback-file-add"><Button type="button" variant="outline" disabled={disabled||busy||!available||!limits?.supported||attachments.length>=(limits?.maxFilesPerFeedback??0)} onClick={()=>picker.current?.click()}>{busy?'正在处理附件…':'添加附件'}</Button>
   <p>{limits?.supported?'最多 '+limits.maxFilesPerFeedback+' 个文件，每个不超过 '+size(limits.maxFileBytes)+'。附件扫描完成后可提交。':configError||(limits?'附件暂未启用，可继续提交文字反馈。':'正在读取附件可用状态…')}</p>
  </div>
  {error&&<p className="feedback-error" role="alert">{error}</p>}
 </section>;
}
