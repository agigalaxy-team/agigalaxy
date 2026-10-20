import {isAccountChatJsonPath,isAccountBinaryPath,isAccountUploadPath,isAccountBookmarkPath} from '../../galaxy-official/src/shared/account-resource-routes.mjs';
const guid=value=>typeof value==='string'&&/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
const accountId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const accountUid=value=>typeof value==='string'&&/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,16}$/.test(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};

function returnPath(value,website){
 if(typeof value!=='string'||value.length>2048||!value.startsWith('/app')||value.startsWith('//')||value.includes('\\')||Array.from(value).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))return '/app/account';
 try{const url=new URL(value,website);url.searchParams.delete('accountLogin');return url.origin===website&&(url.pathname==='/app'||url.pathname.startsWith('/app/'))?url.pathname+url.search+url.hash:'/app/account';}catch{return '/app/account';}
}

export function createOfficialAccountClient({endpoint,website=globalThis.location?.origin,fetch:fetcher=globalThis.fetch,now=()=>Math.floor(Date.now()/1000)}){
 const origin=new URL(endpoint);
 if(origin.protocol!=='https:'||origin.origin!==endpoint||origin.username||origin.password)fail('official_account_configuration_invalid');
 const websiteOrigin=new URL(website).origin;
  async function request(path,{anonymous=false,signal,...options}={}){
   const timeout=AbortSignal.timeout(10000);
   const response=await fetcher(endpoint+path,{...options,credentials:anonymous?'omit':'include',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:signal?AbortSignal.any([signal,timeout]):timeout,
   headers:{Accept:'application/json',...options.headers}});
  if(Number(response.headers.get('content-length'))>2097152)fail('official_account_response_invalid');
  const text=await response.text();if(new TextEncoder().encode(text).length>2097152)fail('official_account_response_invalid');
  let result;try{result=JSON.parse(text);}catch{fail('official_account_response_invalid');}
  if(!response.ok){const code=typeof result.error==='string'?result.error:result.error?.code;
   throw Object.assign(new Error(code??'official_account_unavailable'),{code:response.status===401?'official_account_session_expired':code??'official_account_unavailable',outcome:'rejected',status:response.status});}
  return result;
 }
 function readSession(value){
  if(value?.galaxyAuthorization!==false)fail('official_account_response_invalid');
  if(value.state==='signed-out')return{state:'signed-out',galaxyAuthorization:false};
  if(value.state!=='signed-in'||!value.account||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now()
   ||typeof value.csrfToken!=='string'||!value.csrfToken||value.csrfToken.length>512
   ||!Array.isArray(value.linkedIds)||value.linkedIds.length>100||value.nextAfter!==null&&!guid(value.nextAfter))fail('official_account_response_invalid');
  const account=value.account;
  if(![account.displayName,account.email].every(item=>item===null||typeof item==='string'&&item.length<=512)||typeof account.emailVerified!=='boolean')fail('official_account_response_invalid');
  const seen=new Set();
  const linkedIds=value.linkedIds.map(item=>{if(!guid(item?.subjectId)||seen.has(item.subjectId)||typeof item.linkedAt!=='string'||!Number.isFinite(Date.parse(item.linkedAt)))fail('official_account_response_invalid');
   seen.add(item.subjectId);return{subjectId:item.subjectId,linkedAt:item.linkedAt};});
  if(account.id!==undefined&&!accountId(account.id))fail('official_account_response_invalid');
  if(account.uid!==undefined&&account.uid!==null&&!accountUid(account.uid))fail('official_account_response_invalid');
  return{state:'signed-in',account:{id:account.id??null,uid:account.uid??null,displayName:account.displayName,email:account.email,emailVerified:account.emailVerified},linkedIds,nextAfter:value.nextAfter,
   expiresAt:value.expiresAt,csrfToken:value.csrfToken,galaxyAuthorization:false};
 }
 return Object.freeze({
   async session({after,signal}={}){if(after!==undefined&&!guid(after))fail('official_account_cursor_invalid');return readSession(await request('/v1/account/session'+(after?'?after='+encodeURIComponent(after):''),{signal}));},
   async publicAccount(id,{signal}={}){if(!accountId(id))fail('official_account_request_invalid');return request('/v1/account/public/'+id,{method:'GET',anonymous:true,signal});},
   async publicAccountByUid(uid,{signal}={}){if(!accountUid(uid))fail('official_account_request_invalid');return request('/v1/account/public/by-uid/'+encodeURIComponent(uid.toUpperCase()),{method:'GET',anonymous:true,signal});},
    /** @param {string} id @param {{after?:string,limit?:number,signal?:AbortSignal}} [page] */
    async publicPosts(id,{after,limit=20,signal}={}){if(!accountId(id)||after!==undefined&&(typeof after!=='string'||after.length>512||!/^fp1\.[A-Za-z0-9_-]+$/.test(after))||!Number.isInteger(limit)||limit<1||limit>50)fail('official_account_request_invalid');return request('/v1/account/public/'+id+'/posts?'+new URLSearchParams({limit:String(limit),...(after?{after}:{})}),{method:'GET',anonymous:true,signal});},
   /** @param {string} id @param {{after?:string,limit?:number,signal?:AbortSignal}} [page] */
   async publicLinkedIds(id,{after,limit=20,signal}={}){if(!accountId(id)||after!==undefined&&!guid(after)||!Number.isInteger(limit)||limit<1||limit>50)fail('official_account_request_invalid');return request('/v1/account/public/'+id+'/ids?'+new URLSearchParams({limit:String(limit),...(after?{after}:{})}),{method:'GET',anonymous:true,signal});},
   /** @param {string} id @param {{after?:string,limit?:number,signal?:AbortSignal}} [page] */
   async publicCredentials(id,{after,limit=20,signal}={}){if(!accountId(id)||after!==undefined&&!accountId(after)||!Number.isInteger(limit)||limit<1||limit>50)fail('official_account_request_invalid');return request('/v1/account/public/'+id+'/credentials?'+new URLSearchParams({limit:String(limit),...(after?{after}:{})}),{method:'GET',anonymous:true,signal});},
   /** @param {string} id @param {{after?:string,limit?:number,signal?:AbortSignal}} [page] */
   async publicAccountsForId(id,{after,limit=20,signal}={}){if(!guid(id)||after!==undefined&&!accountId(after)||!Number.isInteger(limit)||limit<1||limit>50)fail('official_account_request_invalid');return request('/v1/account/public/by-id/'+id+'?'+new URLSearchParams({limit:String(limit),...(after?{after}:{})}),{method:'GET',anonymous:true,signal});},
  loginUrl(mode='login',target='/app/account'){
   if(!['login','register'].includes(mode))fail('official_account_mode_invalid');
   return endpoint+'/v1/account/login?'+new URLSearchParams({mode,returnTo:returnPath(target,websiteOrigin)});
  },
/** @param {string} path @param {unknown} input @param {{method?:string,signal?:AbortSignal,session?:{state:string,account:{id:string|null},csrfToken:string,expiresAt:number}}} [options] */
   async call(path,input,{method='POST',session,signal}={}){
   if(session?.state!=='signed-in'||!accountId(session.account?.id)||typeof session.csrfToken!=='string'||!session.csrfToken||session.expiresAt<=now())fail('official_account_session_expired');
   if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\')||path.includes('#')||!['GET','POST','DELETE'].includes(method))fail('official_account_request_invalid');
   const parsed=new URL(path,endpoint),route=parsed.pathname;
   const allowed=isAccountChatJsonPath(route)||isAccountBookmarkPath(route)||/^\/v2\/community\/[a-z0-9/-]+$/.test(route)||/^\/v1\/account\/(?:settings|type-change|archives(?:\/(?:create|chunk|complete|export|delete|cleanup|status))?|work\/(?:get|list|status|delete))$/.test(route)
    ||/^\/v1\/account\/external-credentials(?:\/[0-9a-f-]{36}(?:\/recheck)?)?$/.test(route);
   const queryKeys=route==='/v1/account/archives'?['after','limit']:route==='/v1/account/external-credentials'?['after']:route==='/v2/community/quotas'?['postId','replyId','sectionId']:[];
   if(parsed.origin!==endpoint||!allowed||[...parsed.searchParams.keys()].some(key=>!queryKeys.includes(key)||parsed.searchParams.getAll(key).length!==1)||parsed.search&&method!=='GET'
    ||method==='DELETE'&&!/^\/v1\/account\/external-credentials\/[0-9a-f-]{36}$/.test(route))fail('official_account_request_invalid');
    return request(path,{method,signal,headers:{'Content-Type':'application/json','X-Galaxy-Account-ID':session.account.id,'X-Galaxy-Account-CSRF':session.csrfToken},...(['GET','DELETE'].includes(method)?{}:{body:JSON.stringify(input??{})})});
  },
  /** @param {string} path @param {unknown} input @param {{method?:string,signal?:AbortSignal,session?:{state:string,account:{id:string|null},csrfToken:string,expiresAt:number}}} [options] @returns {Promise<Response>} */
  async transfer(path,input,{method='POST',session,signal}={}){
   if(session?.state!=='signed-in'||!accountId(session.account?.id)||typeof session.csrfToken!=='string'||!session.csrfToken||session.expiresAt<=now())fail('official_account_session_expired');
   if(typeof path!=='string'||!isAccountBinaryPath(path)||method!==(isAccountUploadPath(path)?'PUT':'POST'))fail('official_account_request_invalid');
   const timeout=AbortSignal.timeout(120000),upload=method==='PUT';
   const response=await fetcher(endpoint+path,{method,credentials:'include',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:signal?AbortSignal.any([signal,timeout]):timeout,
    headers:{Accept:upload?'application/json':'application/octet-stream','Content-Type':upload?'application/octet-stream':'application/json','X-Galaxy-Account-ID':session.account.id,'X-Galaxy-Account-CSRF':session.csrfToken},body:upload?input:JSON.stringify(input??{})});
   if(!response.ok){let value;try{value=await response.json();}catch{}const code=response.status===401?'official_account_session_expired':value?.error?.code??value?.error??'attachment_unavailable';throw Object.assign(Error(code),{code,outcome:'rejected',status:response.status});}
   return response;
  },
  async logout(session){
   if(session?.state!=='signed-in'||typeof session.csrfToken!=='string'||!session.csrfToken||session.expiresAt<=now())fail('official_account_session_expired');
   const result=readSession(await request('/v1/account/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Galaxy-Account-CSRF':session.csrfToken},body:'{}'}));
   if(result.state!=='signed-out')fail('official_account_response_invalid');return result;
  }
 });
}
