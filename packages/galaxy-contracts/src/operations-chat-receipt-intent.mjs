import {z} from 'zod';
import {accountChatReportEventSchema} from './account-chat-governance-schema.mjs';
import {operationsChatMessageTargetSchema,operationsChatMessageVisibilitySchema} from './operations-chat-message-schema.mjs';
import {canonicalReceiptInput,receiptTextHash} from './operations-governance-receipt-intent.mjs';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',id=z.uuid();
const event=new RegExp('^/v1/operations/chat-reports/('+uuid+')/event$','i'),message=new RegExp('^/v1/operations/chat-reports/('+uuid+')/messages/('+uuid+')/visibility$','i');
const events=new Set(['review','pause','resume','resolve']),messages=new Set(['message-hide','message-restore','message-keep']);
export function chatReceiptInput(kind,input){
 if(events.has(kind)){const x=accountChatReportEventSchema.parse(input);if(x.kind!==kind||x.materials?.length)throw Error('Invalid original operator event');return x;}
 if(messages.has(kind)){
  const {reportId,messageId,kind:storedKind,...body}=input,x=operationsChatMessageVisibilitySchema.parse(body),keys=operationsChatMessageTargetSchema.parse({reportId,messageId});
  if(storedKind!==kind||'message-'+x.action!==kind)throw Error('Invalid original message event');
  return {...x,...keys,kind};
 }
 throw Error('Invalid original operator kind');
}
export function chatReceiptHash(kind,input,hash=receiptTextHash){return hash(canonicalReceiptInput({action:'chat-report-event',input:chatReceiptInput(kind,input)}));}
export function chatOriginalIntent(path,body){
 const e=event.exec(path),m=message.exec(path);let input,kind;
 if(e){input=chatReceiptInput(body.kind,body);kind=input.kind;if(input.reportId!==e[1])throw Error('Invalid original operator target');}
 else if(m){kind='message-'+body.action;input=chatReceiptInput(kind,{...body,reportId:m[1],messageId:m[2],kind});}
 else throw Error('Invalid original operator path');
 id.parse(input.operationId);return {kind,input,operationId:input.operationId,receiptPath:'/v1/operations/chat-reports/'+input.reportId+'/operations/'+input.operationId};
}
export async function chatReceiptIntent(path,body,hash=receiptTextHash){const x=chatOriginalIntent(path,body);return {...x,intentHash:await chatReceiptHash(x.kind,x.input,hash)};}
