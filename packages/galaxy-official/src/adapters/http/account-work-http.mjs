import {z} from 'zod';
import {body,authenticate} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const actions=new Set(['put','get','list','delete','status']);
export async function dispatchAccountWork({accountWork,officialAccounts,access,request,requestId,url,send}){
 const native=url.pathname.startsWith('/v2/account-work/'),website=url.pathname.startsWith('/v1/account/work/');
 if(!native&&!website)return false;
 const method=url.pathname.slice((native?'/v2/account-work/':'/v1/account/work/').length);
 if(request.method!=='POST'||url.search||!actions.has(method)||website&&method==='put')throw new ServiceError('not_found',404);
 if(!accountWork)throw new ServiceError('account_work_unavailable',503);
 let actor;
 if(native){
  const verified=await authenticate(request,access,'binding'),accountId=request.headers['x-galaxy-account-id'];
  if(!z.uuid().safeParse(accountId).success)throw new ServiceError('account_selection_required',409);
  actor={...verified,accountId,httpRequestId:requestId};
 }else{
  // The account-only URI never substitutes Cookie authority for a rejected ID
  // request. Native callers use the explicitly signed-session v2 URI.
  if(request.headers.authorization!==undefined)throw new ServiceError('access_denied',401);
  if(!officialAccounts)throw new ServiceError('official_account_unavailable',503);
  actor={...await officialAccounts.actionActor(request,{write:method==='delete'}),httpRequestId:requestId};
 }
 const input=await body(request,undefined,{maxBytes:method==='put'?1048576:32768});
 send(200,await accountWork[method](actor,input));return true;
}
