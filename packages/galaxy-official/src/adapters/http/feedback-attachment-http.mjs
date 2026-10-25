import {body,recordBodyBytes} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

const id='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const uploadPath=new RegExp('^('+id+')/upload$','i');
const methods={prepare:'prepare',read:'get',revoke:'revoke'};
export async function dispatchFeedbackAttachments({feedbackAttachments,officialAccounts,request,response,requestId,url,send}){
 const prefix='/v1/account/feedback/attachments/';if(!url.pathname.startsWith(prefix))return false;
 const path=url.pathname.slice(prefix.length),upload=uploadPath.exec(path);
 if(url.search||request.method!==(upload?'PUT':'POST')||!upload&&path!=='config'&&!Object.hasOwn(methods,path))throw new ServiceError('not_found',404);
 if(!feedbackAttachments)throw new ServiceError('attachment_service_unavailable',503);
 if(!officialAccounts)throw new ServiceError('official_account_unavailable',503);
 // This intake is account-only. A signed Galaxy identity or room credential
 // does not substitute for the real online account, Origin and CSRF token.
 if(request.headers.authorization!==undefined)throw new ServiceError('official_account_login_required',401);
 const actor={...await officialAccounts.actionActor(request,{write:true}),httpRequestId:requestId};
 if(upload){
  if(request.headers['content-encoding']||request.headers['transfer-encoding']||!/^\d+$/.test(request.headers['content-length']??''))throw new ServiceError('attachment_length_required',411);
  send(200,await feedbackAttachments.upload(actor,upload[1],request,{contentLength:Number(request.headers['content-length']),contentType:request.headers['content-type'],onBytes:n=>recordBodyBytes(request,n)}));return true;
 }
 const input=await body(request,path==='config'?[]:undefined,{maxBytes:4096});
 if(path==='config'){
  await feedbackAttachments.run(actor,async()=>{});send(200,feedbackAttachments.specification());
 }else send(200,await feedbackAttachments[methods[path]](actor,input));
 return true;
}
