import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Paperclip} from 'lucide-react';
import {readableTime} from './conversation-ui';
import {createAttachmentsClient} from './chat-attachments-client.mjs';
import type {z} from 'zod/v4';
import type {attachmentPrepareSchema,attachmentReferenceSchema} from '../../galaxy-official/src/shared/chat-attachments-schema.mjs';
import type {createWebRuntime} from './runtime.mjs';
type AttachmentRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'getLocal'|'putLocal'>;
type AttachmentReference=z.infer<typeof attachmentReferenceSchema>;
type AttachmentDisplay={attachmentId:string;state:string;name?:string;size?:number;sha256?:string;expiresAt?:string|null};
type OwnedAttachment=AttachmentDisplay&{name:string;size:number;sha256:string;messageId?:string|null};
type PendingUpload={subjectId:string;input:z.infer<typeof attachmentPrepareSchema>};
type AttachmentLimits={supported:boolean;maxFileBytes:number;maxSubjectBytes:number;maxFilesPerMessage:number;retentionDays:number};
type UploadOptions={confirmed:true;signal:AbortSignal;onStage:(stage:string)=>void};
type AttachmentsClient={
 download:(item:AttachmentDisplay,options:{ownExport:boolean})=>Promise<BlobPart>;
 pending:(roomId:string)=>Promise<PendingUpload|null>;
 reconcile:(roomId:string)=>Promise<unknown>;
 query:(roomId:string,after?:string)=>Promise<{items:OwnedAttachment[];nextAfter:string|null}>;
 read:(attachmentId:string)=>Promise<OwnedAttachment&{roomId:string}>;
 config:()=>Promise<AttachmentLimits>;
 retry:(roomId:string,file:File,options:UploadOptions)=>Promise<unknown>;
 send:(roomId:string,file:File,options:UploadOptions)=>Promise<unknown>;
 abandon:(roomId:string)=>Promise<unknown>;
 revoke:(roomId:string,attachmentId:string)=>Promise<unknown>;
};
type ComposerProps={runtime:AttachmentRuntime;roomId:string;disabled:boolean;selected:AttachmentReference[];onChange:(value:AttachmentReference[])=>void;onValidityChange?:(ready:boolean)=>void};
type RevokeChoice=OwnedAttachment&{pending?:false}|{pending:true;name:string;attachmentId?:undefined};
const uploadErrors:Record<string,string>={attachment_storage_quota_exceeded:'临时文件空间不足，请撤销不再需要的附件，等待清理后重试。',attachment_media_type_mismatch:'文件内容与声明类型不一致。',attachment_upload_in_progress:'原上传仍在处理中，请稍后查询。',attachment_unavailable:'暂时无法读取原附件，请保留待恢复记录；可以选择原文件恢复或明确撤销。'};
const uploadError=(reason:unknown)=>{const value=reason&&typeof reason==='object'?reason:null,code=value&&'code'in value&&typeof value.code==='string'?value.code:null,name=value&&'name'in value?value.name:null,message=value&&'message'in value&&typeof value.message==='string'?value.message:'操作暂未完成。';return code?uploadErrors[code]??'操作暂未完成，可按原文件恢复，或撤销此上传。':name==='AbortError'?'本机传输已中止，服务器结果仍需查询；原上传记录保留。':message;};
const states:Record<string,string>={prepared:'待上传',uploading:'上传中或等待原操作恢复','scan-pending':'等待检查',scanning:'正在检查',available:'可以使用',blocked:'检查未通过',erased:'文件已清理',expired:'已到期',revoked:'已撤销',unavailable:'目前不可读取'};
const size=(n:number)=>(n/1048576).toFixed(2)+' MiB';
export async function saveAttachment(client:Pick<AttachmentsClient,'download'>,item:AttachmentDisplay,ownExport=false){
 const bytes=await client.download(item,{ownExport}),url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
 try{const link=document.createElement('a');link.href=url;link.download=item.name??'附件';link.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
export function ChatAttachmentFiles(props:{runtime:AttachmentRuntime;items:AttachmentDisplay[]}){
 const connection=props.runtime.api.snapshot();
 return <ChatAttachmentFilesSession key={JSON.stringify([props.runtime.api.endpoint,connection?.subjectId,connection?.bindingId,connection?.generation])} {...props}/>;
}
function ChatAttachmentFilesSession({runtime,items}:{runtime:AttachmentRuntime;items:AttachmentDisplay[]}){
 const client:AttachmentsClient=useMemo(()=>createAttachmentsClient(runtime),[runtime]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 if(!items?.length)return null;
 return <div aria-label="消息附件">{error&&<p role="alert">{error}</p>}{items.map(item=><div key={item.attachmentId}><span>{item.name??'附件'} · {states[item.state]??item.state}{item.size?' · '+size(item.size):''}</span>
 {item.expiresAt&&<small> · 到期 {new Date(item.expiresAt).toLocaleString()}</small>}
 {item.state==='available'&&<Button type="button" variant="outline" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await saveAttachment(client,item);}catch{setError('文件当前不可下载，请刷新检查权限、撤回或期限。');}finally{setBusy(false);}}}>下载文件</Button>}</div>)}</div>;
}
export function ChatAttachmentComposer(props:ComposerProps){
 return <ChatAttachmentComposerSession key={JSON.stringify([props.roomId,props.runtime.api.endpoint,props.runtime.api.snapshot()?.subjectId,props.runtime.api.snapshot()?.bindingId,props.runtime.api.snapshot()?.generation])} {...props}/>;
}
function ChatAttachmentComposerSession({runtime,roomId,disabled,selected,onChange,onValidityChange}:ComposerProps){
 const client:AttachmentsClient=useMemo(()=>createAttachmentsClient(runtime),[runtime]),[file,setFile]=useState<File|null>(null),[items,setItems]=useState<OwnedAttachment[]>([]),[pending,setPending]=useState<PendingUpload|null>(null);
 const [limits,setLimits]=useState<AttachmentLimits|null>(null),[after,setAfter]=useState<string|null>(null),[busy,setBusy]=useState(false),[stage,setStage]=useState(''),[error,setError]=useState(''),[confirmRevoke,setConfirmRevoke]=useState<RevokeChoice|null>(null);
 const [open,setOpen]=useState(false),[clock,setClock]=useState(()=>Date.now());
 const dialog=useRef<HTMLDialogElement>(null),revokeDialog=useRef<HTMLDialogElement>(null),fileInput=useRef<HTMLInputElement>(null),reconciling=useRef<Promise<unknown>|null>(null);
 const epoch=useRef(0),control=useRef<AbortController|null>(null),working=useRef(false),reading=useRef(false),request=useRef(0);
 const pages=useRef<Array<string|undefined>>([undefined]),currentSelection=useRef({selected,onChange});
 useEffect(()=>{currentSelection.current={selected,onChange};},[selected,onChange]);
 const reload=useCallback(async(append?:string)=>{
  const e=epoch.current,seq=++request.current,cursors=append?[append]:pages.current;
  let saved=await client.pending(roomId);
  if(saved&&!working.current){const checking=client.reconcile(roomId);reconciling.current=checking;try{await checking;saved=await client.pending(roomId);}catch{/* The original file may still need to be selected again. */}finally{if(reconciling.current===checking)reconciling.current=null;}}
  const loaded=await Promise.all(cursors.map(cursor=>client.query(roomId,cursor)));
  if(e!==epoch.current||seq!==request.current)return;
  const rows=loaded.flatMap(page=>page.items),latest=loaded[loaded.length-1];
  const chosen=currentSelection.current.selected;
  const restored=await Promise.all(chosen.filter(item=>!rows.some(row=>row.attachmentId===item.id)).map(async item=>{try{const result=await client.read(item.id);if(result.roomId!==roomId||result.sha256!==item.sha256)throw Error('attachment_unavailable');return result;}catch{return{attachmentId:item.id,name:'已选附件',sha256:item.sha256,size:0,state:'unavailable'};}}));
  if(e!==epoch.current||seq!==request.current)return;rows.push(...restored);
  setItems(old=>[...new Map((append?[...old,...rows]:rows).map(item=>[item.attachmentId,item])).values()]);
  if(append&&!pages.current.includes(append))pages.current.push(append);
  setAfter(latest.nextAfter);setPending(saved);setClock(Date.now());
 },[client,roomId]);
 async function run(fn:()=>Promise<unknown>,refresh=true){
  if(working.current)return;const e=epoch.current;working.current=true;request.current++;setBusy(true);setError('');let completed=false;
  try{if(reconciling.current)await reconciling.current.catch(()=>{});if(e!==epoch.current)return;await fn();completed=true;if(refresh&&e===epoch.current)await reload();}
  catch(reason){if(e===epoch.current)setError(completed?'操作已返回，但附件列表暂未刷新；请查询原操作，不要重复上传。':uploadError(reason));}
  finally{if(e===epoch.current){try{setPending(await client.pending(roomId));}catch{}working.current=false;setBusy(false);setStage('');}}
 }
 useEffect(()=>{const generation=epoch,transfer=control;generation.current++;let active=true;
  client.config().then(value=>{if(active)setLimits(value);}).catch(()=>{if(active)setError('无法取得附件设置。');});reload().catch(()=>{});
  const refreshOnVisible=()=>{if(active&&!working.current&&!reading.current&&!document.hidden&&navigator.onLine!==false){reading.current=true;reload().catch(()=>{if(active)setItems([]);}).finally(()=>{reading.current=false;});}};
  const offline=()=>{request.current++;setItems([]);};
  document.addEventListener('visibilitychange',refreshOnVisible);
  window.addEventListener('online',refreshOnVisible);window.addEventListener('offline',offline);
  const timer=setInterval(refreshOnVisible,5000);
  return()=>{active=false;generation.current++;clearInterval(timer);document.removeEventListener('visibilitychange',refreshOnVisible);window.removeEventListener('online',refreshOnVisible);window.removeEventListener('offline',offline);transfer.current?.abort();};},[client,reload]);
 const usable=(value:AttachmentReference)=>items.some(item=>item.attachmentId===value.id&&item.sha256===value.sha256&&item.state==='available'&&!item.messageId&&(!item.expiresAt||Date.parse(item.expiresAt)>clock));
 const selectionReady=selected.every(usable);
 useEffect(()=>{onValidityChange?.(selectionReady);},[selectionReady,onValidityChange]);
 useEffect(()=>{const expiry=items.flatMap(item=>item.expiresAt&&Date.parse(item.expiresAt)>clock?[Date.parse(item.expiresAt)]:[]);if(!expiry.length)return;const timer=window.setTimeout(()=>setClock(Date.now()),Math.min(2147483647,Math.max(0,Math.min(...expiry)-Date.now())));return()=>window.clearTimeout(timer);},[items,clock]);
 useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
 useEffect(()=>{if(confirmRevoke)revokeDialog.current?.showModal();else revokeDialog.current?.close();},[confirmRevoke]);
 return <div className="chat-attachment-picker">
  <button type="button" className="attachment-entry text-link" disabled={disabled} onClick={()=>setOpen(true)}><Paperclip size={16}/>附件{selected.length?' · 已选 '+selected.length:''}</button>
  {selected.length>0&&<div className="attachment-selected-summary">{selected.map(value=>{const item=items.find(item=>item.attachmentId===value.id);return <span className="attachment-selected-item" key={value.id}><span>{item?.name??'已选附件'}{!usable(value)?' · 当前尚不能发送':''}</span><button type="button" disabled={disabled} aria-label={'移除'+(item?.name??'已选附件')} onClick={()=>onChange(selected.filter(other=>other.id!==value.id))}>移除</button></span>;})}</div>}
  <dialog ref={dialog} className="galaxy-dialog attachment-dialog" onCancel={event=>{if(busy)event.preventDefault();else setOpen(false);}}>
   <header className="dialog-heading"><div><h3>添加附件</h3><p>选择检查完成的文件，随下一条消息发送。</p></div><button type="button" className="text-link" disabled={busy} onClick={()=>setOpen(false)}>完成</button></header>
   {error&&<p className="message error" role="alert">{error}</p>}{stage&&<output className="message">{stage}{file?' · '+file.name:''}</output>}
   {limits&&!limits.supported&&<p className="browse-note">当前连接暂不支持上传附件。</p>}
   {pending&&<div className="operation-status"><h4>继续上传 {pending.input.name}</h4><p>原上传尚未完成，请重新选择同一个文件。系统会核对文件内容后接续。</p><button type="button" className="text-link" disabled={busy} onClick={()=>setConfirmRevoke({pending:true,name:pending.input.name})}>取消这次上传</button></div>}
   <label className="attachment-file-input">{pending?'重新选择原文件':'上传文件'}<input ref={fileInput} type="file" disabled={disabled||busy||!limits?.supported} onChange={event=>setFile(event.target.files?.[0]??null)}/></label>
   {limits&&<p className="record-meta">每个文件最多 {size(limits.maxFileBytes)} · 保留 {limits.retentionDays} 天</p>}
   {file&&<div className="attachment-upload-choice"><strong>{file.name}</strong><p>{size(file.size)}</p><Button type="button" disabled={disabled||busy||!limits?.supported} onClick={()=>run(async()=>{control.current=new AbortController();await(pending?client.retry(roomId,file,{confirmed:true,signal:control.current.signal,onStage:setStage}):client.send(roomId,file,{confirmed:true,signal:control.current.signal,onStage:setStage}));setFile(null);if(fileInput.current)fileInput.current.value='';})}>{busy?'正在上传…':pending?'接续上传':'上传文件'}</Button></div>}
   {busy&&<button type="button" className="text-link" onClick={()=>control.current?.abort()}>中止本机传输</button>}
   <div className="reading-list attachment-list">{items.map(item=>{const checked=selected.some(value=>value.id===item.attachmentId);return <article className="reading-list-item" key={item.attachmentId}><h4>{item.name||'已清理的附件'}</h4><p className="record-meta">{states[item.state]??item.state} · {size(item.size)}{item.messageId?' · 已发送':''}</p>{item.expiresAt&&<p className="record-meta">有效至 {readableTime(item.expiresAt)}</p>}
    {item.state==='available'&&!item.messageId&&<label className="checkbox-row"><input type="checkbox" checked={checked} disabled={disabled||busy||!checked&&selected.length>=(limits?.maxFilesPerMessage??4)} onChange={event=>onChange(event.target.checked?[...selected.filter(value=>value.id!==item.attachmentId),{id:item.attachmentId,sha256:item.sha256}]:selected.filter(value=>value.id!==item.attachmentId))}/>随下一条消息发送</label>}
    <div className="button-row">{item.state==='available'&&<button type="button" className="text-link" disabled={busy} onClick={()=>run(()=>saveAttachment(client,item,true))}>下载原文件</button>}{!['erased','revoked','expired'].includes(item.state)&&<button type="button" className="text-link" disabled={busy} onClick={()=>setConfirmRevoke(item)}>撤销文件</button>}</div>
   </article>;})}</div>
   {after&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(()=>reload(after!),false)}>更多附件</Button>}
   {limits&&<details className="technical-details"><summary>文件保留与容量</summary><p>每条消息最多 {limits.maxFilesPerMessage} 个文件，你的临时文件总容量为 {size(limits.maxSubjectBytes)}。文件在保留期限内可以撤销；独立保存为工作材料需要另行申请。</p></details>}
  </dialog>
  <dialog ref={revokeDialog} className="galaxy-dialog" onCancel={event=>{if(busy)event.preventDefault();else setConfirmRevoke(null);}}>
   {confirmRevoke&&<><h3>{confirmRevoke.pending?'取消这次上传':'撤销文件'}</h3><p>{confirmRevoke.name??'这个文件'}</p><p>确认后停止文件下载，已有消息文字保留。</p><div className="button-row"><Button type="button" disabled={busy} onClick={()=>run(async()=>{await(confirmRevoke.pending?client.abandon(roomId):client.revoke(roomId,confirmRevoke.attachmentId));onChange(selected.filter(value=>value.id!==confirmRevoke.attachmentId));setConfirmRevoke(null);})}>{busy?'正在处理…':'确认撤销'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setConfirmRevoke(null)}>返回</Button></div></>}
  </dialog>
 </div>;
}
