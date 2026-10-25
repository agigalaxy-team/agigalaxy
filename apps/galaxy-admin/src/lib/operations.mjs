import {adminEnvironment,operatorCookies,operatorForwardedAddress} from './environment.mjs';
import {adminLog,requestCorrelation} from './runtime-log.mjs';
import {operationsReadPath} from './proxy-policy.mjs';

async function observedRead(fetcher,url,options,headers,stage){
  const started=performance.now(),edgeRequestId=requestCorrelation(headers);
  try{
    const response=await fetcher(url,options);
    adminLog('operations.read',{stage,path:url,method:'GET',statusCode:response.status,durationMs:performance.now()-started,edgeRequestId,requestId:response.headers.get('x-request-id')});
    return response;
  }catch(error){adminLog('operations.read',{stage,path:url,method:'GET',statusCode:503,durationMs:performance.now()-started,edgeRequestId,error});throw error;}
}

const failure=(code,status=503)=>Object.assign(Error(code),{code,status});
/** @typedef {{version:string,permissions:string[]}} BusinessAuthorization */
/** @typedef {{state:'signed-out'}|{state:'signed-in',operator:{id:string,displayName:string,role:'administrator'|'reader',businessAuthorization?:BusinessAuthorization},csrfToken:string,expiresAt:number}} OperatorSession */
/** @returns {Promise<OperatorSession>} */
export async function readOperatorSession(headers,{fetcher=fetch,environment=adminEnvironment()}={}){
  const cookie=operatorCookies(headers,environment.fixtureCookies);if(!cookie)return {state:'signed-out'};
  const response=await observedRead(fetcher,environment.bffOrigin+'/v1/operations/session',{headers:{Cookie:cookie,Origin:environment.publicOrigin,'X-Forwarded-For':operatorForwardedAddress(headers,environment.fixtureCookies)},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10000)},headers,'session');
  if(!response.ok)throw failure('operator_session_unavailable');
  const value=await response.json();if(value.state==='signed-out')return {state:'signed-out'};
  if(value.state!=='signed-in'||typeof value.operator?.id!=='string'||!['administrator','reader'].includes(value.operator.role)||typeof value.csrfToken!=='string'||!Number.isFinite(value.expiresAt)||value.expiresAt<=Date.now()/1000)throw failure('operator_session_invalid',401);
  const authority=value.operator.businessAuthorization;
  if(authority!==undefined&&(typeof authority?.version!=='string'||!authority.version||authority.version.length>128||!Array.isArray(authority.permissions)||authority.permissions.length>256
    ||authority.permissions.some(code=>typeof code!=='string'||!/^[a-z][a-z0-9.-]{0,99}$/.test(code))||new Set(authority.permissions).size!==authority.permissions.length))throw failure('operator_session_invalid',401);
  return {state:'signed-in',operator:{id:value.operator.id,displayName:typeof value.operator.displayName==='string'?value.operator.displayName:'运营成员',role:value.operator.role,
    ...(authority?{businessAuthorization:{version:authority.version,permissions:[...authority.permissions]}}:{})},csrfToken:value.csrfToken,expiresAt:value.expiresAt};
}
export async function operationsRead(headers,path,{fetcher=fetch,environment=adminEnvironment()}={}){
  if(!operationsReadPath(path))throw failure('invalid_operations_path',400);
  const session=await readOperatorSession(headers,{fetcher,environment});if(session.state!=='signed-in')throw failure('operator_login_required',401);
  const response=await observedRead(fetcher,environment.bffOrigin+path,{headers:{Cookie:operatorCookies(headers,environment.fixtureCookies),Origin:environment.publicOrigin,'X-Forwarded-For':operatorForwardedAddress(headers,environment.fixtureCookies)},cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(15000)},headers,'business-read');
  if(!response.ok){const error=await response.json().catch(()=>null);throw failure(typeof error?.error==='string'?error.error:'operations_unavailable',response.status);}
  return response.json();
}
