import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {createHash} from 'node:crypto';
import {ServiceError} from '../shared/service-error.mjs';
export class AttachmentS3Store {
 constructor({endpoint,bucket,region='garage',credentials,sseKeyId,sseKey,timeoutMs=15000,maxBytes=10485760}){
  const url=new URL(endpoint);
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('Private S3 endpoint or loopback required');
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||typeof sseKeyId!=='string'||!/^[a-zA-Z0-9._-]{1,80}$/.test(sseKeyId)||!Buffer.isBuffer(sseKey)||sseKey.length!==32)throw new Error('Invalid attachment storage configuration');
  if(!credentials?.accessKeyId||!credentials.secretAccessKey)throw new Error('Explicit attachment storage credentials required');
  Object.assign(this,{bucket,keyId:sseKeyId,timeoutMs,maxBytes});
  this.encryption={SSECustomerAlgorithm:'AES256',SSECustomerKey:sseKey.toString('base64'),SSECustomerKeyMD5:createHash('md5').update(sseKey).digest('base64')};
  this.client=new S3Client({endpoint:url.origin,region,forcePathStyle:true,credentials,maxAttempts:1,
   requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
 }
 key(key){if(!/^(attachments|forum-attachments|outcome-materials|feedback-attachments)\/[0-9a-f-]{36}$/.test(key))throw new ServiceError('attachment_storage_key_invalid',500);return key;}
 async request(Command,input){try{return await this.client.send(new Command({Bucket:this.bucket,...input}),{abortSignal:AbortSignal.timeout(this.timeoutMs)});}
  catch(e){if(e?.name==='NoSuchKey'||e?.$metadata?.httpStatusCode===404)return null;throw new ServiceError('attachment_storage_unavailable',503);}}
 async put({key,bytes,sha256}){if(bytes.length>this.maxBytes)throw new ServiceError('attachment_too_large',413);
  await this.request(PutObjectCommand,{Key:this.key(key),Body:bytes,ContentLength:bytes.length,ContentType:'application/octet-stream',Metadata:{sha256},...this.encryption});
  return {stored:true,keyId:this.keyId};}
 async get({key,keyId,size}){if(keyId!==this.keyId)throw new ServiceError('attachment_encryption_key_unavailable',503);
  const out=await this.request(GetObjectCommand,{Key:this.key(key),...this.encryption});if(!out)return null;
  if(out.ContentLength!==size||size>this.maxBytes){out.Body?.destroy?.();throw new ServiceError('attachment_storage_integrity_failed',502);}
  const chunks=[];let bytes=0;try{for await(const chunk of out.Body){bytes+=chunk.length;if(bytes>size)throw new Error();chunks.push(chunk);}}
  catch{out.Body?.destroy?.();throw new ServiceError('attachment_storage_unavailable',503);}
  if(bytes!==size)throw new ServiceError('attachment_storage_integrity_failed',502);return Buffer.concat(chunks);
 }
 async head({key,keyId}){if(keyId!==this.keyId)throw new ServiceError('attachment_encryption_key_unavailable',503);
  const out=await this.request(HeadObjectCommand,{Key:this.key(key),...this.encryption});return out?{size:out.ContentLength,sha256:out.Metadata?.sha256??null}:null;}
 async erase({key}){await this.request(DeleteObjectCommand,{Key:this.key(key)});return {objectRemoved:true,physicalBlockErasure:'storage-garbage-collection'};}
 close(){this.client.destroy();}
}
