import {chatOriginalIntent,chatReceiptIntent} from '../../../../packages/galaxy-contracts/src/operations-chat-receipt-intent.mjs';
import {canonicalReceiptInput} from '../../../../packages/galaxy-contracts/src/operations-governance-receipt-intent.mjs';
import {operationsRequest} from './operations-client';
type Intent=Readonly<{path:string;body:Record<string,unknown>}>;
export type ChatRecovered={recovered:true;operationId:string;kind:string;reportId:string;version:number;state:string;recordedAt:string;messageId:string|null;messageRevision:number|null;dispositionRevision:number|null;overallHiddenAtCommit:boolean|null};
const object=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
const key=(intent:Intent)=>canonicalReceiptInput({path:intent.path,body:intent.body});
const verified=new WeakMap<object,string>(),unavailable=()=>Error('Original operator result unavailable');
export const chatRecoveryPendingMessage='处理时间比平时长，内容已保留。';
export function isChatRecovered(value:unknown):value is ChatRecovered{return object(value)&&value.recovered===true;}
export async function chatRecoveryReceipt(intent:Intent,value:unknown):Promise<ChatRecovered|null>{
 const original=await chatReceiptIntent(intent.path,intent.body),x=original.input;
 if(!object(x)||typeof x.reportId!=='string'||!integer(x.expectedVersion))throw unavailable();
 if(!object(value)||value.operationId!==original.operationId||value.metadataOnly!==true||!integer(value.checkedAt)||!integer(value.readExpiresAt)||value.readExpiresAt<=Date.now()/1000||value.readExpiresAt>value.checkedAt+30)throw unavailable();
 if(value.state==='not-recorded'||value.state==='unknown')return null;
 if(value.state!=='recorded'||value.kind!==original.kind||!object(value.result))throw unavailable();
 const r=value.result;
 if(r.intentHash!==original.intentHash||r.reportId!==x.reportId||!integer(r.version)||r.version!==x.expectedVersion+1||!['received','reviewing','resolved','appealed','withdrawn'].includes(String(r.state))||typeof r.recordedAt!=='string'||!Number.isFinite(Date.parse(r.recordedAt)))throw unavailable();
 if((original.kind==='review'||original.kind==='pause')&&r.state!=='reviewing'||original.kind==='resolve'&&r.state!=='resolved')throw unavailable();
 const result:ChatRecovered={recovered:true,operationId:original.operationId,kind:original.kind,reportId:x.reportId,version:r.version,state:String(r.state),recordedAt:r.recordedAt,messageId:null,messageRevision:null,dispositionRevision:null,overallHiddenAtCommit:null};
 if(original.kind.startsWith('message-')){
  if(typeof x.messageId!=='string'||!integer(x.messageRevision)||!integer(x.expectedRevision)||!integer(r.dispositionRevision)||r.messageId!==x.messageId||r.messageRevision!==x.messageRevision||r.dispositionRevision!==x.expectedRevision+1||typeof r.overallHiddenAtCommit!=='boolean')throw unavailable();
  result.messageId=x.messageId;result.messageRevision=x.messageRevision;result.dispositionRevision=r.dispositionRevision;result.overallHiddenAtCommit=r.overallHiddenAtCommit;
 }
 verified.set(result,key(intent));return result;
}
export async function recoverChatCommand(intent:Intent,{signal}:{signal:AbortSignal}):Promise<{state:'recorded';value:ChatRecovered}>{
 try{const original=await chatReceiptIntent(intent.path,intent.body),value=await operationsRequest<unknown>(original.receiptPath,{signal}),result=await chatRecoveryReceipt(intent,value);if(!result)throw unavailable();return{state:'recorded',value:result};}catch{throw unavailable();}
}
export function validateChatOperation(value:unknown,intent:Intent){
 if(isChatRecovered(value)){if(verified.get(value)!==key(intent))throw unavailable();return;}
 const original=chatOriginalIntent(intent.path,intent.body),x=original.input;
 if(!object(x)||typeof x.reportId!=='string'||!integer(x.expectedVersion))throw unavailable();
 const expectedVersion=x.expectedVersion;
 if(!object(value)||value.reportId!==x.reportId||value.version!==expectedVersion+1||!Array.isArray(value.events)||!value.events.some((e:unknown)=>object(e)&&e.eventId===original.operationId&&e.kind===original.kind&&e.version===expectedVersion+1))throw unavailable();
 if(original.kind.startsWith('message-')&&(!object(value.messageOperation)||value.messageOperation.operationId!==original.operationId))throw unavailable();
}
