import {body, authenticate} from './request.mjs';
import * as z from 'zod/v4';
import {ServiceError} from '../../shared/service-error.mjs';

export async function dispatchReadingBookmarks({readingBookmarks, access, officialAccounts, request, requestId, url, send, consumeSearchPage = () => {}}) {
  const matched = /^\/v2\/reading-bookmarks\/(status|command|query|receipt)$/.exec(url.pathname);
  const cookie=/^\/v1\/account\/bookmarks\/(status|command|query|receipt)$/.exec(url.pathname);
  const identity=/^\/v2\/account-bookmarks\/(status|command|query|receipt)$/.exec(url.pathname);
  if (!readingBookmarks || request.method !== 'POST' || !(matched||cookie||identity)) return false;
  const method = (matched||cookie||identity)[1];
  let actor;
  if(cookie){
    if(!officialAccounts)throw new ServiceError('access_denied',401);
    actor=await officialAccounts.actionActor(request,{write:method==='command'});
  }else{
    actor=await authenticate(request,access,'binding');
    if(identity){
      const accountId=request.headers['x-galaxy-account-id'];
      if(accountId!==undefined&&!z.uuid().safeParse(accountId).success)throw new ServiceError('invalid_account_target');
      if(accountId)actor={...actor,accountId};
    }
  }
  actor={...actor,httpRequestId:requestId};
  const input=await body(request);
  if (method === 'query') consumeSearchPage(actor, input.after);
  send(200, await readingBookmarks[matched?method:'account'+method[0].toUpperCase()+method.slice(1)](actor, input));
  return true;
}
