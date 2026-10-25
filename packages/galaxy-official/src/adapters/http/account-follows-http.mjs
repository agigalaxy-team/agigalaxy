import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {accountFollowMethod} from '../../shared/account-follows-schema.mjs';

export async function dispatchAccountFollows({accountFollows,officialAccounts,request,url,send,consumeSearchPage=()=>{}}){
 const method=accountFollowMethod(url.pathname);
 if(!method)return false;
 if(!accountFollows||!officialAccounts)throw new ServiceError('account_follow_unavailable',503);
 if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
 const actor=await officialAccounts.actionActor(request,{write:method==='command'}),input=await body(request,undefined,{maxBytes:2048});
 if(method==='query')consumeSearchPage(actor,input.after);
 send(200,await accountFollows[method](actor,input));return true;
}
