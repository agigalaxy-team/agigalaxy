import type {createWebRuntime} from './runtime.mjs';

export type Runtime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'status'|'api'|'receiptStatus'|'getLocal'|'putLocal'|'updateLocal'>;
export type Source={kind:'message'|'attachment';id:string;version:number;sha256:string;roomId:string};
export type Material={materialId:string;version:number;ownerId:string;authorId:string;caseId:string;title:string;source:Source;state:string;revision:number;size:number;sha256:string;contentAvailable:boolean;content?:string;permissionExpiresAt?:string|null;requestExpiresAt?:string;requestHash?:string;sourceName?:string|null;sourceMediaType?:string|null;sourceReadExpiresAt?:number|null;audience:{visibility:string;viewers:string[]};uses:string[];request?:{purpose:string;audience:{visibility:string;viewers:string[]};uses:string[];requestExpiresAt:string};sourceContent?:{source:Source;authorId:string;content:string;readExpiresAt?:number|string}|null;sourceContentReason?:string|null};
export type Message={messageId:string;revision:number;text?:string|null;subjectId:string;attachments?:{attachmentId:string;name?:string;state:string}[]};
export type MaterialKind='request'|'approve'|'decline'|'cancel'|'revoke';
export type Locator={operationId:string;materialId:string;payloadHash:string;kind:MaterialKind;state?:string};
export type Review=Locator&{endpoint:string;subjectId:string;event:{kind:MaterialKind;title?:string;caseId?:string;purpose?:string;scope?:string;reason?:string;source?:Source;audience?:{visibility:string;viewers:string[]};uses?:string[];license?:string;basis?:string;licenseReference?:string;expiresAt?:string;requestExpiresAt?:string;expectedRevision?:number};viewers:string[];authorizationExpiresAt:number;retry:boolean};
export type Selected={source:Source;authorId:string;size:number;name?:string;mediaType?:string};
export type RequestInput={source:Source|null;caseId:string;title:string;purpose:string;viewers:string;visibility:string;uses:string[];until:string;step:number};
export type Props={runtime:Runtime;subjectId?:string;connected:boolean;roomId?:string;messages:Message[];memberIds?:string[];linkedCases?:{caseId:string;taskId:string;title:string}[];onReturnToConversation?:()=>void};
export type MaterialDirectory={pending:Locator|null;stopped:Locator[];receipts:Locator[]};
export type MaterialReceipt={operationId:string;state:string;material?:{materialId:string}};
export type MaterialClient={
 source:(selection:{kind:Source['kind'];id:string;version:number})=>Promise<Selected>;
 query:(input:{view:'requested'|'authored';limit:number;after?:string})=>Promise<{items:Material[];nextAfter?:string}>;
 inspect:(id:string)=>Promise<Material>;
 history:(after?:string)=>Promise<{items:{kind:string;caseId?:string|null;title?:string|null}[];nextCursor:string|null}>;
 directory:()=>Promise<MaterialDirectory>;
 prepare:(input:unknown,options:{viewers:string[];expiresAt:number})=>Promise<Review>;
 confirm:(value:Review,options:{confirmed:true})=>Promise<MaterialReceipt>;
 reconcile:(operationId:string)=>Promise<MaterialReceipt>;
 reviewPending:()=>Promise<Review|MaterialReceipt>;
 stop:(operationId:string)=>Promise<{state:string}>;
 read:(id:string)=>Promise<Material>;
 download:(id:string)=>Promise<{bytes:Uint8Array<ArrayBuffer>;name:string;view:Material}>;
};
export type RequestAttempt={operationId:string;materialId:string;payloadHash?:string};
export type RequestDraft={version:1;revision:string;value:RequestInput;attempt?:RequestAttempt};
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function source(value:unknown,roomId:string|undefined):value is Source{return object(value)&&typeof value.roomId==='string'&&value.roomId===roomId&&(value.kind==='message'||value.kind==='attachment')&&typeof value.id==='string'&&Number.isInteger(value.version)&&typeof value.sha256==='string';}
function attempt(value:unknown):value is RequestAttempt{return object(value)&&typeof value.operationId==='string'&&typeof value.materialId==='string'&&(value.payloadHash===undefined||typeof value.payloadHash==='string');}
function input(value:unknown,roomId:string|undefined):value is RequestInput{
 return object(value)&&['caseId','title','purpose','viewers','visibility','until'].every(key=>typeof value[key]==='string')
  &&Array.isArray(value.uses)&&value.uses.every(use=>typeof use==='string'&&['evidence','capsule-publication'].includes(use))
  &&(value.step===0||value.step===1)&&(value.source===null||source(value.source,roomId));
}
function draft(value:unknown,roomId:string|undefined):value is RequestDraft{return object(value)&&value.version===1&&typeof value.revision==='string'&&input(value.value,roomId)&&(value.attempt===undefined||attempt(value.attempt));}
/** Preserve the original envelope and field order; validate only before consuming it. */
export function checkedOutcomeDraft(value:unknown,roomId:string|undefined):RequestDraft|null{if(value==null)return null;if(!draft(value,roomId))throw Error('这份保存申请草稿暂时无法读取，请保留本页输入。');return value;}
export function hasMaterialAttempt(value:unknown):value is {attempt:RequestAttempt}{return object(value)&&attempt(value.attempt);}
