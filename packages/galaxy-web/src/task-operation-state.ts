import * as z from 'zod/v4';
import type {createWebRuntime} from './runtime.mjs';
import {participationEventV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';

export type OperationRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,
 'api'|'receiptStatus'|'getLocal'|'putLocal'|'updateLocal'|'participationEvent'|'resumeTaskEvent'|'resumePublication'|
 'reviewTaskAuthorization'|'reauthorizeTaskOperation'|'reviewTaskStop'|'stopTaskOperation'|'stoppedTaskOperations'|'queryStoppedTaskOperation'>;

export function errorField(value:unknown,key:'code'|'message'|'reason'):string {
 if(typeof value!=='object'||value===null||!(key in value))return '';
 const field=Reflect.get(value,key);return typeof field==='string'?field:'';
}
export function operationSessionKey(runtime:Pick<OperationRuntime,'api'>,subjectId:string|undefined,connected:boolean,...ids:(string|null)[]) {
 const binding=runtime.api.snapshot();
 return JSON.stringify([runtime.api.endpoint,subjectId,connected,binding?.subjectId,binding?.bindingId,binding?.generation,...ids]);
}

const locatorSchema=z.object({taskId:z.string(),eventId:z.string(),payloadHash:z.string()});
const receiptSchema=z.object({state:z.string().optional(),taskId:z.string().optional(),eventId:z.string().optional(),payloadHash:z.string().optional(),
 participationId:z.string().optional(),kind:z.string().optional(),reason:z.string().nullable().optional(),
 result:z.object({taskId:z.string().optional()}).optional(),localDraftCleanup:z.object({state:z.string()}).optional()});
export type OperationReceipt=z.infer<typeof receiptSchema>;
export function readOperationReceipt(value:unknown):OperationReceipt {
 function isReceipt(raw:unknown):raw is OperationReceipt{return receiptSchema.safeParse(raw).success;}
 if(!isReceipt(value))throw Error('原操作的接收结果暂时无法读取。');
 return value;
}
const pendingSchema=z.object({payloadJson:z.string(),payloadHash:z.string(),eventId:z.string().optional(),taskId:z.string().optional(),state:z.string().optional()});
export const readPendingOperation=(value:unknown)=>value===null||value===undefined?null:pendingSchema.parse(value);
const receiptStatusSchema=z.object({state:z.string(),checkedAt:z.number().optional(),version:z.number().optional(),participationVersion:z.number().optional()});
const stoppedSchema=locatorSchema.extend({kind:z.string(),state:z.literal('stopped-local'),receipt:receiptStatusSchema,
 stoppedAt:z.number().optional(),serverCancellationConfirmed:z.literal(false).optional()});
export type StoppedOperation=z.infer<typeof stoppedSchema>;
export const readStoppedOperations=(value:unknown)=>z.array(stoppedSchema).parse(value);
export const readStoppedOperation=(value:unknown)=>stoppedSchema.parse(value);
const stopPreviewSchema=locatorSchema.extend({state:z.literal('stop-local-preview'),kind:z.string(),receipt:receiptStatusSchema,
 serverCancellationConfirmed:z.literal(false)});
export type StopPreview=z.infer<typeof stopPreviewSchema>;
export const readStopPreview=(value:unknown)=>stopPreviewSchema.parse(value);
const authorizationPreviewSchema=locatorSchema.extend({state:z.literal('reauthorization-required'),consentId:z.string().nullable(),
 payload:z.unknown(),visibility:z.enum(['Private','Public']),viewers:z.array(z.string()),expiresAt:z.number(),action:z.string(),objectId:z.string()});
export type OperationAuthorizationPreview=z.infer<typeof authorizationPreviewSchema>;
export const readAuthorizationPreview=(value:unknown)=>authorizationPreviewSchema.parse(value);

export type FeedbackEvent=Extract<z.infer<typeof participationEventV2Schema>,{kind:'requester-feedback'}>;
export type FeedbackRecord=Pick<FeedbackEvent,'eventId'|'descriptionClarity'|'scopeMatched'|'note'|'supersedes'|'reason'>;
export type FeedbackParticipant={subjectId:string;participationId:string;version:number;confirmedAt:number|null;state:string;feedback?:FeedbackRecord|null};
export type FeedbackTask={taskId:string;state:string;requesterId:string};
export type FeedbackInput={descriptionClarity:string;scopeMatched:string;note:string;reason:string;baseFeedbackId:string|null;editing:boolean};
export type FeedbackLocator={taskId:string;participationId:string;eventId:string;payloadHash:string;kind:'requester-feedback'};
const feedbackEventSchema=z.custom<FeedbackEvent>(value=>{const parsed=participationEventV2Schema.safeParse(value);return parsed.success&&parsed.data.kind==='requester-feedback';});
const feedbackPendingSchema=locatorSchema.extend({participationId:z.string(),kind:z.literal('requester-feedback'),payloadJson:z.string(),
 payload:feedbackEventSchema,event:feedbackEventSchema,visibility:z.literal('Private'),viewers:z.array(z.string()),expiresAt:z.number().optional(),
 state:z.string().optional(),reason:z.string().nullable().optional(),originalExpiresAt:z.number().optional(),canContinue:z.boolean().optional()});
export type FeedbackPending=z.infer<typeof feedbackPendingSchema>;
export function readFeedbackPending(value:unknown):FeedbackPending|null {
 if(value===null||value===undefined)return null;
 // Authorization reviews are WeakMap keys: validate without cloning the object.
 function isPending(raw:unknown):raw is FeedbackPending{return feedbackPendingSchema.safeParse(raw).success;}
 if(!isPending(value))throw Error('原反馈的内容或定位暂时无法读取。');
 return value;
}
export function readFeedbackLocator(value:unknown):FeedbackLocator {
 return locatorSchema.extend({participationId:z.string(),kind:z.literal('requester-feedback')}).parse(value);
}

function fields(value:unknown):Record<string,unknown> {
 if(typeof value!=='object'||value===null||Array.isArray(value))return {};
 return Object.fromEntries(Object.entries(value));
}
export function submittedContent(payload:unknown) {
 const outer=fields(payload),body=fields(outer.event??payload),context=fields(body.workContext);
 const strings=[body.title,body.proposal,body.summary,context.goal,context.currentSituation,body.expectedOutcome,body.agreedScope,body.scope,body.note,body.message,body.reason];
 const texts=strings.filter((value):value is string=>typeof value==='string'&&value.length>0);
 return {kind:typeof body.kind==='string'?body.kind:'publish-task',texts:[...new Set(texts)],
  enrollmentExpiresAt:typeof body.enrollmentExpiresAt==='number'?body.enrollmentExpiresAt:null,
  expiresAt:typeof body.expiresAt==='number'?body.expiresAt:null};
}
