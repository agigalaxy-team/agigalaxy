import {body,recordBodyBytes} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {chatHttpActor} from './chat-http.mjs';
const methods={prepare:'prepare',read:'get',query:'queryOwn',revoke:'revoke'};
export async function dispatchAttachments({attachments,access,officialAccounts,request,response,requestId,url,send}){
 if(!attachments||!url.pathname.startsWith('/v2/chat/attachments/'))return false;
 const path=url.pathname.slice('/v2/chat/attachments/'.length),binary=/^([0-9a-f-]{36})\/(upload|content|export-content)$/.exec(path);
 if(!binary&&request.method==='POST'&&(path==='config'||methods[path])){
   const actor=await chatHttpActor({request,access,officialAccounts,requestId,write:['prepare','revoke'].includes(path)});
  const input=await body(request,path==='config'?[]:null);send(200,path==='config'?attachments.specification():await attachments[methods[path]](actor,input));return true;
 }
 if(!binary)return false;
 const upload=binary[2]==='upload';if(request.method!==(upload?'PUT':'POST'))return false;
  const actor=await chatHttpActor({request,access,officialAccounts,requestId,write:upload});
 if(upload){
  if(request.headers['content-encoding']||request.headers['transfer-encoding']||!/^\d+$/.test(request.headers['content-length']??''))throw new ServiceError('attachment_length_required',411);
  const result=await attachments.upload(actor,binary[1],request,{contentLength:Number(request.headers['content-length']),contentType:request.headers['content-type'],onBytes:n=>recordBodyBytes(request,n)});
  send(200,result);return true;
 }
 const input=await body(request,[]),result=await attachments.content(actor,{attachmentId:binary[1],...input},{ownExport:binary[2]==='export-content'});
 response.statusCode=200;response.setHeader('Content-Type','application/octet-stream');response.setHeader('Content-Length',result.bytes.length);
 response.setHeader('Content-Disposition',"attachment; filename=\"galaxy-attachment\"; filename*=UTF-8''"+encodeURIComponent(result.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()));
 response.setHeader('X-Galaxy-Content-Sha256',result.sha256);response.end(result.bytes);return true;
}
