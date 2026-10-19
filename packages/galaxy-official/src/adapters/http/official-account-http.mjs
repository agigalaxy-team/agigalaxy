import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {serveAccountNavigationError} from './identity-callback-page.mjs';

export async function dispatchOfficialAccount({officialAccounts,request,response,url,send,recordFailure}) {
  if (!url.pathname.startsWith('/v1/account/')) return false;
  try {
  if (!officialAccounts) throw new ServiceError('official_account_unavailable',503);
  if (request.method === 'GET' && url.pathname === '/v1/account/login') await officialAccounts.login(request,response,url);
  else if (request.method === 'GET' && url.pathname === '/v1/account/callback') await officialAccounts.callback(request,response,url);
  else if (request.method === 'GET' && url.pathname === '/v1/account/session') send(200,await officialAccounts.session(request,url));
  else if (request.method === 'POST' && url.pathname === '/v1/account/logout') {await body(request,[]); send(200,officialAccounts.logout(request,response));}
  else throw new ServiceError('not_found',404);
  return true;
  } catch(error) {
    if(request.method==='GET'&&['/v1/account/login','/v1/account/callback'].includes(url.pathname)
      &&await serveAccountNavigationError({request,response,error,recordFailure}))return true;
    throw error;
  }
}
