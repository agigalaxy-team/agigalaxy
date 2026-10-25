import {lstatSync,readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createSmtpCredentialResolver} from '../../infrastructure/operations-smtp-credentials.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

// The existing SMTP service intentionally has a synchronous resolve contract.
// Reload only this protected, explicitly injected file; request input never
// chooses a path. Atomic host writes become visible without caching old keys.
export function createRefreshingSmtpCredentialResolver(path,{endpoint}={}){
 if(typeof path!=='string'||!isAbsolute(path))throw new ServiceError('system_settings_private_configuration_invalid',503);
 const load=()=>{
  try{
   const info=lstatSync(path);
   if(!info.isFile()||info.isSymbolicLink()||info.size>65536||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o007)))throw Error();
   const value=JSON.parse(readFileSync(path,'utf8'));
   if(!value||value.version!==1||value.endpoint!==endpoint||!Array.isArray(value.credentials)||value.credentials.length>32||Object.keys(value).some(key=>!['version','endpoint','credentials'].includes(key)))throw Error();
   return createSmtpCredentialResolver(value.credentials);
  }catch{throw new ServiceError('system_settings_private_configuration_invalid',503);}
 };
 load();return Object.freeze({list:()=>load().list(),resolve:binding=>load().resolve(binding)});
}
export const operationsSmtpCredentialAlias=reference=>{
 if(!/^system-key:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reference??''))throw new ServiceError('system_settings_credential_unavailable',409);
 return reference.replace(':','-');
};
