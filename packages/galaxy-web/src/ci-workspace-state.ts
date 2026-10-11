import * as z from 'zod/v4';
import {ciRequestV2Schema,ciProofV2Schema} from '../../galaxy-official/src/shared/ci-observation-v2-schema.mjs';
import {evidenceReferenceRecordSchema} from '../../galaxy-official/src/shared/verification-record-schema.mjs';
import {errorField} from './task-operation-state';

export type CiRequest=z.infer<typeof ciRequestV2Schema>;
export type CiProof=z.infer<typeof ciProofV2Schema>;
export type CiInput={selected:string;resultId:string;visibility:'Private'|'Public'};
export type CiLocator={type:'request'|'proof';id:string;payloadHash:string};
export type CiResult={id:string;version:number;actorId:string;summary:string};
type EvidenceRecord=z.infer<typeof evidenceReferenceRecordSchema>;
export type CiEvidence={id:string;version:number;referenceStatus:string;record?:Pick<EvidenceRecord,'kind'|'reportedBy'|'evidenceType'|'source'|'summary'>|null};
const originalCommon={id:z.string().optional(),payloadHash:z.string(),visibility:z.enum(['Private','Public']),
 reason:z.string().nullable().optional(),blockedReason:z.string().nullable().optional(),expiresAt:z.number().nullable().optional(),
 originalExpiresAt:z.number().nullable().optional(),state:z.string().optional()};
const originalSchema=z.discriminatedUnion('type',[
 z.object({...originalCommon,type:z.literal('request'),payload:ciRequestV2Schema}),
 z.object({...originalCommon,type:z.literal('proof'),payload:ciProofV2Schema}),
]);
export type CiOriginal=z.infer<typeof originalSchema>;
export function readCiOriginal(value:unknown):CiOriginal {
 function isOriginal(raw:unknown):raw is CiOriginal{return originalSchema.safeParse(raw).success;}
 if(!isOriginal(value))throw Error('原 CI 内容或定位暂时无法读取。');
 return value;
}
const requestRefSchema=ciRequestV2Schema.pick({id:true,caseId:true,evidenceRef:true,resultRef:true});
const proofRefSchema=z.object({id:z.string(),requestId:z.string(),visibility:z.enum(['Private','Public'])});
const stoppedSchema=z.object({type:z.enum(['request','proof']),id:z.string(),payloadHash:z.string()});
const localSchema=z.object({requests:z.array(requestRefSchema),proofs:z.array(proofRefSchema),pending:originalSchema.nullable().optional(),stopped:z.array(stoppedSchema).optional()});
export type CiLocal=z.infer<typeof localSchema>;
export const readCiLocal=(value:unknown)=>localSchema.parse(value);
const observationSchema=z.object({conclusion:ciProofV2Schema.shape.conclusion.optional(),completed:z.boolean().optional(),collectedAt:z.number(),validUntil:z.number().optional()});
const viewSchema=z.object({state:z.string().optional(),status:z.string().optional(),synthetic:z.boolean().optional(),
 observation:observationSchema.nullable().optional(),data:ciProofV2Schema.optional()});
export type CiView=z.infer<typeof viewSchema>;
export function readCiView(value:unknown):CiView {
 function isView(raw:unknown):raw is CiView{return viewSchema.safeParse(raw).success;}
 if(!isView(value))throw Error('当前 CI 记录暂时无法完整读取。');
 // Keep the exact signed envelope available to the existing source detail.
 return value;
}
export function currentCiView(value:CiView|undefined,now:number):CiView|undefined {
 if(!value)return value;
 if(value.data&&value.data.expiresAt*1000<=now)return{status:'proof-expired'};
 if(value.observation?.validUntil&&value.observation.validUntil*1000<=now)return{...value,state:'stale',observation:null};
 return value;
}
export function ciReceiptDone(value:unknown):boolean {
 return typeof value==='object'&&value!==null&&'state' in value&&typeof value.state==='string'&&['recorded','acknowledged'].includes(value.state);
}
export function ciReason(value:unknown):string|null {
 return errorField(value,'reason')||errorField(value,'code')||null;
}
export function readCiReceipt(value:unknown) {return z.object({state:z.string(),payloadHash:z.string().optional()}).parse(value);}
export type CiPreview=
 |{kind:'request';payload:CiRequest;revision:string|null;sourceSummary:string;resultSummary:string}
 |{kind:'proof';payload:CiProof;requestId:string}
 |{kind:'recovery'|'stop-local';review:CiOriginal;continuation:'reauthorize'|'reuse'}
 |{kind:'revoke-request';id:string;source:CiRequest['source']|null;title?:string}
 |{kind:'revoke-proof';id:string;proof?:CiProof;visibility:'Private'|'Public'};
export function ciPreviewPayload(preview:CiPreview|null):CiRequest|CiProof|undefined {
 if(!preview)return;
 if(preview.kind==='request'||preview.kind==='proof')return preview.payload;
 if(preview.kind==='recovery'||preview.kind==='stop-local')return preview.review.payload;
}
export function ciRequestPreview(preview:CiPreview|null):CiRequest|undefined {
 if(preview?.kind==='request')return preview.payload;
 if((preview?.kind==='recovery'||preview?.kind==='stop-local')&&preview.review.type==='request')return preview.review.payload;
}
export function ciProofPreview(preview:CiPreview|null):CiProof|undefined {
 if(preview?.kind==='proof')return preview.payload;
 if((preview?.kind==='recovery'||preview?.kind==='stop-local')&&preview.review.type==='proof')return preview.review.payload;
}
