import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createAttachmentsClient} from './chat-attachments-client.mjs';
const states:Record<string,string>={prepared:'待上传',uploading:'上传中或等待原操作恢复','scan-pending':'等待检查',scanning:'正在检查',available:'可以使用',blocked:'检查未通过',erased:'文件已清理',expired:'已到期',revoked:'已撤销',unavailable:'目前不可读取'};
const size=(n:number)=>(n/1048576).toFixed(2)+' MiB';
export async function saveAttachment(client:any,item:any,ownExport=false){
 const bytes=await client.download(item,{ownExport}),url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
 try{const link=document.createElement('a');link.href=url;link.download=item.name;link.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
export function ChatAttachmentFiles({runtime,items}:{runtime:any;items:any[]}){
 const subjectId=runtime.api.snapshot()?.subjectId;
 const client=useMemo(()=>createAttachmentsClient(runtime),[runtime,subjectId]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 if(!items?.length)return null;
 return <div aria-label="消息附件">{error&&<p role="alert">{error}</p>}{items.map(item=><div key={item.attachmentId}><span>{item.name??'附件'} · {states[item.state]??item.state}{item.size?' · '+size(item.size):''}</span>
 {item.expiresAt&&<small> · 到期 {new Date(item.expiresAt).toLocaleString()}</small>}
 {item.state==='available'&&<Button type="button" variant="outline" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await saveAttachment(client,item);}catch{setError('文件当前不可下载，请刷新检查权限、撤回或期限。');}finally{setBusy(false);}}}>下载文件</Button>}</div>)}</div>;
}
export function ChatAttachmentComposer(props:{runtime:any;roomId:string;disabled:boolean;selected:any[];onChange:(v:any[])=>void}){
 return <ChatAttachmentComposerSession key={`${props.roomId}:${props.runtime.api.endpoint}:${props.runtime.api.snapshot()?.subjectId}`} {...props}/>;
}
function ChatAttachmentComposerSession({runtime,roomId,disabled,selected,onChange}:{runtime:any;roomId:string;disabled:boolean;selected:any[];onChange:(v:any[])=>void}){
 const client=useMemo(()=>createAttachmentsClient(runtime),[runtime]),[file,setFile]=useState<File|null>(null),[items,setItems]=useState<any[]>([]),[pending,setPending]=useState<any>(null);
 const [limits,setLimits]=useState<any>(null),[after,setAfter]=useState<string|null>(null),[busy,setBusy]=useState(false),[stage,setStage]=useState(''),[error,setError]=useState(''),[confirmRevoke,setConfirmRevoke]=useState<any>(null);
 const epoch=useRef(0),control=useRef<AbortController|null>(null),working=useRef(false),reading=useRef(false),request=useRef(0);
 const pages=useRef<Array<string|undefined>>([undefined]),currentSelection=useRef({selected,onChange});currentSelection.current={selected,onChange};
 async function reload(append?:string){
  const e=epoch.current,seq=++request.current,cursors=append?[append]:pages.current;
  const [loaded,saved]=await Promise.all([Promise.all(cursors.map(cursor=>client.query(roomId,cursor))),client.pending(roomId)]);
  if(e!==epoch.current||seq!==request.current)return;
  const rows=loaded.flatMap(page=>page.items),latest=loaded[loaded.length-1];
  setItems(old=>[...new Map((append?[...old,...rows]:rows).map(item=>[item.attachmentId,item])).values()]);
  if(append&&!pages.current.includes(append))pages.current.push(append);
  setAfter(latest.nextAfter);setPending(saved);
  const selection=currentSelection.current;
  const unavailable=new Set(rows.filter(item=>item.state!=='available'||item.messageId).map(item=>item.attachmentId));
  if(selection.selected.some(item=>unavailable.has(item.id)))selection.onChange(selection.selected.filter(item=>!unavailable.has(item.id)));
 }
 async function run(fn:()=>Promise<any>,refresh=true){
  if(working.current)return;const e=epoch.current;working.current=true;request.current++;setBusy(true);setError('');let completed=false;
  try{await fn();completed=true;if(refresh&&e===epoch.current)await reload();}
  catch(reason:any){if(e===epoch.current)setError(completed?'操作已返回，但附件列表暂未刷新；请查询原操作，不要重复上传。':reason?.code?({attachment_storage_quota_exceeded:'临时文件空间不足，请撤销不再需要的附件，等待清理后重试。',attachment_media_type_mismatch:'文件内容与声明类型不一致。',attachment_upload_in_progress:'原上传仍在处理中，请稍后查询。',attachment_unavailable:'暂时无法读取原附件，请保留待恢复记录；可以选择原文件恢复或明确撤销。'} as any)[reason.code]??'操作暂未完成，可按原文件恢复，或撤销此上传。':reason?.name==='AbortError'?'本机传输已中止，服务器结果仍需查询；原上传记录保留。':reason.message);}
  finally{if(e===epoch.current){try{setPending(await client.pending(roomId));}catch{}working.current=false;setBusy(false);setStage('');}}
 }
 useEffect(()=>{epoch.current++;setFile(null);setItems([]);setPending(null);setError('');setLimits(null);let active=true;
  client.config().then((v:any)=>{if(active)setLimits(v);}).catch(()=>{if(active)setError('无法取得附件设置。');});reload().catch(()=>{});
  const refreshOnVisible=()=>{if(active&&!working.current&&!reading.current&&!document.hidden){reading.current=true;reload().catch(()=>{}).finally(()=>{reading.current=false;});}};
  document.addEventListener('visibilitychange',refreshOnVisible);
  const timer=setInterval(refreshOnVisible,5000);
  return()=>{active=false;epoch.current++;clearInterval(timer);document.removeEventListener('visibilitychange',refreshOnVisible);control.current?.abort();};},[client,roomId]);
 return <details><summary>临时附件{selected.length?' · 已选 '+selected.length:''}</summary>
  <p className="muted">文件单独保留 30 天；扫描后才能随消息发送。检查未发现威胁也不保证安全，请只打开可信内容。不会自动成为证据或公开资料。</p>
  {limits&&<p>每个文件最多 {size(limits.maxFileBytes)}，本人临时文件共 {size(limits.maxSubjectBytes)}，每条消息最多 {limits.maxFilesPerMessage} 个。</p>}
  {error&&<p role="alert">{error}</p>}{stage&&<p role="status">{stage} · {file?size(file.size):''}</p>}
  {pending&&<div><p>待恢复：{pending.input.name}。先查询服务器结果；仅在仍需上传时选择原文件恢复。</p><Button type="button" variant="outline" disabled={busy} onClick={()=>run(()=>client.reconcile(roomId))}>查询原上传结果</Button></div>}
  <label>选择文件<input type="file" disabled={disabled||busy||!limits?.supported} onChange={e=>setFile(e.target.files?.[0]??null)}/></label>
  {file&&<p>{file.name} · {size(file.size)} · {file.type||'未知类型，只允许下载'}</p>}
  <div className="button-row"><Button type="button" disabled={disabled||busy||!file||!limits?.supported} onClick={()=>run(async()=>{control.current=new AbortController();await (pending?client.retry(roomId,file!,{confirmed:true,signal:control.current.signal,onStage:setStage}):client.send(roomId,file!,{confirmed:true,signal:control.current.signal,onStage:setStage}));setFile(null);})}>{pending?'确认恢复原上传':'确认上传临时附件'}</Button>
  {busy&&<Button type="button" variant="outline" onClick={()=>control.current?.abort()}>中止本机传输</Button>}
  {pending&&<Button type="button" variant="outline" disabled={busy} onClick={()=>setConfirmRevoke({pending:true})}>撤销待恢复上传</Button>}</div>
  {items.map(item=><div className="task-card" key={item.attachmentId}><p>{item.name||'已清理附件'} · {states[item.state]??item.state} · {size(item.size)}</p><small>到期 {new Date(item.expiresAt).toLocaleString()}{item.messageId?' · 已随消息发送':''}</small>
   {item.state==='available'&&!item.messageId&&<label><input type="checkbox" checked={selected.some(s=>s.id===item.attachmentId)} disabled={disabled||busy} onChange={e=>onChange(e.target.checked?[...selected.filter(s=>s.id!==item.attachmentId),{id:item.attachmentId,sha256:item.sha256}].slice(0,limits?.maxFilesPerMessage??4):selected.filter(s=>s.id!==item.attachmentId))}/>随下一条消息发送</label>}
   {item.state==='available'&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>run(()=>saveAttachment(client,item,true))}>保存我的原文件</Button>}
   {!['erased','revoked','expired'].includes(item.state)&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>setConfirmRevoke(item)}>撤销文件</Button>}</div>)}
  {after&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(()=>reload(after!),false)}>更多附件</Button>}
  {confirmRevoke&&<div role="region"><p>确认撤销这个临时文件？已有消息文字会保留，文件下载立即停止，服务器会清理自己保存的文件。</p><Button type="button" disabled={busy} onClick={()=>run(async()=>{await(confirmRevoke.pending?client.abandon(roomId):client.revoke(roomId,confirmRevoke.attachmentId));onChange(selected.filter(s=>s.id!==confirmRevoke.attachmentId));setConfirmRevoke(null);})}>确认撤销</Button><Button type="button" variant="ghost" onClick={()=>setConfirmRevoke(null)}>取消</Button></div>}
 </details>;
}
