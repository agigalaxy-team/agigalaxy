import * as z from 'zod/v4';
import {forumAttachmentPrepareSchema,forumAttachmentSourceSchema} from '../../galaxy-official/src/shared/forum-attachments-v1-schema.mjs';

const states=['preparing','prepared','uploading','unconfirmed','failed','scan-pending','scanning','available','blocked','erased','revoked','expired','unavailable'];
export const forumDraftAttachmentSchema=forumAttachmentPrepareSchema.omit({attachmentId:true}).partial({name:true,mediaType:true,size:true}).extend({id:z.uuid(),state:z.enum(states),existing:z.boolean().default(false),uploadRetryAt:z.string().nullable().optional(),uploadRetryable:z.boolean().optional()}).refine(value=>value.existing||!!value.name&&!!value.mediaType&&!!value.size);
export const forumDraftAttachmentsSchema=z.array(forumDraftAttachmentSchema).max(4).refine(values=>new Set(values.map(value=>value.id)).size===values.length);
export const forumAttachmentDigest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
const error=code=>Object.assign(Error(code),{code});
const rejected=new Set(['blocked','erased','revoked','expired','unavailable']);

export function forumAttachmentDraft(value,{existing=false}={}){
 return forumDraftAttachmentSchema.parse({id:value.attachmentId??value.id,...(value.name?{name:value.name}:{}),...(value.mediaType?{mediaType:value.mediaType}:{}),...(value.size?{size:value.size}:{}),sha256:value.sha256,state:value.state,existing,
  ...(value.uploadRetryAt!==undefined?{uploadRetryAt:value.uploadRetryAt}:{}),...(value.uploadRetryable!==undefined?{uploadRetryable:value.uploadRetryable}:{})});
}

/** @param {{endpoint:string,publicCall:(path:string,input:unknown)=>Promise<any>,account?:{assertCurrent:()=>void,call:(path:string,input:unknown,options?:{signal?:AbortSignal})=>Promise<any>,transfer?:(path:string,input:unknown,options?:{method?:string,signal?:AbortSignal})=>Promise<Response>}|null,fetch?:typeof globalThis.fetch}} options */
export function createForumAttachmentsClient({endpoint,publicCall,account=null,fetch:fetcher=globalThis.fetch}){
 const prefix='/v2/community/attachments/';
 const assertAccount=()=>{if(!account)throw error('official_account_session_expired');account.assertCurrent();};
 const current=()=>account?.assertCurrent();
 /** @template T @param {()=>Promise<T>} action @returns {Promise<T>} */
 const guard=async action=>{current();try{const result=await action();current();return result;}catch(reason){current();throw reason;}};
 const call=(name,input,options={})=>{assertAccount();return guard(()=>account.call(prefix+name,input,options));};
 /** @param {string} attachmentId @param {{signal?:AbortSignal}} [options] */
 const read=(attachmentId,{signal}={})=>call('read',{attachmentId:z.uuid().parse(attachmentId)},{signal});
 const matches=(record,value)=>{
  if(value.attachmentId!==record.id||value.sha256!==record.sha256||record.size!==undefined&&value.size!==record.size||record.name!==undefined&&value.name&&value.name!==record.name||record.mediaType!==undefined&&value.mediaType&&value.mediaType!==record.mediaType)throw error('attachment_receipt_mismatch');
  return forumAttachmentDraft({...record,...value,name:value.name||record.name,mediaType:value.mediaType||record.mediaType},{existing:record.existing});
 };
 return Object.freeze({
  config:()=>publicCall(prefix+'config',{}),read,
  async plan(file,limits){
   assertAccount();if(!limits?.supported)throw error('attachment_service_unavailable');
   if(!file.size||file.size>Math.min(limits.maxFileBytes,33554432))throw error('attachment_too_large');
   const bytes=await guard(()=>file.arrayBuffer()),sha256=await guard(()=>forumAttachmentDigest(bytes));
   return forumDraftAttachmentSchema.parse({id:crypto.randomUUID(),name:file.name,mediaType:(file.type||'application/octet-stream').toLowerCase(),size:file.size,sha256,state:'preparing',existing:false});
  },
  /** @param {z.infer<typeof forumDraftAttachmentSchema>} record @param {File} file @param {{signal?:AbortSignal,onState?:(value:z.infer<typeof forumDraftAttachmentSchema>)=>Promise<void>}} [options] */
  async upload(record,file,{signal,onState=async()=>{}}={}){
   assertAccount();signal?.throwIfAborted();let receipt;
   try{receipt=await read(record.id,{signal});}catch(reason){if(!['attachment_unavailable','not_found'].includes(reason?.code))throw reason;}
   if(!receipt){const input=forumAttachmentPrepareSchema.parse({attachmentId:record.id,name:record.name,mediaType:record.mediaType,size:record.size,sha256:record.sha256});receipt=await call('prepare',input,{signal});}
   let value=matches(record,receipt);await onState(value);
   if(rejected.has(value.state)||['available','scan-pending','scanning'].includes(value.state))return value;
   if(value.state==='uploading'&&!value.uploadRetryable&&(!value.uploadRetryAt||Date.parse(value.uploadRetryAt)>Date.now()))return value;
   const bytes=await guard(()=>file.arrayBuffer());signal?.throwIfAborted();
   if(bytes.byteLength!==record.size||await guard(()=>forumAttachmentDigest(bytes))!==record.sha256)throw error('attachment_file_changed');
   await onState({...value,state:'uploading'});signal?.throwIfAborted();
   if(!account.transfer)throw error('attachment_service_unavailable');
   const response=await guard(()=>account.transfer(prefix+record.id+'/upload',bytes,{method:'PUT',signal}));
   value=matches(record,await guard(()=>response.json()));await onState(value);return value;
  },
  revoke:attachmentId=>call('revoke',{attachmentId:z.uuid().parse(attachmentId)}),
  /** @param {{attachmentId:string,sha256?:string,size?:number,state:string}} item @param {z.infer<typeof forumAttachmentSourceSchema>} source @param {{signal?:AbortSignal}} [options] */
  async download(item,source,{signal}={}){
   const id=z.uuid().parse(item.attachmentId),input={source:forumAttachmentSourceSchema.parse(source)};
   const path=prefix+id+'/content';
   if(account&&!account.transfer)throw error('attachment_service_unavailable');
   const response=account?await guard(()=>account.transfer(path,input,{method:'POST',signal}))
    :await fetcher(endpoint+path,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json',Accept:'application/octet-stream'},body:JSON.stringify(input),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
   if(!response.ok){let value;try{value=await response.json();}catch{}throw error(value?.error?.code??value?.error??'attachment_content_unavailable');}
   const bytes=await guard(()=>response.arrayBuffer());
   if(!item.sha256||!Number.isSafeInteger(item.size)||bytes.byteLength!==item.size||bytes.byteLength>33554432||response.headers.get('X-Galaxy-Content-Sha256')!==item.sha256||await guard(()=>forumAttachmentDigest(bytes))!==item.sha256)throw error('attachment_receipt_mismatch');
   return bytes;
  },
 });
}

export function forumAttachmentError(reason){
 const code=reason?.code??reason?.message;
 return ({attachment_service_unavailable:'暂时不能上传文件。',attachment_too_large:'文件为空或超过单文件大小限制。',attachment_storage_quota_exceeded:'文件空间不足，可以移除不再需要的附件后重试。',attachment_operation_conflict:'这次上传记录已变化，请保留原文件。',attachment_file_changed:'请选择原来的文件继续上传。',attachment_receipt_mismatch:'暂时无法确认文件，请稍后重试。',attachment_upload_in_progress:'正在确认原上传。',attachment_upload_capacity:'上传繁忙，稍后会继续。',attachment_unavailable:'原文件暂时无法读取。',attachment_content_unavailable:'此文件当前无法下载。',attachment_source_unavailable:'原内容已停止提供文件下载。',attachment_reference_unavailable:'有文件尚未就绪，请查看附件状态。',attachment_media_type_mismatch:'文件内容与文件类型不一致。',attachment_file_format_invalid:'暂时无法识别这个文件。',attachment_media_type_unrecognized:'暂不支持这个文件类型。',attachment_digest_mismatch:'文件未完整上传，请选择原文件重试。',official_account_session_expired:'登录后可添加文件，草稿保留。',official_account_changed:'登录账户已变化，请回到原账户继续。',official_account_unavailable:'账户暂时无法连接，草稿保留。'})[code]??(reason?.issues?'请重新选择文件。':'文件暂时无法处理，请稍后重试。');
}
