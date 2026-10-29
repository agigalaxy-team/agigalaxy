import {mkdir,lstat,readFile,writeFile,readdir} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {noSymlinkPath} from '../operations-stack/host.mjs';
import {systemSettingsCredentialSchema,systemSettingsCredentialRefSchema,parseSystemSettings} from '../../../galaxy-contracts/src/operations-system-settings-schema.mjs';

const failure=code=>Object.assign(Error(code),{code});
const refId=reference=>{
 const value=systemSettingsCredentialRefSchema.safeParse(reference);if(!value.success)throw failure('system_settings_credential_unavailable');return reference.slice(11);
};
export function systemSettingsCredentialBinding(section,binding){
 if(section==='mail')return{section,id:binding.id,host:binding.host,port:binding.port,tls:binding.tls};
 return{section,id:binding.id,kind:binding.kind,origin:new URL(binding.url).origin};
}
export class SystemSettingsCredentialStore{
 constructor({root,requiredUid=0,legacy=null}){Object.assign(this,{root,requiredUid,legacy});}
 async initialize(){
  await noSymlinkPath(this.root);await mkdir(this.root,{recursive:true,mode:0o700});
  const info=await lstat(this.root);
  if(!info.isDirectory()||info.isSymbolicLink()||process.platform!=='win32'&&(info.uid!==this.requiredUid||(info.mode&0o077)))throw failure('system_settings_private_configuration_invalid');
 }
 async file(reference){const path=this.root+'/'+refId(reference)+'.json';await noSymlinkPath(path);return path;}
 async provision(input){
  const value=parseSystemSettings(systemSettingsCredentialSchema,input),reference='system-key:'+value.operationId;
  await this.initialize();const file=await this.file(reference);
  const row={version:1,reference,section:value.section,connectionId:value.connectionId,binding:value.binding,credential:value.credential};
  try{await writeFile(file,JSON.stringify(row)+'\n',{flag:'wx',mode:0o600});}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   const old=await this.read(reference);
   if(!isDeepStrictEqual(old,row))throw failure('system_settings_operation_changed');
  }
  return{reference,connectionId:value.connectionId,configured:true};
 }
 async read(reference){
  const file=await this.file(reference);let info;
  try{info=await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>32768||process.platform!=='win32'&&(info.uid!==this.requiredUid||(info.mode&0o077)))throw failure('system_settings_private_configuration_invalid');
  let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch{throw failure('system_settings_private_configuration_invalid');}
  if(value?.version!==1||value.reference!==reference||!['mail','service-connections'].includes(value.section)||!z.uuid().safeParse(value.connectionId).success)
   throw failure('system_settings_private_configuration_invalid');
  // Re-parse the exact persisted target and bundle. Never return a partial or
  // malformed secret merely because a metadata reference happens to match.
  parseSystemSettings(systemSettingsCredentialSchema,{operationId:refId(reference),expectedRevision:0,section:value.section,
   connectionId:value.connectionId,binding:value.binding,credential:value.credential});
  return value;
 }
 async resolve(reference,{section,binding}){
  let row=await this.read(reference);
  if(!row&&this.legacy)row=await this.legacy(reference,{section,binding});
  if(!row)throw failure('system_settings_credential_unavailable');
  if(row.section!==section||row.connectionId!==binding.id||!isDeepStrictEqual(systemSettingsCredentialBinding(section,row.binding),systemSettingsCredentialBinding(section,binding)))
   throw failure('system_settings_credential_binding_mismatch');
  return structuredClone(row.credential);
 }
 async bundle(reference,{section}){
  let row=await this.read(reference);if(!row&&this.legacy)row=await this.legacy(reference,{section});
  if(!row||row.section!==section)throw failure('system_settings_credential_unavailable');
  return{binding:structuredClone(row.binding),credential:structuredClone(row.credential)};
 }
 async metadata(section){
  await this.initialize();const rows=[],files=await readdir(this.root);
  for(const file of files){
   if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}[.]json$/.test(file))continue;
   const row=await this.read('system-key:'+file.slice(0,-5));
   if(row.section===section)rows.push({reference:row.reference,connectionId:row.connectionId,configured:true});
   if(rows.length>100)throw failure('system_settings_private_configuration_invalid');
  }
  return rows;
 }
}
