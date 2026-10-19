import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

export async function dispatchExternalCredentials({externalCredentials,officialAccounts,request,response,url,send}) {
  const base='/v1/account/external-credentials';
  if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return false;
  response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
  if(!externalCredentials||!officialAccounts)throw new ServiceError('external_credentials_unavailable',503);
  const match=url.pathname.match(/^\/v1\/account\/external-credentials\/([0-9a-f-]{36})(\/recheck)?$/),write=request.method!=='GET';
  const actor=await officialAccounts.actionActor(request,{write});
  if(url.pathname===base&&request.method==='GET') {
    if([...url.searchParams.keys()].some(key=>key!=='after')||url.searchParams.getAll('after').length>1)throw new ServiceError('invalid_external_credential_input');
    send(200,await externalCredentials.list(actor,url.searchParams.has('after')?{after:url.searchParams.get('after')}:{}));
  }else if(url.pathname===base&&request.method==='POST'&&!url.search)send(201,await externalCredentials.importCredential(actor,await body(request,['credential'],{maxBytes:196608})));
  else if(match&&!url.search&&request.method==='GET'&&!match[2])send(200,await externalCredentials.get(actor,match[1]));
  else if(match&&!url.search&&request.method==='POST'&&match[2]){await body(request,[]);send(200,await externalCredentials.recheck(actor,match[1]));}
  else if(match&&!url.search&&request.method==='DELETE'&&!match[2]){
    if(request.headers['content-length']&&request.headers['content-length']!=='0'||request.headers['transfer-encoding'])throw new ServiceError('invalid_external_credential_input');
    send(200,await externalCredentials.withdraw(actor,match[1]));
  }else throw new ServiceError('not_found',404);
  return true;
}
