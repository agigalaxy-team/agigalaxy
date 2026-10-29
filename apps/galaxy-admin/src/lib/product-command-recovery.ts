import {productOriginalIntent,productReceiptIntent} from '../../../../packages/galaxy-contracts/src/operations-product-receipt-intent.mjs';
import {canonicalReceiptInput} from '../../../../packages/galaxy-contracts/src/operations-governance-receipt-intent.mjs';
import {operationsRequest} from './operations-client';
type Intent=Readonly<{path:string;body:Record<string,unknown>}>;
export type ProductRecovered={recovered:true;operationId:string;action:string;recordedAt:string}&({family:'notice';noticeId:string;version:number;state:'draft'|'queued'|'withdrawn';submittedJobId:string|null}|{family:'retention';runId:string;target:string;state:'queued';jobId:string;createdAt:string});
const object=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const validDate=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const key=(intent:Intent)=>canonicalReceiptInput({path:intent.path,body:intent.body});
const verified=new WeakMap<object,string>(),unavailable=()=>Error('Original product result unavailable');
export const productRecoveryPendingMessage='处理时间比平时长，内容已保留。';
export function isProductRecovered(value:unknown):value is ProductRecovered{return object(value)&&value.recovered===true;}
export async function productRecoveryReceipt(intent:Intent,value:unknown):Promise<ProductRecovered|null>{
 const original=await productReceiptIntent(intent.path,intent.body),x=original.input;
 if(!object(value)||value.operationId!==original.operationId||value.metadataOnly!==true||!integer(value.checkedAt)||!integer(value.readExpiresAt)||value.readExpiresAt<=Date.now()/1000||value.readExpiresAt>value.checkedAt+30)throw unavailable();
 if(value.state==='not-recorded'||value.state==='unknown')return null;
 if(value.state!=='recorded'||value.kind!==original.action||!object(value.result))throw unavailable();
 const r=value.result;if(r.intentHash!==original.intentHash||!validDate(r.recordedAt))throw unavailable();
 const common={recovered:true as const,operationId:original.operationId,action:original.action,recordedAt:r.recordedAt};let result:ProductRecovered;
 if(original.action==='retention-request'){
  if(r.runId!==original.operationId||r.target!==x.target||r.state!=='queued'||!uuid(r.jobId)||!validDate(r.createdAt))throw unavailable();
  result={...common,family:'retention',runId:original.operationId,target:x.target,state:'queued',jobId:r.jobId,createdAt:r.createdAt};
 }else{
  const state=original.action==='notice-publish'?'queued':original.action==='notice-withdraw'?'withdrawn':'draft';
  if(!uuid(r.noticeId)||!integer(r.version)||r.noticeId!==(x.noticeId??original.operationId)||r.version!==(x.expectedVersion??0)+1||r.state!==state||r.submittedJobId!==null&&!uuid(r.submittedJobId)||original.action==='notice-publish'&&!r.submittedJobId)throw unavailable();
  result={...common,family:'notice',noticeId:r.noticeId,version:r.version,state,submittedJobId:r.submittedJobId};
 }
 verified.set(result,key(intent));return result;
}
// Missing/denied/unknown receipts remain original GETs. Never expose the
// shared hook's legacy not-recorded => POST branch or its <500 POST rejection.
export async function recoverProductCommand(intent:Intent,{signal}:{signal:AbortSignal}):Promise<{state:'recorded';value:ProductRecovered}>{
 try{const original=await productReceiptIntent(intent.path,intent.body),value=await operationsRequest<unknown>(original.receiptPath,{signal}),result=await productRecoveryReceipt(intent,value);if(!result)throw unavailable();return{state:'recorded',value:result};}catch{throw unavailable();}
}
export function validateProductOperation(value:unknown,intent:Intent){
 if(isProductRecovered(value)){if(verified.get(value)!==key(intent))throw unavailable();return;}
 const original=productOriginalIntent(intent.path,intent.body),x=original.input;
 if(!object(value))throw unavailable();
 if(original.action==='retention-request'){
  const r=value.run;if(!object(r)||r.id!==original.operationId||r.target!==x.target||r.state!=='queued'||!uuid(r.jobId))throw unavailable();return;
 }
 const n=value.notice,state=original.action==='notice-publish'?'queued':original.action==='notice-withdraw'?'withdrawn':'draft';
 if(!object(n)||n.id!==(x.noticeId??original.operationId)||n.version!==(x.expectedVersion??0)+1||n.state!==state||original.action==='notice-publish'&&!uuid(n.jobId))throw unavailable();
 if('content' in x&&canonicalReceiptInput(n.content)!==canonicalReceiptInput(x.content))throw unavailable();
}
