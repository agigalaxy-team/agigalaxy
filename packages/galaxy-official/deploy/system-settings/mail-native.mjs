import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {runCommand,noSymlinkPath} from '../operations-stack/host.mjs';

const failure=code=>Object.assign(Error(code),{code});
const realms=new Set(['galaxy','galaxy-operations']);
const masked=value=>typeof value!=='string'||!value||/^\*+$/.test(value)||['__masked__','masked','<secret>'].includes(value.toLowerCase());
export class SystemSettingsKeycloakMail{
 constructor({bootstrapFile,origin='http://127.0.0.1:18080',fetchImpl=fetch,run=runCommand}){
  if(!isAbsolute(bootstrapFile??'')||origin!=='http://127.0.0.1:18080')throw failure('system_settings_control_not_configured');
  Object.assign(this,{bootstrapFile,origin,fetchImpl,run});
 }
 async request(path,{method='GET',body=null,token=null}={}){
  let response;
  try{response=await this.fetchImpl(this.origin+path,{method,redirect:'error',headers:{Accept:'application/json',...(body?{'content-type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}catch{throw failure('system_settings_target_unavailable');}
  if(!response.ok)throw failure('system_settings_target_unavailable');
  if(response.status===204)return null;
  const raw=await response.text();if(Buffer.byteLength(raw)>1048576)throw failure('system_settings_native_response_invalid');
  try{return JSON.parse(raw);}catch{throw failure('system_settings_native_response_invalid');}
 }
 async token(){
  await noSymlinkPath(this.bootstrapFile);const info=await lstat(this.bootstrapFile);
  if(!info.isFile()||info.isSymbolicLink()||info.size>65536||process.platform!=='win32'&&(info.uid!==0||(info.mode&0o077)))throw failure('system_settings_private_configuration_invalid');
  let value;try{value=JSON.parse(await readFile(this.bootstrapFile,'utf8'));}catch{throw failure('system_settings_private_configuration_invalid');}
  if(typeof value.bootstrapUsername!=='string'||!value.bootstrapUsername||typeof value.bootstrapPassword!=='string'||!value.bootstrapPassword)throw failure('system_settings_credential_unavailable');
  let response;try{response=await this.fetchImpl(this.origin+'/realms/master/protocol/openid-connect/token',{method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({client_id:'admin-cli',grant_type:'password',username:value.bootstrapUsername,password:value.bootstrapPassword}),signal:AbortSignal.timeout(10000)});}catch{throw failure('system_settings_target_unavailable');}
  if(!response.ok)throw failure('system_settings_permission_denied');
  let result;try{const raw=await response.text();if(Buffer.byteLength(raw)>65536)throw Error();result=JSON.parse(raw);}catch{throw failure('system_settings_native_response_invalid');}
  if(typeof result.access_token!=='string'||result.access_token.length>32768)throw failure('system_settings_native_response_invalid');return result.access_token;
 }
 async read(realm){
  if(!realms.has(realm))throw failure('system_settings_permission_denied');
  const value=await this.request('/admin/realms/'+realm,{token:await this.token()}),smtp=value?.smtpServer??{};
  if(!smtp||Array.isArray(smtp)||Object.values(smtp).some(value=>typeof value!=='string'))throw failure('system_settings_native_response_invalid');
  if(smtp.auth!=='true'||!masked(smtp.password))return smtp;
  // Native GET masks the password. Read exactly the same realm SMTP mapping;
  // never copy the mask back and never read an account/credential/user table.
  const query="SELECT json_object_agg(name,value) FROM realm_smtp_config WHERE realm_id=(SELECT id FROM realm WHERE name='"+realm+"');";
  const result=await this.run('/usr/bin/docker',['exec','--user','postgres','galaxy-accounts-pilot-database-1','psql','--no-psqlrc','--no-password','--tuples-only','--no-align','--set','ON_ERROR_STOP=1','--host','/var/run/postgresql','--username','galaxy_accounts','--dbname','galaxy_accounts','--command',query],{timeout:15000,maxOutput:65536});
  let full;try{full=JSON.parse(result.stdout);}catch{throw failure('system_settings_credential_unavailable');}
  if(!full||masked(full.password)||Object.values(full).some(value=>typeof value!=='string'))throw failure('system_settings_credential_unavailable');
  for(const[key,value]of Object.entries(smtp))if(key!=='password'&&full[key]!==value)throw failure('system_settings_source_changed');
  return full;
 }
 async apply(realm,smtp){
  if(!realms.has(realm)||!smtp||Object.values(smtp).some(value=>typeof value!=='string')||smtp.auth!=='true'||masked(smtp.password))throw failure('system_settings_configuration_incomplete');
  await this.request('/admin/realms/'+realm,{method:'PUT',body:{smtpServer:smtp},token:await this.token()});
 }
}
