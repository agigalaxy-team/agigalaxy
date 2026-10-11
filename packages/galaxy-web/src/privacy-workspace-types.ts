import type * as z from 'zod/v4';
import type {createWebRuntime} from './runtime.mjs';
import type {deletionIntentSchema} from '../../galaxy-official/src/shared/deletion-schema.mjs';
import type {exportViewSchema} from '../../galaxy-official/src/shared/data-export-schema.mjs';

export type PrivacyRuntime=Awaited<ReturnType<typeof createWebRuntime>>;
export type ExportView=z.infer<typeof exportViewSchema>&{title?:string};
export type ExportSpecification={datasets:string[];viewKinds:string[]};
export type ExportTicket={id:string;expiresAt:number;datasets:string[];views:z.infer<typeof exportViewSchema>[]};
export type ExportState={state:'none'|'stopped-local'|'unacknowledged'|'expired'|'ready';ticket?:ExportTicket;reason?:'original-binding-changed'|'ticket-result-unknown'};
export type ExportProgress={rows:number;pages:number;bytes?:number};
/** The original manifest is retained in full when downloaded, including unknown future metadata. */
export type ExportDownload={content:string;manifest:{complete:boolean;[field:string]:unknown};manifestSha256:string};
export type DeletionStore={state:string;until?:number};
export type DeletionEvent={id:string;kind:string;created_at:string;payload_minimized?:boolean;retained_payload?:unknown;payload_text?:string};
/** Current receipt projection from deletion.mjs; optional details are present only on the corresponding read. */
export type DeletionReceipt={id:string;revision:number;state:string;updatedAt:string;physicalDeletionPerformed:boolean;events?:DeletionEvent[];nextAfterRevision?:number|null;execution?:{
 primary:DeletionStore;audit:DeletionStore;backups:DeletionStore;externalCopies:DeletionStore;delegatedStores?:{chat?:DeletionStore};
}|null};
export type SavedDeletionReceipt={requestId:string;state:string;checkedAt:number};
export type DeletionPreview={intent:z.infer<typeof deletionIntentSchema>;payloadJson:string;deviceId:string};
export type DeletionOperation=DeletionPreview&{signed:string;payloadHash:string;state:string};
export type DeletionRenewal=DeletionPreview&{previousHash:string};
export type DeletionResume=DeletionReceipt|{state:'none';id?:never}|{state:'unacknowledged';id:string};
export function deletionEventText(event:DeletionEvent):{reason?:string;note?:string}{
 let value:unknown;
 try{value=event.payload_minimized?event.retained_payload:JSON.parse(event.payload_text??'{}');}catch{return {};}
 if(!value||typeof value!=='object')return {};
 return {reason:'reason' in value&&typeof value.reason==='string'?value.reason:undefined,note:'note' in value&&typeof value.note==='string'?value.note:undefined};
}
