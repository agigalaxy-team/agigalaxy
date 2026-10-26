import {ServiceError} from "../../shared/service-error.mjs";

const subject=value=>typeof value==='string'&&value!=='.'&&value!=='..'&&/^[A-Za-z0-9._:@-]{1,255}$/.test(value);
const email=value=>typeof value==='string'&&value.length<=320&&/^[^\s@<>]+@[^\s@<>]+$/.test(value)?value:null;
const fail=(code='registered_identity_unavailable',status=503)=>{throw new ServiceError(code,status);};
const at=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?new Date(value).toISOString():null;

// Dedicated website-realm management adapter. Read and management credentials
// are separate; no existing readonly directory or mail-worker client gains writes.
export function createKeycloakWebsiteDirectory({issuer,reader,writer=null,adminOrigin,fetch:transport=globalThis.fetch,
 now=()=>Math.floor(Date.now()/1000),allowLoopbackHttp=false}){
 const authority=new URL(issuer),realm=/^(.*)\/realms\/([A-Za-z0-9._-]{1,128})\/?$/.exec(authority.pathname);
 const secure=(url,privateOrigin=false)=>!url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||(privateOrigin||allowLoopbackHttp)&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname));
 const origin=new URL(adminOrigin??authority.origin);
 const validCredential=value=>value&&typeof value.clientId==='string'&&value.clientId.length>0&&typeof value.clientSecret==='string'&&value.clientSecret.length>0;
 if(!realm||!secure(authority)||!secure(origin,true)||origin.origin!==(adminOrigin??authority.origin)||!validCredential(reader)||writer!==null&&(!validCredential(writer)||writer.clientId===reader.clientId))throw Error('Invalid website directory configuration.');
 const base=origin.origin+realm[1]+'/admin/realms/'+encodeURIComponent(realm[2])+'/';
 const tokenUrl=issuer.replace(/\/$/,'')+'/protocol/openid-connect/token',tokens=new Map();
 async function json(response){
  const chunks=[];let size=0;const reader=response.body?.getReader();if(reader)try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>1048576){await reader.cancel();fail();}chunks.push(x.value);}}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('registered_identity_response_invalid');}
 }
 async function token(kind){
  const credential=kind==='write'?writer:reader;if(!credential)fail('registered_identity_management_not_configured');
  const old=tokens.get(kind);if(old?.until>now())return old.value;
  let response;try{response=await transport(tokenUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:credential.clientId,client_secret:credential.clientSecret}).toString()});}catch{fail();}
  if(!response.ok)fail('registered_identity_client_unavailable');const data=await json(response);
  if(typeof data?.access_token!=='string'||data.access_token.length>32768||!Number.isFinite(data.expires_in)||data.expires_in<=10)fail();
  tokens.set(kind,{value:data.access_token,until:now()+Math.min(data.expires_in-5,300)});return data.access_token;
 }
 async function read(path,{optional=false,credential='read'}={}){
  for(let attempt=0;attempt<2;attempt++){
   let response;try{response=await transport(base+path,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{authorization:'Bearer '+await token(credential),accept:'application/json'}});}catch(error){if(error instanceof ServiceError)throw error;fail();}
   if(response.status===401&&!attempt){tokens.delete(credential);continue;}
   if(response.status===404&&optional)return null;if(response.status===403)fail('registered_identity_read_forbidden');if(!response.ok)fail();return json(response);
  }fail();
 }
 const projection=user=>{
  if(!user||!subject(user.id)||typeof user.enabled!=='boolean'||typeof user.emailVerified!=='boolean')fail('registered_identity_response_invalid');
  const displayName=[user.firstName,user.lastName].filter(v=>typeof v==='string'&&v.trim()).join(' ').trim();
  return {issuer,externalSubject:user.id,email:email(user.email),emailVerified:user.emailVerified,enabled:user.enabled,registeredAt:at(user.createdTimestamp),displayName:displayName&&displayName.length<=240?displayName:null,
   serviceAccount:typeof user.serviceAccountClientId==='string'&&!!user.serviceAccountClientId,federated:typeof user.federationLink==='string'&&!!user.federationLink,
   local:!user.id.startsWith('f:'),requiredActions:Array.isArray(user.requiredActions)?user.requiredActions.filter(v=>['VERIFY_EMAIL','UPDATE_PASSWORD','UPDATE_PROFILE','CONFIGURE_TOTP'].includes(v)):[],
   managementAllowed:user.access?.manage===true};
 };
 const target=principal=>{if(principal?.issuer!==issuer||!subject(principal.externalSubject))fail('registered_identity_target_invalid',400);return 'users/'+encodeURIComponent(principal.externalSubject);};
 async function write(principal,suffix,method,body,{authorize}={}){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable');const path=target(principal),access=await token('write');await authorize();
  // A write is attempted once. A lost ACK is not retried, especially action-email.
  let response;try{response=await transport(base+path+suffix,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+access,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{return {state:'unknown',code:'registered_identity_submission_unknown'};}
  if(response.status===204)return {state:'confirmed',code:null};
  return {state:'failed',code:response.status===403?'registered_identity_write_forbidden':response.status===401?'registered_identity_client_unavailable':response.status===404?'registered_identity_not_found':response.status===409?'registered_identity_changed':'registered_identity_write_failed'};
 }
 return Object.freeze({issuer,managementConfigured:writer!==null,
  async count(){const value=await read('users/count');if(!Number.isSafeInteger(value)||value<0)fail('registered_identity_response_invalid');return value;},
  async page({first=0,max=100}={}){if(!Number.isSafeInteger(first)||first<0||!Number.isSafeInteger(max)||max<1||max>100)fail('invalid_registered_users_request',400);
   const values=await read('users?'+new URLSearchParams({first:String(first),max:String(max),briefRepresentation:'false'}));if(!Array.isArray(values)||values.length>max)fail('registered_identity_response_invalid');
   // Keep rawCount: filtering a machine user must not terminate native pagination.
   return {rawCount:values.length,items:values.map(projection).filter(value=>!value.serviceAccount)};},
  async get(principal){const user=await read(target(principal),{optional:true});if(!user)return null;const value=projection(user);if(value.externalSubject!==principal.externalSubject)fail('registered_identity_response_invalid');return value.serviceAccount?null:value;},
  async management(principal){if(!writer)return {state:'not-configured'};try{const user=await read(target(principal),{credential:'write',optional:true});return {state:user&&projection(user).managementAllowed?'available':'forbidden'};}catch(error){return {state:error?.code==='registered_identity_read_forbidden'?'forbidden':'unavailable'};}},
  async registrationEvidence(principal){
   const [credentials,identities]=await Promise.all([read(target(principal)+'/credentials'),read(target(principal)+'/federated-identity')]);
   if(!Array.isArray(credentials)||!Array.isArray(identities)||credentials.length>1000||identities.length>1000)fail('registered_identity_response_invalid');
   // Credential IDs, credentialData/secretData, names and provider tokens never escape.
   return {hasCredentials:credentials.length>0,hasFederatedIdentities:identities.length>0};
  },
  async sessionSummary(principal){const sessions=await read(target(principal)+'/sessions');if(!Array.isArray(sessions)||sessions.length>10000)fail('registered_identity_response_invalid');return {state:'available',activeCount:sessions.length,scope:'keycloak-user-sso'};},
  setEnabled:(principal,enabled,options)=>{if(typeof enabled!=='boolean')fail('invalid_registered_users_request',400);return write(principal,'','PUT',{enabled},options);},
  logout:(principal,options)=>write(principal,'/logout','POST',undefined,options),
  resetLink:async(principal,options)=>{const result=await write(principal,'/execute-actions-email','PUT',['UPDATE_PASSWORD'],options);return result.state==='confirmed'?{state:'submitted',code:null}:result;},
 });
}
