import {z} from 'zod';
import {noticeCreateSchema,noticeSaveSchema,noticeActionSchema,retentionRequestSchema} from './operations-notice-retention-schema.mjs';
import {canonicalReceiptInput,receiptTextHash} from './operations-governance-receipt-intent.mjs';
const id=z.uuid(),uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const notice=new RegExp('^/v1/operations/notices/('+uuid+')/(save|publish|withdraw)$','i');
const schemas={'notice-create':noticeCreateSchema,'notice-save':noticeSaveSchema,'notice-publish':noticeActionSchema,'notice-withdraw':noticeActionSchema,'retention-request':retentionRequestSchema};
export function productReceiptInput(action,input){
 if(!Object.hasOwn(schemas,action))throw Error('Invalid original product action');
 if(action==='notice-create'||action==='retention-request')return schemas[action].parse(input);
 const {noticeId,...body}=input;return {...schemas[action].parse(body),noticeId:id.parse(noticeId)};
}
export function productReceiptHash(action,input,hash=receiptTextHash){return hash(canonicalReceiptInput({action,input:productReceiptInput(action,input)}));}
export function productOriginalIntent(path,body){
 let action,input,receiptPath,readPermission;const match=notice.exec(path);
 if(path==='/v1/operations/notices'){action='notice-create';input=productReceiptInput(action,body);readPermission='notices.read';}
 else if(match){action='notice-'+match[2];input=productReceiptInput(action,{...body,noticeId:match[1]});readPermission='notices.read';}
 else if(path==='/v1/operations/retention/runs'){action='retention-request';input=productReceiptInput(action,body);readPermission='retention.read';}
 else throw Error('Invalid original product path');
 receiptPath='/v1/operations/'+(action==='retention-request'?'retention':'notices')+'/operations/'+input.operationId;
 return {action,input,operationId:input.operationId,receiptPath,readPermission};
}
export async function productReceiptIntent(path,body,hash=receiptTextHash){const intent=productOriginalIntent(path,body);return {...intent,intentHash:await productReceiptHash(intent.action,intent.input,hash)};}
