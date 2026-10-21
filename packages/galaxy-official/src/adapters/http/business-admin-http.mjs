import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

function page(url,allowed){
 const input={};for(const [key,value]of url.searchParams){
  if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_business_admin_request');
  input[key]=key==='limit'?Number(value):value;
 }return input;
}

export async function dispatchBusinessAdmin({businessAdmin,authorizeOperator,request,requestId,url,send}){
 const list=url.pathname==='/v1/operations/users',audit=url.pathname==='/v1/operations/audit';
 const route=/^\/v1\/operations\/users\/([0-9a-f-]{36})(?:\/(audit|links|type-history|restriction|restriction\/release|type-change))?$/.exec(url.pathname);
 if(!list&&!audit&&!route)return false;
 const write=!!route&&['restriction','restriction/release','type-change'].includes(route[2]);
 if(request.method!==(write?'POST':'GET')||write&&url.search)throw new ServiceError('not_found',404);
 if(!businessAdmin||typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
 // The BFF/server validates its real authenticated operator session, role and
 // write CSRF here. JSON cannot supply an operator, role or account authority.
 const operator=await authorizeOperator(request,{write,requestId});
 businessAdmin.require(operator,{write});
 let result;
 if(list)result=await businessAdmin.list(operator,page(url,['query','after','limit']));
 else if(audit)result=await businessAdmin.audit(operator,page(url,['accountId','resourceId','after','limit']));
 else{
  const accountId=route[1],action=route[2];
  if(!action){if(url.search)throw new ServiceError('invalid_business_admin_request');result=await businessAdmin.get(operator,accountId);}
  else if(action==='audit')result=await businessAdmin.audit(operator,{...page(url,['after','limit']),accountId});
  else if(action==='links')result=await businessAdmin.links(operator,accountId,page(url,['after','limit']));
  else if(action==='type-history')result=await businessAdmin.typeHistory(operator,accountId,page(url,['after','limit']));
  else{
   const input=await body(request,undefined,{maxBytes:16384});
   result=action==='restriction'?await businessAdmin.restrict(operator,accountId,input):action==='restriction/release'?await businessAdmin.releaseRestriction(operator,accountId,input):await businessAdmin.changeType(operator,accountId,input);
  }
 }
 send(200,result);return true;
}
