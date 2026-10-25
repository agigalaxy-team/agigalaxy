import {readFile,lstat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import * as z from 'zod/v4';
import {AttachmentS3Store} from './attachment-s3-store.mjs';
import {AttachmentClamAV} from './attachment-clamav.mjs';
import {attachmentPolicySchema} from '../shared/chat-attachments-schema.mjs';
import {feedbackAttachmentPolicySchema,defaultFeedbackAttachmentPolicy} from '../shared/feedback-attachments-v1-schema.mjs';
const schema=z.strictObject({version:z.literal(1),store:z.strictObject({
 endpoint:z.url(),bucket:z.string(),region:z.string().default('garage'),credentials:z.strictObject({accessKeyId:z.string().min(1),secretAccessKey:z.string().min(1)}),
 sseKeyId:z.string(),sseKeyBase64:z.string().regex(/^[A-Za-z0-9+/]{43}=$/)}),
 scanner:z.strictObject({host:z.enum(['127.0.0.1','::1','localhost']).default('127.0.0.1'),port:z.number().int().min(1).max(65535),
 timeoutMs:z.number().int().min(1000).max(60000),maxSignatureAgeSeconds:z.number().int().min(3600).max(259200)}),policy:attachmentPolicySchema,
 feedbackPolicy:feedbackAttachmentPolicySchema.default(defaultFeedbackAttachmentPolicy)});
// Only an explicit path or systemd's protected credential directory activates
// storage. Never discover credentials from home directories or archived files.
export async function loadAttachmentConfiguration(env=process.env){
 const file=env.GALAXY_ATTACHMENTS_CONFIG_FILE??(env.CREDENTIALS_DIRECTORY?join(env.CREDENTIALS_DIRECTORY,'galaxy-attachments.json'):null);
 if(!file)return null;
 try{if(!isAbsolute(file))throw new Error();const info=await lstat(file);if(!info.isFile()||info.size>16384)throw new Error();
  if(process.platform!=='win32'){
   if(!env.GALAXY_ATTACHMENTS_CONFIG_FILE&&env.CREDENTIALS_DIRECTORY){
    // systemd LoadCredential supplies 0440 files in a protected 0550
    // per-unit directory. This exception never applies to an explicit file.
    const directory=await lstat(env.CREDENTIALS_DIRECTORY),uid=process.getuid();
    if(!directory.isDirectory()||(directory.mode&0o227)||(info.mode&0o337)
      ||![0,uid].includes(directory.uid)||![0,uid].includes(info.uid))throw new Error();
   }else if(info.mode&0o077)throw new Error();
  }
  const x=schema.parse(JSON.parse(await readFile(file,'utf8')));
  if(x.policy.maxSubjectBytes<x.policy.maxFileBytes||x.policy.maxGlobalBytes<x.policy.maxSubjectBytes)throw new Error();
  return {store:new AttachmentS3Store({...x.store,sseKey:Buffer.from(x.store.sseKeyBase64,'base64'),maxBytes:x.policy.maxFileBytes}),
   scanner:new AttachmentClamAV({...x.scanner,maxBytes:x.policy.maxFileBytes}),policy:x.policy,feedbackPolicy:x.feedbackPolicy};
 }catch(error){if(!env.GALAXY_ATTACHMENTS_CONFIG_FILE&&error?.code==='ENOENT')return null;throw new Error('Invalid private attachment configuration');}
}
