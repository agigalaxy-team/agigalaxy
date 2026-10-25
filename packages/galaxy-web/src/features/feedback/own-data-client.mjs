import {z} from 'zod/v4';

const uuid=z.uuid(),count=z.number().int().nonnegative(),date=z.string().refine(value=>Number.isFinite(Date.parse(value)));
const receipt=z.object({state:z.literal('recorded'),operationId:uuid,kind:z.enum(['export','delete']),phase:z.enum(['ready','pending','completed','attention']),
 scope:z.literal('own-submitted-feedback-at-selection'),feedbackCount:count,attachmentCount:count,metadataDeleted:z.boolean(),
 attachments:z.object({pending:count,removed:count,resultUnknown:count,objectRemoved:z.boolean().nullable(),physicalBlocksReleased:z.null()}),
 recordedAt:date,updatedAt:date,replayed:z.boolean(),checkedAt:count,readExpiresAt:count});
const absent=z.object({state:z.literal('not-recorded'),operationId:uuid,checkedAt:count,readExpiresAt:count});
const operation=z.discriminatedUnion('state',[receipt,absent]);
const attachment=z.object({id:uuid,name:z.string().max(180),mediaType:z.string().max(120),byteSize:count,sha256:z.string().regex(/^[a-f0-9]{64}$/),
 state:z.string().max(40),availability:z.enum(['available','unavailable']),expiresAt:date.nullable(),contentPath:z.string().nullable()});
const page=z.object({operationId:uuid,accountId:uuid,scope:z.literal('own-submitted-feedback-at-selection'),items:z.array(z.object({id:uuid,state:z.enum(['available','deleted']),
 submittedAt:date,title:z.string().max(120).nullable(),body:z.string().max(6000).nullable(),category:z.enum(['problem','suggestion']).nullable(),
 module:z.enum(['account','community','chat','work','discovery','other']).nullable(),attachments:z.array(attachment).max(4)})).max(50),
 nextAfter:z.string().regex(/^[1-9][0-9]{0,18}$/).nullable(),selectedAt:date,checkedAt:count,readExpiresAt:count});
const error=code=>Object.assign(Error(code),{code});
const prefix='/v1/account/data/feedback';
export const feedbackOwnDataIntentSchema=z.strictObject({accountId:uuid,operationId:uuid,kind:z.enum(['export','delete'])});

// Stored ZIP entries use their required archive checksum. No source fingerprint
// or content is written to an application log or persistence store.
const crcTable=Uint32Array.from({length:256},(_,value)=>{let current=value;for(let bit=0;bit<8;bit++)current=current&1?0xedb88320^(current>>>1):current>>>1;return current>>>0;});
const crc32=bytes=>{let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return(value^0xffffffff)>>>0;};
/** @param {{name:string,bytes:Uint8Array}[]} entries */
export function feedbackOwnDataArchive(entries){
 if(entries.length>65535)throw error('account_feedback_export_too_large');
 const encoder=new TextEncoder(),parts=[],directory=[];let offset=0;
 for(const entry of entries){const name=encoder.encode(entry.name),size=entry.bytes.length,crc=crc32(entry.bytes);
  if(name.length>65535||size>0xffffffff||offset+size+name.length+30>0xffffffff)throw error('account_feedback_export_too_large');
  const local=new Uint8Array(30+name.length),view=new DataView(local.buffer);view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x800,true);
  view.setUint32(14,crc,true);view.setUint32(18,size,true);view.setUint32(22,size,true);view.setUint16(26,name.length,true);local.set(name,30);
  const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);
  cv.setUint32(16,crc,true);cv.setUint32(20,size,true);cv.setUint32(24,size,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);central.set(name,46);
  parts.push(local,entry.bytes);directory.push(central);offset+=local.length+size;
 }
 const directorySize=directory.reduce((sum,value)=>sum+value.length,0);if(offset+directorySize>0xffffffff)throw error('account_feedback_export_too_large');
 const end=new Uint8Array(22),view=new DataView(end.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(8,entries.length,true);view.setUint16(10,entries.length,true);view.setUint32(12,directorySize,true);view.setUint32(16,offset,true);
 return new Blob([...parts,...directory,end],{type:'application/zip'});
}

/** @param {{accountId:string,call:(path:string,input:unknown,options?:{method?:string,signal?:AbortSignal})=>Promise<any>,transfer:(path:string,input:unknown,options?:{method?:string,signal?:AbortSignal})=>Promise<Response>,assertCurrent:()=>void,now?:()=>number}} options */
export function createFeedbackOwnDataClient({accountId,call,transfer,assertCurrent,now=()=>Math.floor(Date.now()/1000)}){
 uuid.parse(accountId);
 const guard=async fn=>{assertCurrent();try{const result=await fn();assertCurrent();return result;}catch(reason){assertCurrent();throw reason;}};
 const parseOperation=(value,id)=>{const result=operation.parse(value);if(result.operationId!==id||result.readExpiresAt<=now()||result.readExpiresAt<=result.checkedAt)throw error('account_feedback_data_response_invalid');return result;};
 return Object.freeze({
  /** @param {{operationId:string,kind:'export'|'delete'}} intent @param {{signal?:AbortSignal}} [options] */
  async start(intent,{signal}={}){uuid.parse(intent.operationId);return parseOperation(await guard(()=>call(prefix+'/'+intent.kind,{operationId:intent.operationId},{signal})),intent.operationId);},
  /** @param {{operationId:string}} intent @param {{signal?:AbortSignal}} [options] */
  async lookup(intent,{signal}={}){uuid.parse(intent.operationId);return parseOperation(await guard(()=>call(prefix+'/operations/'+intent.operationId,null,{method:'GET',signal})),intent.operationId);},
  /** @param {string} operationId @param {{signal?:AbortSignal,onProgress?:(value:{records:number,attachments:number})=>void}} [options] */
  async exportBundle(operationId,{signal,onProgress=()=>{}}={}){
   uuid.parse(operationId);const records=[],entries=[],cursors=new Set(),ids=new Set();let after,selectedAt=null,files=0;
   for(;;){signal?.throwIfAborted();const value=page.parse(await guard(()=>call(prefix+'/exports/'+operationId+'?'+new URLSearchParams({limit:'50',...(after?{after}:{})}),null,{method:'GET',signal})));
    if(value.accountId!==accountId||value.operationId!==operationId||value.readExpiresAt<=now())throw error('account_feedback_data_response_invalid');
    selectedAt??=value.selectedAt;if(selectedAt!==value.selectedAt)throw error('account_feedback_data_response_invalid');
    for(const item of value.items){if(ids.has(item.id))throw error('account_feedback_data_response_invalid');ids.add(item.id);const saved={...item,attachments:[]};
     for(const file of item.attachments){const exported={...file,contentPath:undefined,archivePath:null};
      if(file.availability==='available'){
       const expected=prefix+'/exports/'+operationId+'/attachments/'+file.id+'/content';if(file.contentPath!==expected)throw error('account_feedback_data_response_invalid');
       try{const response=await guard(()=>transfer(expected,{}, {signal})),bytes=new Uint8Array(await guard(()=>response.arrayBuffer()));signal?.throwIfAborted();
        if(bytes.length!==file.byteSize)throw error('attachment_storage_integrity_failed');
        const digest=Array.from(new Uint8Array(await guard(()=>crypto.subtle.digest('SHA-256',bytes))),value=>value.toString(16).padStart(2,'0')).join('');
        if(digest!==file.sha256)throw error('attachment_storage_integrity_failed');
        const safeName=file.name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'_').replace(/^\.+/,'_')||'附件';
        exported.archivePath='attachments/'+item.id+'/'+file.id+'-'+safeName;entries.push({name:exported.archivePath,bytes});files++;
       }catch(reason){if([404,409,410].includes(reason?.status)){exported.availability='unavailable';exported.state='unavailable';}else throw reason;}
      }
      saved.attachments.push(exported);
     }
     records.push(saved);onProgress({records:records.length,attachments:files});
    }
    if(!value.nextAfter)break;if(value.nextAfter===after||cursors.has(value.nextAfter))throw error('account_feedback_data_response_invalid');cursors.add(value.nextAfter);after=value.nextAfter;
   }
   assertCurrent();signal?.throwIfAborted();entries.unshift({name:'feedback.json',bytes:new TextEncoder().encode(JSON.stringify({format:'galaxy-own-feedback/1',accountId,selectedAt,exportedAt:new Date(now()*1000).toISOString(),records},null,2))});
   return {blob:feedbackOwnDataArchive(entries),records:records.length,attachments:files,unavailableAttachments:records.reduce((sum,value)=>sum+value.attachments.filter(file=>!file.archivePath).length,0)};
  }
 });
}

export function feedbackOwnDataError(reason){return ({official_account_session_expired:'登录已到期，请重新登录后继续。',official_account_changed:'登录账户已变化，原操作仍属于原账户。',account_csrf_invalid:'请重新连接账户后继续。',official_account_unavailable:'账户暂时无法连接，联网后继续。',account_feedback_operation_conflict:'这次操作未能继续，请重新开始。',account_feedback_export_too_large:'资料超过浏览器单份压缩文件的大小限制，本次未导出。',attachment_storage_integrity_failed:'有附件未完整读取，本次未导出。',account_feedback_data_response_invalid:'资料暂时无法完整读取，稍后自动重试。'})[reason?.code]??'暂时无法连接，恢复后继续。';}
