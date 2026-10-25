import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

export async function dispatchOperationsChatMessage({accountChatGovernance,authorizeOperator,request,requestId,url,send}){
 const match=/^\/v1\/operations\/chat-reports\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/visibility$/.exec(url.pathname);
 if(!match)return false;
 if(request.method!=='POST'||url.search)throw new ServiceError('not_found',404);
 if(!accountChatGovernance||typeof authorizeOperator!=='function')throw new ServiceError('chat_report_service_unavailable',503);
 await authorizeOperator(request,{write:true,requestId});
 const input=await body(request),action=input?.action==='hide'?'chat-messages.hide':input?.action==='restore'?'chat-messages.restore':input?.action==='keep'?'chat-messages.keep':null;
 if(!action)throw new ServiceError('invalid_chat_report_request',400);
 const authorize=()=>authorizeOperator(request,{write:true,requestId,action}),actor=await authorize();
 accountChatGovernance.operator(actor,{write:true});
 const result=await accountChatGovernance.operatorMessageVisibility(actor,{reportId:match[1],messageId:match[2]},input,{authorize});
 send(200,result);return true;
}
