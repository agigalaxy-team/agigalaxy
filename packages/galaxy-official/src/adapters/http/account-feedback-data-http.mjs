import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const prefix='/v1/account/data/feedback/';
const id='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const operation=new RegExp('^operations/('+id+')$','i');
const page=new RegExp('^exports/('+id+')$','i');
const content=new RegExp('^exports/('+id+')/attachments/('+id+')/content$','i');

export async function dispatchAccountFeedbackData({accountFeedbackData,officialAccounts,request,response,requestId,url,send}){
 if(!url.pathname.startsWith(prefix))return false;
 const path=url.pathname.slice(prefix.length),receipt=operation.exec(path),exportPage=page.exec(path),binary=content.exec(path);
 const intent=path==='export'||path==='delete',write=intent||!!binary;
 if(!intent&&!receipt&&!exportPage&&!binary||request.method!==(write?'POST':'GET')||!exportPage&&url.search)
  throw new ServiceError('not_found',404);
 const query={};if(exportPage)for(const[key,value]of url.searchParams){
  if(!['after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_account_feedback_data_request',400);
  query[key]=key==='limit'?Number(value):value;
 }
 if(!accountFeedbackData||!officialAccounts)throw new ServiceError('official_account_unavailable',503);
 // Online-account ownership and the existing Origin/CSRF checks cannot be
 // substituted by an identity token, an operator session or an account ID.
 if(request.headers.authorization!==undefined)throw new ServiceError('official_account_login_required',401);
 const authorize=async()=>({...await officialAccounts.actionActor(request,{write}),httpRequestId:requestId});
 const actor=await authorize();
 if(intent){
  const result=await accountFeedbackData[path](actor,await body(request,['operationId'],{maxBytes:4096}));
  send(result.replayed?200:201,result);return true;
 }
 if(receipt){send(200,await accountFeedbackData.operation(actor,receipt[1]));return true;}
 if(exportPage){send(200,await accountFeedbackData.exportPage(actor,exportPage[1],query));return true;}
 await body(request,[],{maxBytes:4096});
 const file=await accountFeedbackData.attachmentContent(actor,binary[1],binary[2],{authorize});
 response.statusCode=200;response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Length',file.bytes.length);
 response.setHeader('Content-Disposition',"attachment; filename=\"galaxy-feedback-attachment\"; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/[!'()*]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase()));
 response.setHeader('Cache-Control','private, no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('X-Galaxy-Content-Sha256',file.sha256);response.end(file.bytes);return true;
}
