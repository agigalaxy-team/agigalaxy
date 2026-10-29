import * as z from 'zod/v4';
import {feedbackAttachmentPrepareSchema,feedbackAttachmentTargetSchema} from '../../../../galaxy-contracts/src/feedback-attachments-v1-schema.mjs';

const states=['preparing','prepared','uploading','unconfirmed','scan-pending','scanning','available','blocked','erased','revoked','expired','unavailable'];
const timestamp=z.string().refine(value=>Number.isFinite(Date.parse(value)));
export const feedbackDraftAttachmentSchema=feedbackAttachmentPrepareSchema.omit({attachmentId:true}).extend({id:z.uuid(),state:z.enum(states),
 expiresAt:timestamp.nullable().optional(),uploadRetryAt:timestamp.nullable().optional(),uploadRetryable:z.boolean().optional()});
export const feedbackDraftAttachmentsSchema=z.array(feedbackDraftAttachmentSchema).max(4).refine(values=>new Set(values.map(value=>value.id)).size===values.length);
export const feedbackAttachmentSpecificationSchema=z.object({supported:z.boolean(),maxFileBytes:z.number().int().min(1).max(67108864),maxFilesPerFeedback:z.number().int().min(1).max(4),
 draftRetentionDays:z.number().int().positive(),submittedRetentionDays:z.number().int().positive(),publicStorageUrls:z.literal(false),automaticPhysicalCleanup:z.literal(false)});
export const feedbackAttachmentDigest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
const error=code=>Object.assign(new Error(code),{code});
const terminal=new Set(['blocked','erased','revoked','expired','unavailable']);
const receiptSchema=z.object({attachmentId:z.uuid(),operationId:z.uuid(),name:z.string().max(180),mediaType:z.string().max(120),size:z.number().int().positive().max(67108864),
 sha256:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(states),expiresAt:timestamp,uploadRetryAt:timestamp.nullable(),uploadRetryable:z.boolean()});

/** @param {{account:{assertCurrent:()=>void,call:(path:string,input:unknown,options?:{signal?:AbortSignal})=>Promise<any>,transfer:(path:string,input:unknown,options?:{method?:string,signal?:AbortSignal})=>Promise<Response>}}} options */
export function createFeedbackAttachmentsClient({account}){
 const prefix='/v1/account/feedback/attachments/';
 const guard=async action=>{account.assertCurrent();try{const value=await action();account.assertCurrent();return value;}catch(reason){account.assertCurrent();throw reason;}};
 const call=(name,input,options={})=>guard(()=>account.call(prefix+name,input,options));
 const match=(record,input)=>{const value=receiptSchema.parse(input);
  if(value.attachmentId!==record.id||value.operationId!==record.operationId||value.name!==record.name||value.mediaType!==record.mediaType||value.size!==record.size||value.sha256!==record.sha256)throw error('attachment_receipt_mismatch');
  return feedbackDraftAttachmentSchema.parse({...record,state:value.state,expiresAt:value.expiresAt,uploadRetryAt:value.uploadRetryAt,uploadRetryable:value.uploadRetryable});};
 const target=record=>feedbackAttachmentTargetSchema.parse({attachmentId:record.id,operationId:record.operationId});
 return Object.freeze({
  async config(){return feedbackAttachmentSpecificationSchema.parse(await call('config',{}));},
  async plan(file,operationId,limits){account.assertCurrent();if(!limits?.supported)throw error('attachment_service_unavailable');
   if(!file.size||file.size>limits.maxFileBytes)throw error('attachment_too_large');
   const bytes=await guard(()=>file.arrayBuffer()),sha256=await guard(()=>feedbackAttachmentDigest(bytes));
   return feedbackDraftAttachmentSchema.parse({id:crypto.randomUUID(),operationId,name:file.name,mediaType:(file.type||'application/octet-stream').toLowerCase(),size:file.size,sha256,state:'preparing'});
  },
  async read(record,{signal}={}){return match(record,await call('read',target(record),{signal}));},
  /** @param {z.infer<typeof feedbackDraftAttachmentSchema>} record @param {File} file @param {{signal?:AbortSignal,onState?:(value:z.infer<typeof feedbackDraftAttachmentSchema>)=>Promise<void>}} [options] */
  async upload(record,file,{signal,onState=async()=>{}}={}){account.assertCurrent();signal?.throwIfAborted();let receipt;
   try{receipt=await call('read',target(record),{signal});}catch(reason){if(!['feedback_attachment_unavailable','not_found'].includes(reason?.code))throw reason;}
   if(!receipt)receipt=await call('prepare',feedbackAttachmentPrepareSchema.parse({...target(record),name:record.name,mediaType:record.mediaType,size:record.size,sha256:record.sha256}),{signal});
   let value=match(record,receipt);await onState(value);
   if(terminal.has(value.state)||['available','scan-pending','scanning'].includes(value.state))return value;
   if(value.state==='uploading'&&!value.uploadRetryable)return value;
   const bytes=await guard(()=>file.arrayBuffer());signal?.throwIfAborted();
   if(bytes.byteLength!==record.size||file.name!==record.name||await guard(()=>feedbackAttachmentDigest(bytes))!==record.sha256)throw error('attachment_file_changed');
   await onState({...value,state:'uploading'});
   const response=await guard(()=>account.transfer(prefix+record.id+'/upload',bytes,{method:'PUT',signal}));
   value=match(record,await guard(()=>response.json()));await onState(value);return value;
  },
  async revoke(record){return match(record,await call('revoke',target(record)));},
 });
}

export function feedbackAttachmentError(reason){const code=reason?.code??reason?.message;
 return ({attachment_service_unavailable:'暂时不能添加附件，可继续提交文字反馈。',attachment_too_large:'文件为空或超过单文件大小限制。',feedback_attachment_count_exceeded:'附件数量已达上限。',attachment_storage_quota_exceeded:'附件存储空间不足，请移除不再需要的待提交文件后重试。',
  attachment_file_changed:'请选择原来的文件继续上传。',attachment_receipt_mismatch:'暂时无法确认附件，请保留原文件后重试。',attachment_operation_conflict:'原上传信息已变化，请移除此附件后重新添加。',attachment_upload_in_progress:'原上传仍在确认中，请稍后刷新附件状态。',attachment_upload_capacity:'当前上传较多，请稍后重试。',
  feedback_attachment_unavailable:'此待提交附件已不可用，请移除后重新添加。',feedback_attachment_draft_closed:'原反馈已提交，请先确认提交结果。',feedback_attachment_not_ready:'有附件尚未完成扫描，请查看附件状态后再提交。',attachment_digest_mismatch:'附件未完整上传，请选择原文件重试。',attachment_media_type_mismatch:'文件内容与类型不一致，请检查原文件。',attachment_media_type_unrecognized:'暂不能识别这个文件类型。',attachment_file_format_invalid:'暂不能识别这个文件。',
  official_account_session_expired:'登录已过期，内容已保留。请重新登录。',official_account_changed:'账户已变化，原附件保留在原账户草稿。',account_csrf_invalid:'登录状态已更新，请刷新账户后重试。'})[code]??'附件暂时无法处理，请保留原文件后重试。';
}
