import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const cookieMethods={config:'configuration',source:'source',query:'query',report:'report',event:'event',receipt:'receipt',get:'get'};
const writes=new Set(['report','event']);
export async function dispatchAccountChatGovernance({accountChatGovernance,officialAccounts,authorizeOperator,request,response,requestId,url,send}){
 const cookie=/^\/v1\/account\/chat-reports\/([a-z]+)$/.exec(url.pathname);
 const operations=/^\/v1\/operations\/chat-reports(?:\/([0-9a-f-]{36})(?:\/(event|attachments\/([0-9a-f-]{36})\/content))?)?$/.exec(url.pathname);
 if(!cookie&&!operations)return false;
 if(!accountChatGovernance)throw new ServiceError('chat_report_service_unavailable',503);
 let result;
 if(cookie){
  const method=cookie[1];if(!cookieMethods[method]||request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
  if(request.headers.authorization!==undefined)throw new ServiceError('chat_report_account_required',401);
  if(!officialAccounts)throw new ServiceError('official_account_unavailable',503);
  const actor={...await officialAccounts.actionActor(request,{write:writes.has(method)}),httpRequestId:requestId};
  const input=await body(request,method==='config'?[]:undefined);
  result=method==='config'?accountChatGovernance.configuration():await accountChatGovernance[cookieMethods[method]](actor,input);
 }else{
  const id=operations[1],action=operations[2],binary=!!operations[3],write=action==='event';
  if(request.method!==(write||binary?'POST':'GET')||(id||write||binary)&&url.search)throw new ServiceError('not_found',404);
  if(typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
  const actor=await authorizeOperator(request,{write,requestId});
  accountChatGovernance.operator(actor,{write});
  if(binary){
   await body(request,[]);const file=await accountChatGovernance.operatorAttachment(actor,{reportId:id,attachmentId:operations[3]});
   response.statusCode=200;response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Length',file.bytes.length);
   response.setHeader('Content-Disposition',"attachment; filename=\"galaxy-attachment\"; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()));
   response.setHeader('Cache-Control','no-store');response.end(file.bytes);return true;
  }
  if(write){const input=await body(request);if(input.reportId!==id)throw new ServiceError('invalid_chat_report_request',400);result=await accountChatGovernance.operatorEvent(actor,input);}
  else if(id)result=await accountChatGovernance.operatorGet(actor,{reportId:id});
  else{
   const input={};for(const [key,value]of url.searchParams){if(!['roomId','state','after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_chat_report_request',400);input[key]=key==='limit'?Number(value):value;}
   result=await accountChatGovernance.operatorQuery(actor,input);
  }
 }
 send(200,result);return true;
}
