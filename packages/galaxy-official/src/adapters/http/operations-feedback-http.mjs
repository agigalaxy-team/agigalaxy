import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const id='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const detail=new RegExp('^/v1/operations/feedback/('+id+')(?:/(events))?$','i');
const attachment=new RegExp('^/v1/operations/feedback/('+id+')/attachments/('+id+')/content$','i');
const operation=new RegExp('^/v1/operations/feedback/('+id+')/operations/('+id+')$','i');
function query(url,allowed){const result={};for(const[key,value]of url.searchParams){
 if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_feedback_request',400);
 result[key]=key==='limit'||key==='days'&&value!=='all'?Number(value):value;
}return result;}

export async function dispatchOperationsFeedback({operationsFeedback,officialAccounts,authorizeOperator,request,response,requestId,url,send}){
 const binary=attachment.exec(url.pathname);
 if(binary){
  if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
  if(!operationsFeedback)throw new ServiceError('feedback_service_unavailable',503);
  if(typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
  const authorize=()=>authorizeOperator(request,{write:false,csrf:true,requestId,action:'feedback.attachments.read'}),actor=await authorize();operationsFeedback.require(actor,false);
  await body(request,[]);
  const file=await operationsFeedback.attachmentContent(actor,binary[1],binary[2],{authorize});
  response.statusCode=200;response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Length',file.bytes.length);
  response.setHeader('Content-Disposition',"attachment; filename=\"galaxy-feedback-attachment\"; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/[!'()*]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase()));
  response.setHeader('Cache-Control','private, no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('X-Galaxy-Content-Sha256',file.sha256);response.end(file.bytes);return true;
 }
 const intake=url.pathname==='/v1/account/feedback',list=url.pathname==='/v1/operations/feedback',target=detail.exec(url.pathname),receipt=operation.exec(url.pathname);
 if(!intake&&!list&&!target&&!receipt)return false;
 const write=intake||!!target?.[2];
 if(request.method!==(write?'POST':'GET')||(write||receipt)&&url.search)throw new ServiceError('not_found',404);
 if(!operationsFeedback)throw new ServiceError('feedback_service_unavailable',503);
 if(intake){
  if(!officialAccounts)throw new ServiceError('official_account_unavailable',503);
  const actor={...await officialAccounts.actionActor(request,{write:true}),httpRequestId:requestId};
  const result=await operationsFeedback.submit(actor,await body(request,undefined,{maxBytes:32768}));
  send(result.replayed?200:201,result);return true;
 }
 if(typeof authorizeOperator!=='function')throw new ServiceError('business_admin_unavailable',503);
 const actor=await authorizeOperator(request,{write,requestId,action:write?'feedback.update':'feedback.read'});operationsFeedback.require(actor,write);
 const result=receipt?await operationsFeedback.operation(actor,receipt[1].toLowerCase(),receipt[2].toLowerCase()):list?await operationsFeedback.list(actor,query(url,['query','category','module','state','days','after','limit']))
  :write?await operationsFeedback.event(actor,target[1],await body(request,undefined,{maxBytes:16384}))
  :await operationsFeedback.get(actor,target[1],query(url,['historyAfter']));
 send(200,result);return true;
}
