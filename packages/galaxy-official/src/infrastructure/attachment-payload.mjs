import {createHash} from 'node:crypto';
import {fileTypeFromBuffer} from 'file-type';
import {ServiceError} from '../shared/service-error.mjs';

const fail=(code,status=400)=>{throw new ServiceError(code,status);};

/** Shared byte validation; the calling content service owns all permissions. */
export async function readAttachmentPayload(stream,{size,sha256,mediaType,maxFileBytes,onBytes=()=>{}}){
 const iterator=stream[Symbol.asyncIterator](),deadline=Date.now()+60000,chunks=[];
 let length=0;
 async function next(){let timer;try{return await Promise.race([iterator.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ServiceError('attachment_upload_timeout',408)),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}}
 while(true){const part=await next();if(part.done)break;const chunk=Buffer.from(part.value);length+=chunk.length;onBytes(chunk.length);if(length>size||length>maxFileBytes)fail('attachment_too_large',413);chunks.push(chunk);}
 if(length!==size)fail('attachment_size_mismatch');
 const bytes=Buffer.concat(chunks);
 if(createHash('sha256').update(bytes).digest('hex')!==sha256)fail('attachment_digest_mismatch');
 let detected;try{detected=await fileTypeFromBuffer(bytes);}catch{fail('attachment_file_format_invalid');}
 if(mediaType!=='application/octet-stream'){
  if(detected){if(detected.mime!==mediaType)fail('attachment_media_type_mismatch');}
  else if(['text/plain','application/json'].includes(mediaType)){try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw Error();if(mediaType==='application/json')JSON.parse(text);}catch{fail('attachment_media_type_mismatch');}}
  else fail('attachment_media_type_unrecognized');
 }
 return bytes;
}
