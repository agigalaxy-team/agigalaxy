import {lstat,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {isAbsolute,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {smtpConfigurationSchema} from '../../shared/operations-smtp-schema.mjs';
import {systemSettingsMailConnectionSchema} from './schema.mjs';
import {operationsSmtpCredentialAlias} from './smtp-credentials.mjs';

export const operationsMailReceiptFiles=Object.freeze({api:'/var/log/galaxy/pilot/api/operations-mail-adopted.json',worker:'/var/log/galaxy/pilot/worker/operations-mail-adopted.json'});
export const operationsMailMetadataSchema=z.strictObject({version:z.literal(1),versionId:z.uuid(),connection:systemSettingsMailConnectionSchema});
export const operationsMailReceiptSchema=z.strictObject({version:z.literal(1),versionId:z.uuid(),component:z.enum(['api','worker']),pid:z.number().int().positive(),
 checkedAt:z.number().int().nonnegative(),configurationVersion:z.number().int().nonnegative(),configuration:smtpConfigurationSchema,
 credentialConfigured:z.boolean(),credentialFile:z.string().min(1)});
export function operationsMailConfiguration(connection){
 const {id:_id,name:_name,credentialRef,...transport}=connection;
 return smtpConfigurationSchema.parse({enabled:true,...transport,credentialRef:operationsSmtpCredentialAlias(credentialRef)});
}
async function writeReceipt(file,value){
 const parent=await lstat(dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink())throw Error();
 try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||process.platform!=='win32'&&(s.uid!==process.getuid()||(s.mode&0o077)))throw Error();}catch(error){if(error.code!=='ENOENT')throw error;}
 const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(temp,file);}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
/** Call after constructing the real SMTP consumer, with its actual injected
 * credential path. A submitted configuration is never a consumer receipt. */
export async function reportOperationsMailAdoption(metadataFile,{component,smtp,credentialFile,pid=process.pid,now=()=>Math.floor(Date.now()/1000)},{write=writeReceipt}={}){
 if(!metadataFile)return{state:'not-configured'};
 try{
  if(!isAbsolute(metadataFile)||!isAbsolute(credentialFile)||!operationsMailReceiptFiles[component]||!smtp)throw Error();
  const info=await lstat(metadataFile);if(!info.isFile()||info.isSymbolicLink()||info.size>32768||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o022)))throw Error();
  const metadata=operationsMailMetadataSchema.parse(JSON.parse(await readFile(metadataFile,'utf8'))),current=await smtp.current(),status=await smtp.status(current);
  const receipt=operationsMailReceiptSchema.parse({version:1,versionId:metadata.versionId,component,pid,checkedAt:now(),configurationVersion:current.version,
   configuration:current.configuration,credentialConfigured:status.credentialAvailable===true,credentialFile});
  if(!isDeepStrictEqual(receipt.configuration,operationsMailConfiguration(metadata.connection))||!receipt.credentialConfigured)throw Error();
  await write(operationsMailReceiptFiles[component],receipt);return{state:'recorded',versionId:metadata.versionId};
 }catch{return{state:'unavailable',code:'system_settings_adoption_unconfirmed'};}
}
