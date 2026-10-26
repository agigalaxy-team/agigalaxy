'use client';

import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {AdminIcon} from './AdminIcons';
import {operationsFailure,OperationsRequestError} from '../lib/operations-client';
import type {PublicContentAttachment} from "./content-governance/public-content-types";

const imageTypes=new Set(['image/png','image/jpeg','image/webp','image/gif']);
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const allowedPath=new RegExp('^/v1/operations/community/content/(?:post|reply)/'+uuid+'/attachments/'+uuid+'/content$','i');
const sizeLabel=(value:number|null)=>value===null?'':value>=1048576?(value/1048576).toLocaleString('zh-CN',{maximumFractionDigits:1})+' MiB':value>=1024?(value/1024).toLocaleString('zh-CN',{maximumFractionDigits:1})+' KiB':value+' B';

function Attachment({attachment,csrfToken}:{attachment:PublicContentAttachment;csrfToken:string}){
  const [url,setUrl]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[renderImage,setRenderImage]=useState(false);
  const active=useRef<AbortController|null>(null),objectUrl=useRef<string|null>(null),generation=useRef(0);
  const path=attachment.availability==='available'&&attachment.contentPath&&allowedPath.test(attachment.contentPath)?attachment.contentPath:null;
  const isImage=imageTypes.has(attachment.mediaType??'');
  const clear=useCallback(()=>{if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=null;},[]);
  const load=useCallback(async(download=false)=>{
    if(!path)return;active.current?.abort();const controller=new AbortController(),version=++generation.current;active.current=controller;setBusy(true);setError('');
    try{
      let blob:Blob|undefined;
      for(let attempt=0;attempt<2;attempt++){
        try{
          const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':csrfToken},body:'{}',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
          if(!response.ok){const value=await response.json().catch(()=>null);throw new OperationsRequestError(response.status,typeof value?.error==='string'?value.error:typeof value?.error?.code==='string'?value.error.code:'attachment_unavailable');}
          blob=await response.blob();break;
        }catch(failure){if(controller.signal.aborted||attempt===1||failure instanceof OperationsRequestError&&failure.status<500||navigator.onLine===false)throw failure;}
      }
      if(!blob||controller.signal.aborted||generation.current!==version)return;
      const mediaType=attachment.mediaType??'';
      const content=imageTypes.has(mediaType)?new Blob([blob],{type:mediaType}):blob;
      clear();const next=URL.createObjectURL(content);objectUrl.current=next;setUrl(next);setRenderImage(imageTypes.has(content.type));
      if(download){const link=document.createElement('a');link.href=next;link.download=(attachment.name||'附件').replace(/[\\/]/g,'_');link.click();}
    }catch(failure){if(!controller.signal.aborted&&generation.current===version){clear();setUrl(null);setRenderImage(false);setError(operationsFailure(failure,'附件暂时无法读取，请重试。'));}}
    finally{if(generation.current===version)setBusy(false);}
  },[path,csrfToken,attachment.name,attachment.mediaType,clear]);
  useLayoutEffect(()=>{
    generation.current++;active.current?.abort();clear();setUrl(null);setError('');setBusy(false);setRenderImage(false);
    if(path&&isImage)void load();
    return()=>{generation.current++;active.current?.abort();clear();};
  },[path,isImage,load,clear,attachment.byteSize,attachment.state]);
  function download(){if(busy||!path)return;if(url){const link=document.createElement('a');link.href=url;link.download=(attachment.name||'附件').replace(/[\\/]/g,'_');link.click();}else void load(true);}
  return <li className="galaxy-content-attachment"><header><AdminIcon name="file" size={15}/><strong>{attachment.name||'附件'}</strong>{attachment.byteSize!==null&&<span>{sizeLabel(attachment.byteSize)}</span>}</header>{path&&url&&renderImage&&<img src={url} alt={attachment.name||'帖子附件'} onError={()=>{setError('图片暂时无法显示，可下载原附件。');setRenderImage(false);}}/>}{!path?<p>附件当前不可读取。</p>:<div className="galaxy-content-attachment-actions">{busy?<p role="status">正在读取附件…</p>:<button type="button" className="galaxy-secondary" onClick={isImage&&!url?()=>void load():download}>{isImage&&!url?'重新读取图片':'下载附件'}</button>}</div>}{error&&<p className="galaxy-error" role="alert">{error}</p>}</li>;
}
export function ContentAttachments({items,csrfToken}:{items:PublicContentAttachment[];csrfToken:string}){
  return items.length?<section className="galaxy-content-attachments"><h3>附件 · {items.length}</h3><ul>{items.map(attachment=><Attachment key={attachment.id} attachment={attachment} csrfToken={csrfToken}/>)}</ul></section>:null;
}
