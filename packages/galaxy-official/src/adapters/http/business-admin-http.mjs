import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

function page(url,allowed){
 const input={};for(const [key,value]of url.searchParams){
  if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_business_admin_request');
  input[key]=['limit','days','page','pageSize'].includes(key)?Number(value):value;
 }return input;
}

export async function dispatchBusinessAdmin({businessAdmin,authorizeOperator,request,requestId,url,send}){
 const list=url.pathname==='/v1/operations/users',directorySummary=url.pathname==='/v1/operations/users/summary',audit=url.pathname==='/v1/operations/audit';
 const operation=/^\/v1\/operations\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/operations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(url.pathname);
 const route=/^\/v1\/operations\/users\/([0-9a-f-]{36})(?:\/(summary|audit|links|type-history|restriction|restriction\/release|type-change))?$/.exec(url.pathname);
 if(!list&&!directorySummary&&!audit&&!route&&!operation)return false;
 const write=!!route&&['restriction','restriction/release','type-change'].includes(route[2]);
 if(request.method!==(write?'POST':'GET')||write&&url.search)throw new ServiceError('not_found',404);
 if(!businessAdmin||typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
 // The BFF/server validates its real authenticated operator session, role and
 // write CSRF here. JSON cannot supply an operator, role or account authority.
 const required=write?(route[2]==='restriction'?'accounts.restriction.apply':route[2]==='restriction/release'?'accounts.restriction.release':'accounts.type.change')
  :audit||route?.[2]==='audit'?'audit.read':directorySummary||route?.[2]==='summary'?'analytics.read':'accounts.read';
 const operator=await authorizeOperator(request,{write,requestId,action:required});
 businessAdmin.require(operator,{write});
 let result;
 if(operation){if(url.search)throw new ServiceError('invalid_business_admin_request');result=await businessAdmin.operation(operator,operation[1].toLowerCase(),operation[2].toLowerCase());}
 else if(list)result=await businessAdmin.list(operator,page(url,['query','after','limit','subjectType','restriction']));
 else if(directorySummary)result=await businessAdmin.directorySummary(operator,page(url,['days']));
 else if(audit)result=await businessAdmin.audit(operator,page(url,['accountId','resourceId','after','limit','action','kind','day','query','page','pageSize','snapshot','sort']));
 else{
  const accountId=route[1],action=route[2];
  if(!action){if(url.search)throw new ServiceError('invalid_business_admin_request');result=await businessAdmin.get(operator,accountId);}
  else if(action==='summary')result=await businessAdmin.accountSummary(operator,accountId,page(url,['days']));
  else if(action==='audit')result=await businessAdmin.audit(operator,{...page(url,['resourceId','after','limit','action','kind','day','query','page','pageSize','snapshot','sort']),accountId});
  else if(action==='links')result=await businessAdmin.links(operator,accountId,page(url,['after','limit']));
  else if(action==='type-history')result=await businessAdmin.typeHistory(operator,accountId,page(url,['after','limit']));
  else{
   const input=await body(request,undefined,{maxBytes:16384});
   result=action==='restriction'?await businessAdmin.restrict(operator,accountId,input):action==='restriction/release'?await businessAdmin.releaseRestriction(operator,accountId,input):await businessAdmin.changeType(operator,accountId,input);
  }
 }
 send(200,result);return true;
}
