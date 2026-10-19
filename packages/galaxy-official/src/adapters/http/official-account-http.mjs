import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {serveAccountNavigationError} from './identity-callback-page.mjs';
import {AccountPublicQuery} from '../../account-public-query.mjs';

function publicPage(url){
  if([...url.searchParams.keys()].some(key=>!['after','limit'].includes(key)||url.searchParams.getAll(key).length!==1))throw new ServiceError('invalid_account_query');
  return {...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{}),...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{})};
}

export async function dispatchOfficialAccount({officialAccounts,forum,externalCredentials,request,response,url,send,recordFailure}) {
  if (!url.pathname.startsWith('/v1/account/')) return false;
  try {
  if (!officialAccounts) throw new ServiceError('official_account_unavailable',503);
  if (request.method === 'GET' && url.pathname === '/v1/account/login') await officialAccounts.login(request,response,url);
  else if (request.method === 'GET' && url.pathname === '/v1/account/callback') await officialAccounts.callback(request,response,url);
  else if (request.method === 'GET' && url.pathname === '/v1/account/session') send(200,await officialAccounts.session(request,url));
  else if(request.method==='GET'&&url.pathname.startsWith('/v1/account/public/')){
    response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
    const query=new AccountPublicQuery({data:officialAccounts.data,accounts:forum?.accounts,externalCredentials,forum}),
      byId=/^\/v1\/account\/public\/by-id\/(GUID[0-9A-Z]{28})$/.exec(url.pathname),
      list=/^\/v1\/account\/public\/([0-9a-f-]{36})\/(ids|credentials|posts)$/.exec(url.pathname);
    if(byId){send(200,await query.accountsForId(byId[1],publicPage(url)));return true;}
    if(list){send(200,await query[list[2]==='ids'?'linkedIds':list[2]](list[1],publicPage(url)));return true;}
    if(!/^\/v1\/account\/public\/[0-9a-f-]{36}$/.test(url.pathname))throw new ServiceError('not_found',404);
    if(url.search)throw new ServiceError('invalid_account_query');
    send(200,await officialAccounts.data.publicProfile(url.pathname.split('/').at(-1),{publicPosts:forum?.publicForAccount?accountId=>forum.publicForAccount(accountId):undefined}));
  }
  else if (request.method === 'POST' && url.pathname === '/v1/account/logout') {await body(request,[]); send(200,officialAccounts.logout(request,response));}
  else if(url.pathname==='/v1/account/settings'&&request.method==='GET')send(200,await officialAccounts.data.settings(await officialAccounts.actionActor(request,{write:false})));
  else if(url.pathname==='/v1/account/archives'&&request.method==='GET'){if([...url.searchParams.keys()].some(key=>!['after','limit'].includes(key))||[...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1))throw new ServiceError('invalid_archive_cursor');send(200,await officialAccounts.data.listArchives(await officialAccounts.actionActor(request,{write:false}),{...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{}),...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{})}));}
  else if(request.method==='POST'){
    const operation=new Map([
      ['/v1/account/settings','updateSettings'],['/v1/account/type-change','changeType'],
      ['/v1/account/archives/create','createArchive'],['/v1/account/archives/chunk','appendChunk'],
      ['/v1/account/archives/complete','completeArchive'],['/v1/account/archives/export','exportChunk'],
      ['/v1/account/archives/delete','deleteArchive'],['/v1/account/archives/cleanup','cleanup']
      ,['/v1/account/archives/status','archiveStatus']
    ]).get(url.pathname);
    if(!operation||url.search)throw new ServiceError('not_found',404);
    const actor=await officialAccounts.actionActor(request),input=await body(request,operation==='cleanup'?[]:undefined,{maxBytes:operation==='appendChunk'?1572864:32768});
    send(200,await officialAccounts.data[operation](actor,input));
  }
  else throw new ServiceError('not_found',404);
  return true;
  } catch(error) {
    if(request.method==='GET'&&['/v1/account/login','/v1/account/callback'].includes(url.pathname)
      &&await serveAccountNavigationError({request,response,error,recordFailure}))return true;
    throw error;
  }
}
