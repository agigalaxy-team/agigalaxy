import type {z} from 'zod/v4';
import type {createWebRuntime} from "../../../runtime.mjs";
import type {taskOwnerReadPreviewV2Schema,taskOwnerReadResultV2Schema} from "../../../../../galaxy-contracts/src/task-owner-read-v2-schema.mjs";

export type OwnerReadRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'getLocal'|'putLocal'|'updateLocal'|'receiptStatus'|'reviewTaskStop'|'stopTaskOperation'>;
export type OwnerReadScope=z.infer<typeof taskOwnerReadPreviewV2Schema>&{authorizationState?:'authorized'|'awaiting-receipt'|'expired';readExpiresAt?:number};
export type OwnerReadResult=z.infer<typeof taskOwnerReadResultV2Schema>&{expiresAt:number;readExpiresAt:number};
export type OwnerReadClient={prepare:()=>Promise<OwnerReadScope>;pending:()=>Promise<OwnerReadScope|null>;read:(scope:OwnerReadScope,options:{confirmed:true})=>Promise<OwnerReadResult>;close:()=>void};
export type OwnerReadProps={runtime:OwnerReadRuntime;taskId:string;connected:boolean};
function isOwnerObject(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
export function ownerObject(value:unknown):Record<string,unknown>|null{return isOwnerObject(value)?value:null;}
export const ownerText=(value:unknown)=>typeof value==='string'?value:'';
/** Original accepted event bytes are not re-parsed through a newer event schema. */
export function ownerRecordBody(payloadJson:string):Record<string,unknown>{
 const value:unknown=JSON.parse(payloadJson),payload=ownerObject(value);
 if(!payload)throw Error('本人原记录格式暂时无法读取。');
 return ownerObject(payload.event)??payload;
}
