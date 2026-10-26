import {ServiceError} from './shared/service-error.mjs';

const validSubject=value=>typeof value==='string'&&value!=='.'&&value!=='..'&&/^[A-Za-z0-9._:@-]{1,255}$/.test(value);
const invalid=(code='management_identity_unavailable',status=503)=>{throw new ServiceError(code,status);};
const text=(v,max)=>typeof v==='string'&&v.length<=max?v:'';
const date=v=>Number.isSafeInteger(v)&&v>=0?new Date(v).toISOString():null;
async function limited(values,read){const result=Array.from({length:values.length});let cursor=0;await Promise.all(Array.from({length:Math.min(4,values.length)},async()=>{for(;;){const i=cursor++;if(i>=values.length)return;result[i]=await read(values[i]);}}));return result;}

// Management realm only. Reader/writer are distinct protected service clients;
// no browser credential, email match or native administrator role grants root.
export function createKeycloakManagementAccounts({issuer,reader,writer=null,adminOrigin,
 roleNames={administrator:'galaxy-operations-administrator',reader:'galaxy-operations-reader'},emailChanges=null,
 fetch:transport=globalThis.fetch,now=()=>Math.floor(Date.now()/1000)}){
 const authority=new URL(issuer),realm=/^(.*)\/realms\/([A-Za-z0-9._-]{1,128})\/?$/.exec(authority.pathname),origin=new URL(adminOrigin??authority.origin);
 const secure=(u,privateOrigin=false)=>!u.username&&!u.password&&!u.search&&!u.hash&&(u.protocol==='https:'||privateOrigin&&u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname));
 const credential=v=>v&&typeof v.clientId==='string'&&!!v.clientId&&typeof v.clientSecret==='string'&&!!v.clientSecret;
 if(!realm||!secure(authority)||!secure(origin,true)||origin.origin!==(adminOrigin??authority.origin)||!credential(reader)||writer!==null&&(!credential(writer)||writer.clientId===reader.clientId)
  ||!['administrator','reader'].every(k=>typeof roleNames[k]==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(roleNames[k])))throw Error('Invalid management accounts configuration.');
 const base=origin.origin+realm[1]+'/admin/realms/'+encodeURIComponent(realm[2])+'/',tokenUrl=issuer.replace(/\/$/,'')+'/protocol/openid-connect/token',tokens=new Map();
 async function json(response){const chunks=[];let size=0;const stream=response.body?.getReader();if(stream)try{for(;;){const x=await stream.read();if(x.done)break;size+=x.value.byteLength;if(size>1048576){await stream.cancel();invalid('management_identity_response_invalid');}chunks.push(x.value);}}finally{stream.releaseLock();}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{invalid('management_identity_response_invalid');}}
 async function token(kind){const c=kind==='write'?writer:reader;if(!c)invalid('management_writer_not_configured');const old=tokens.get(kind);if(old?.until>now())return old.value;
  let response;try{response=await transport(tokenUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:c.clientId,client_secret:c.clientSecret}).toString()});}catch{invalid('management_identity_client_unavailable');}
  if(!response.ok)invalid('management_identity_client_unavailable');const data=await json(response);
  if(typeof data?.access_token!=='string'||data.access_token.length>32768||!Number.isFinite(data.expires_in)||data.expires_in<=10)invalid('management_identity_response_invalid');
  tokens.set(kind,{value:data.access_token,until:now()+Math.min(data.expires_in-5,300)});return data.access_token;}
 async function read(path,{optional=false,kind='read'}={}){for(let i=0;i<2;i++){let r;try{r=await transport(base+path,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{authorization:'Bearer '+await token(kind),accept:'application/json'}});}catch(error){if(error instanceof ServiceError)throw error;invalid();}
  if(r.status===401&&!i){tokens.delete(kind);continue;}if(r.status===404&&optional)return null;if(r.status===403)invalid('management_identity_read_forbidden');if(!r.ok)invalid();return json(r);}invalid();}
 const target=principal=>{if(principal?.issuer!==issuer||!validSubject(principal.externalSubject))invalid('management_identity_not_found',404);return 'users/'+encodeURIComponent(principal.externalSubject);};
 async function write(path,method,body,{authorize}={}){if(typeof authorize!=='function')invalid('operations_authorization_unavailable');const access=await token('write');await authorize();let response;
  try{response=await transport(base+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+access,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{return {state:'unknown',code:'management_identity_submission_unknown'};}
  if(response.status===204)return {state:'confirmed',code:null};
  if(response.status===201)return {state:'confirmed',code:null,location:response.headers.get('location')};
  return {state:response.status>=500?'unknown':'failed',code:response.status===403?'management_identity_write_forbidden':response.status===401?'management_identity_client_unavailable':
   response.status===404?'management_identity_not_found':response.status===409?'management_username_conflict':response.status===400?'management_password_policy_rejected':response.status>=500?'management_identity_submission_unknown':'management_identity_write_failed'};}
 async function view(user){if(!user||!validSubject(user.id)||typeof user.username!=='string'||typeof user.enabled!=='boolean'||typeof user.emailVerified!=='boolean')invalid('management_identity_response_invalid');
  if(user.serviceAccountClientId)return null;const values=await read(target({issuer,externalSubject:user.id})+'/role-mappings/realm/composite');
  if(!Array.isArray(values)||values.length>4096)invalid('management_identity_response_invalid');const names=values.map(v=>v?.name);
  return {issuer,externalSubject:user.id,username:text(user.username,200),firstName:text(user.firstName,100),lastName:text(user.lastName,100),
   email:typeof user.email==='string'&&user.email.length<=320?user.email:null,emailVerified:user.emailVerified===true,enabled:user.enabled===true,createdAt:date(user.createdTimestamp),
   admission:names.includes(roleNames.administrator)?'administrator':names.includes(roleNames.reader)?'reader':'none',
   requiredActions:Array.isArray(user.requiredActions)?user.requiredActions.filter(v=>['UPDATE_PASSWORD','UPDATE_PROFILE','VERIFY_EMAIL','UPDATE_EMAIL','CONFIGURE_TOTP'].includes(v)):[]};}
 const emailChangeConfigured=!!emailChanges&&typeof emailChanges.available==='function'&&typeof emailChanges.request==='function';
 return Object.freeze({issuer,managementConfigured:writer!==null,emailChangeConfigured,
  async emailChangeAvailability(){if(!emailChangeConfigured)return false;try{return await emailChanges.available()===true;}catch{return false;}},
  async count(){const n=await read('users/count');if(!Number.isSafeInteger(n)||n<0)invalid('management_identity_response_invalid');return n;},
  async page({first=0,max=20}={}){if(!Number.isSafeInteger(first)||first<0||!Number.isSafeInteger(max)||max<1||max>100)invalid('invalid_management_accounts_request',400);
   const rows=await read('users?'+new URLSearchParams({first:String(first),max:String(max),briefRepresentation:'false'}));if(!Array.isArray(rows)||rows.length>max)invalid('management_identity_response_invalid');
   return {rawCount:rows.length,items:(await limited(rows,view)).filter(Boolean)};},
  async get(principal){const row=await read(target(principal),{optional:true});if(!row)return null;if(row.id!==principal.externalSubject)invalid('management_identity_response_invalid');return view(row);},
  async create(input,options){const result=await write('users','POST',{username:input.username,firstName:input.firstName,lastName:input.lastName,enabled:true,
    requiredActions:['UPDATE_PASSWORD'],credentials:[{type:'password',value:input.temporaryPassword,temporary:true}]},options);
   if(result.state!=='confirmed')return result;
   let location;try{location=new URL(result.location,base);}catch{return {state:'unknown',code:'management_identity_response_invalid'};}
   const prefix=realm[1]+'/admin/realms/'+encodeURIComponent(realm[2])+'/users/';
   const sub=location.pathname.startsWith(prefix)?decodeURIComponent(location.pathname.slice(prefix.length)):null;
   if(![origin.origin,authority.origin].includes(location.origin)||location.search||location.hash||!validSubject(sub))return {state:'unknown',code:'management_identity_response_invalid'};
   return {state:'confirmed',code:null,issuer,externalSubject:sub};},
  profile:(principal,fields,options)=>write(target(principal),'PUT',{...(Object.hasOwn(fields,'firstName')?{firstName:fields.firstName}:{}),...(Object.hasOwn(fields,'lastName')?{lastName:fields.lastName}:{})},options),
  setEnabled:(principal,enabled,options)=>write(target(principal),'PUT',{enabled},options),
  resetPassword:(principal,password,options)=>write(target(principal)+'/reset-password','PUT',{type:'password',value:password,temporary:true},options),
  logout:(principal,options)=>write(target(principal)+'/logout','POST',undefined,options),
  remove:(principal,options)=>write(target(principal),'DELETE',undefined,options),
  async admission(principal,admission,options){
   if(!['administrator','reader'].includes(admission))invalid('invalid_management_accounts_request',400);
   const path=target(principal)+'/role-mappings/realm';
   // manage-users can map this user's roles without permission to read the
   // realm's global role definitions. Resolve only the two configured names
   // from this target's assigned and writer-visible available role mappings.
   const assigned=await read(path+'/composite'),available=await read(path+'/available',{kind:'write'});
   if(!Array.isArray(assigned)||!Array.isArray(available)||assigned.length+available.length>8192)invalid('management_identity_response_invalid');
   const fixedRole=name=>{const matches=[...assigned,...available].filter(row=>row?.name===name);
    if(!matches.length||matches.some(row=>!validSubject(row.id)||row.clientRole===true)||new Set(matches.map(row=>row.id)).size!==1)invalid('management_identity_response_invalid');
    return {id:matches[0].id,name};};
   const role=fixedRole(roleNames[admission]),admin=admission==='reader'?fixedRole(roleNames.administrator):null;
   const result=await write(path,'POST',[role],options);if(result.state!=='confirmed'||!admin)return result;
   return write(path,'DELETE',[admin],options);},
  async sessions(principal){const rows=await read(target(principal)+'/sessions');if(!Array.isArray(rows)||rows.length>10000)invalid('management_identity_response_invalid');return {state:'available',activeCount:rows.length,scope:'keycloak-management-sso'};},
  async requestEmailChange(principal,newEmail,options){if(!emailChangeConfigured||await emailChanges.available()!==true)invalid('management_email_verification_not_configured');
   return emailChanges.request({issuer,externalSubject:principal.externalSubject},newEmail,options);}
 });
}

