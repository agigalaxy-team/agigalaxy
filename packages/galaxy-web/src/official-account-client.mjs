const guid=value=>typeof value==='string'&&/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};

function returnPath(value,website){
 if(typeof value!=='string'||value.length>2048||!value.startsWith('/app')||value.startsWith('//')||value.includes('\\')||Array.from(value).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))return '/app/account';
 try{const url=new URL(value,website);return url.origin===website&&(url.pathname==='/app'||url.pathname.startsWith('/app/'))?url.pathname+url.search+url.hash:'/app/account';}catch{return '/app/account';}
}

export function createOfficialAccountClient({endpoint,website=globalThis.location?.origin,fetch:fetcher=globalThis.fetch,now=()=>Math.floor(Date.now()/1000)}){
 const origin=new URL(endpoint);
 if(origin.protocol!=='https:'||origin.origin!==endpoint||origin.username||origin.password)fail('official_account_configuration_invalid');
 const websiteOrigin=new URL(website).origin;
 async function request(path,options={}){
  const response=await fetcher(endpoint+path,{...options,credentials:'include',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000),
   headers:{Accept:'application/json',...options.headers}});
  if(Number(response.headers.get('content-length'))>131072)fail('official_account_response_invalid');
  const text=await response.text();if(new TextEncoder().encode(text).length>131072)fail('official_account_response_invalid');
  let result;try{result=JSON.parse(text);}catch{fail('official_account_response_invalid');}
  if(!response.ok)fail(response.status===401?'official_account_session_expired':'official_account_unavailable');
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
  return{state:'signed-in',account:{displayName:account.displayName,email:account.email,emailVerified:account.emailVerified},linkedIds,nextAfter:value.nextAfter,
   expiresAt:value.expiresAt,csrfToken:value.csrfToken,galaxyAuthorization:false};
 }
 return Object.freeze({
  async session({after}={}){if(after!==undefined&&!guid(after))fail('official_account_cursor_invalid');return readSession(await request('/v1/account/session'+(after?'?after='+encodeURIComponent(after):'')));},
  loginUrl(mode='login',target='/app/account'){
   if(!['login','register'].includes(mode))fail('official_account_mode_invalid');
   return endpoint+'/v1/account/login?'+new URLSearchParams({mode,returnTo:returnPath(target,websiteOrigin)});
  },
  async logout(session){
   if(session?.state!=='signed-in'||typeof session.csrfToken!=='string'||!session.csrfToken||session.expiresAt<=now())fail('official_account_session_expired');
   const result=readSession(await request('/v1/account/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Galaxy-Account-CSRF':session.csrfToken},body:'{}'}));
   if(result.state!=='signed-out')fail('official_account_response_invalid');return result;
  }
 });
}
