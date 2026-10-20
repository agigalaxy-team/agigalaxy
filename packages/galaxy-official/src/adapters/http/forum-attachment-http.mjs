import {body,authenticate,recordBodyBytes} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {z} from 'zod';
const methods={prepare:'prepare',read:'get',query:'queryOwn',revoke:'revoke'};
async function actorFor(request,access,officialAccounts,requestId,{write=false,optional=false}={}){
 if(request.headers.authorization!==undefined){const actor=await authenticate(request,access,write?'assistance':'binding'),accountId=request.headers['x-galaxy-account-id'];if(accountId!==undefined&&!z.uuid().safeParse(accountId).success)throw new ServiceError('invalid_account_target',400);return{...actor,httpRequestId:requestId,...(accountId?{accountId}:{})};}
 if(optional&&request.headers['x-galaxy-account-id']===undefined)return null;
 if(!officialAccounts)throw new ServiceError('account_verification_required',401);return{...await officialAccounts.actionActor(request,{write}),httpRequestId:requestId};
}
export async function dispatchForumAttachments({forumAttachments,access,officialAccounts,request,response,requestId,url,send}){
 if(!forumAttachments||!url.pathname.startsWith('/v2/community/attachments/'))return false;
 const path=url.pathname.slice('/v2/community/attachments/'.length),binary=/^([0-9a-f-]{36})\/(upload|content)$/.exec(path);
 if(!binary&&request.method==='POST'&&(path==='config'||methods[path])){
  if(path==='config'){await body(request,[]);send(200,forumAttachments.specification());return true;}
  const actor=await actorFor(request,access,officialAccounts,requestId,{write:['prepare','revoke'].includes(path)}),input=await body(request);send(200,await forumAttachments[methods[path]](actor,input));return true;
 }
 if(!binary)return false;const upload=binary[2]==='upload';if(request.method!==(upload?'PUT':'POST'))return false;
 const actor=await actorFor(request,access,officialAccounts,requestId,{write:upload,optional:!upload});
 if(upload){if(request.headers['content-encoding']||request.headers['transfer-encoding']||!/^\d+$/.test(request.headers['content-length']??''))throw new ServiceError('attachment_length_required',411);send(200,await forumAttachments.upload(actor,binary[1],request,{contentLength:Number(request.headers['content-length']),contentType:request.headers['content-type'],onBytes:n=>recordBodyBytes(request,n)}));return true;}
 const input=await body(request),result=await forumAttachments.content(actor,{...input,attachmentId:binary[1]});response.statusCode=200;response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Length',result.bytes.length);response.setHeader('Content-Disposition',"attachment; filename=\"galaxy-attachment\"; filename*=UTF-8''"+encodeURIComponent(result.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()));response.setHeader('X-Galaxy-Content-Sha256',result.sha256);response.end(result.bytes);return true;
}
