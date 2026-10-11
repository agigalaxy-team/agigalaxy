import type * as z from 'zod/v4';
import type {createWebRuntime} from './runtime.mjs';
import type {contextGrantV2Schema,contextEventV2Schema,contextReceiptV2Schema} from '../../galaxy-official/src/shared/context-v2-schema.mjs';
import type {contributionPublicationSchema,contributionSourceRefSchema,contributionOwnedSourcesSchema,contributionPreviewSchema} from '../../galaxy-official/src/shared/contribution-sharing-v2-schema.mjs';
import type {historyV2QuerySchema} from '../../galaxy-official/src/shared/history-v2-schema.mjs';

export type RecordRuntime=Awaited<ReturnType<typeof createWebRuntime>>;
export type RecordLease=ReturnType<RecordRuntime['receiptStatus']['captureLease']>;
export type ContextGrant=z.infer<typeof contextGrantV2Schema>;
export type ContextEvent=z.infer<typeof contextEventV2Schema>;
export type ContextPayload=ContextGrant|ContextEvent;
export type ContextReceiptLocator=z.infer<typeof contextReceiptV2Schema>;
export type ContextMaterialInput={id:string;label:string;content:string;mediaType?:unknown};
export type ContextComposeInput={materials:ContextMaterialInput[];selected:string[];minutes:string;step:number};
export type ContextComposeDraft={version:1;revision:string;value:ContextComposeInput;attempt?:ContextReceiptLocator[]|null};
export type ContextParticipation={participationId:string;subjectId:string;state:string;role:string;scopeAvailable?:boolean;agreedScope?:string|null;scopeEventId?:string|null;scopeVersion:number};
export type ContextTask={taskId:string;requesterId:string;state:string;version:number;participations?:ContextParticipation[]};
export type ContextMetadata={schemaVersion:2;grantId:string;taskId:string;participationId:string;ownerId:string;participantId:string;scopeVersion:number;scopeEventId:string;materialsHash:string;expiresAt:number;createdAt:number};
export type ContextMaterial={id:string;label:string;mediaType:'text/plain';contentHash:string;content?:string};
export type ContextView={metadata:ContextMetadata;state:string;materials:ContextMaterial[];contextAccessGranted:boolean};
export type ContextPrepared={endpoint:string;subjectId:string;operationId:string;grantId:string;kind:'grant'|ContextEvent['kind'];payload:ContextPayload;recipientId:string;expiresAt:number;payloadHash:string};
export type ContextPending={operationId:string;grantId:string;taskId:string;participationId:string;kind:'grant'|ContextEvent['kind'];state:string;payloadHash:string;recipientId:string};
export type ContextReceipt={grantId:string;eventId:string;payloadHash?:string;state:'absent'|'acknowledged'|'conflict'|'recorded-awaiting-recipient-acceptance'|'accepted'|'declined'|'revoked';reason?:string};
export type ContextRenewal={state:'reauthorization-required';operationId:string;grantId:string;consentId:string|null;payloadHash:string;payload:ContextPayload;recipientId:string;expiresAt:number};
export type ContextReview=ContextRenewal|ContextReceipt|{state:'stopped-local'|'retry-original';operationId:string};
export type ContextClient={
 prepareGrant:(input:unknown)=>Promise<ContextPrepared>;
 prepareEvent:(kind:ContextEvent['kind'],metadata:ContextMetadata)=>Promise<ContextPrepared>;
 execute:(preview:ContextPrepared,options:{confirmed:boolean})=>Promise<ContextReceipt>;
 query:(input:{taskId:string;after?:string;limit:number})=>Promise<{items:ContextView[];nextAfter:string|null}>;
 get:(grantId:string,options?:{metadataOnly?:boolean})=>Promise<ContextView>;
 pending:()=>Promise<ContextPending[]>;
 resumePending:(operationId:string)=>Promise<ContextReceipt>;
 reconcile:(operationId:string)=>Promise<ContextReceipt>;
 retry:(operationId:string,options:{confirmed:boolean})=>Promise<ContextReceipt>;
 reviewAuthorization:(operationId:string)=>Promise<ContextReview>;
 reauthorize:(operationId:string,preview:ContextRenewal,options:{confirmed:boolean})=>Promise<ContextReceipt>;
 abandon:(operationId:string,options:{confirmed:boolean})=>Promise<unknown>;
};
export type ContextGrantChoice={prepared:ContextPrepared;payload:Omit<ContextGrant,'materials'>&{materials:ContextMaterialInput[]};recipient:ContextParticipation;metadata?:never;materials?:never};
export type ContextEventChoice={prepared:ContextPrepared;metadata:ContextMetadata;materials:ContextMaterial[];payload?:never;recipient?:never};
export type ContextPreview={kind:'grants';drafts:ContextGrantChoice[];draftRevision:string|null}|{kind:ContextEvent['kind'];drafts:ContextEventChoice[];draftRevision?:never};

export type HistoryQuery=z.infer<typeof historyV2QuerySchema>;
/** Fields consumed here; the full currently authorized record still reaches HistoryFacts. */
export type HistoryRecord={kind:'case-history'|'task-history';key:string;taskId?:string;caseId?:string|null;title:string|null;summary:string|null;subjectRoles:string[];activityTimes:string[];synthetic?:boolean};
export type HistoryPage={items:HistoryRecord[];nextCursor:string|null;restarted?:boolean};
export type HistoryClient={query:(input:HistoryQuery)=>Promise<HistoryPage>;more:(input:HistoryQuery)=>Promise<HistoryPage>;close:()=>void};

export type ContributionPublication=z.infer<typeof contributionPublicationSchema>;
export type ContributionSelection=(Omit<Extract<ContributionPublication,{kind:'publish'}>,'id'>|Omit<Extract<ContributionPublication,{kind:'revoke'}>,'id'>)&{id?:string};
export type ContributionSource=z.infer<typeof contributionSourceRefSchema>;
export type ContributionCursor=Pick<z.infer<typeof contributionOwnedSourcesSchema>,'kind'|'parentId'|'after'>;
export type ContributionPurpose=z.infer<typeof contributionPreviewSchema>['purposes'][number];
export type ContributionSelectedRef=z.infer<typeof contributionPreviewSchema>['sourceRefs'][number];
export type ContributionProjection={eventType?:string;actorId?:string;role?:string|null;interventionTypes?:string[]|null;scopeVersion?:number|null;reportedOutcome?:string|null;feedback?:{descriptionClarity:string;scopeMatched:boolean}|null;scope?:string|null;title?:string|null;summary?:string|null;time?:string|null;caseId?:string|null;taskId?:string|null;participationId?:string|null};
export type ContributionSourceItem={source:ContributionSource;eventType:string;availableFields:ContributionSelectedRef['fields'];projection?:ContributionProjection};
export type ContributionSourcesPage={items:ContributionSourceItem[];nextAfter:string|null};
export type ContributionPreviewData={items:{ref:ContributionSource;projection:ContributionProjection}[]};
export type ContributionStatus={publicationId:string;state:string;sourceRefs?:ContributionSelectedRef[];purposes?:ContributionPurpose[];expiresAt?:string|null};
export type ContributionReceipt={state:string;operationId?:string;publicationId?:string;exactOperationConfirmed?:boolean};
export type ContributionPending={payload:ContributionPublication;payloadJson:string;payloadHash:string;authorizationExpiresAt:number|null;canStartNewSelection:boolean;blockedReason?:string|null};
export type ContributionLocal={pending:ContributionPending|null};
export type ContributionPrevious={operationId:string;publicationId:string;kind:'publish'|'revoke';receiptState?:string;exactOperationConfirmed?:boolean};
export type ContributionClient={
 local:()=>Promise<ContributionLocal>;
 refresh:()=>Promise<ContributionStatus[]>;
 resumePending:()=>Promise<ContributionReceipt>;
 reconcile:(options?:{retry?:boolean;reauthorize?:boolean;confirmed?:boolean;expectedOperationId?:string;expectedPayloadHash?:string})=>Promise<ContributionReceipt>;
 submit:(input:ContributionSelection,options:{confirmed:boolean})=>Promise<ContributionReceipt>;
 previousOperations:()=>Promise<ContributionPrevious[]>;
 reconcilePrevious:(operationId:string)=>Promise<ContributionReceipt>;
};
export type ContributionWork={taskId?:string;caseId?:string|null;title?:string|null;request?:{title:string};kind?:'case-history'|'task-history'};
export type ContributionWorkView='requested'|'participating'|'history';
export type ContributionWorksPage={items:ContributionWork[];nextAfter?:string|null};
export type ContributionPreview={payload:ContributionSelection;data:ContributionPreviewData;original?:{id:string;payloadJson:string;payloadHash:string;deadline:number|null;lease:RecordLease}};
export type RequesterFact={source:ContributionSource;projection:ContributionProjection;feedbackState?:'current'|'superseded'};
export type RequesterRecord={id:string;source:ContributionSource;projection:ContributionProjection;facts:RequesterFact[];counts:{acceptances:number;currentFeedback:number};nextAfter?:string|null};
export type RequesterPage={items:RequesterRecord[];nextAfter:string|null};

export function recordErrorField(error:unknown,field:string){
 if(typeof error!=='object'||error===null||!(field in error))return '';
 const value:unknown=Reflect.get(error,field);return typeof value==='string'?value:'';
}
function object(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null;}
function material(value:unknown):value is ContextMaterialInput{return object(value)&&typeof value.id==='string'&&typeof value.label==='string'&&typeof value.content==='string';}
function locator(value:unknown):value is ContextReceiptLocator{return object(value)&&typeof value.grantId==='string'&&typeof value.eventId==='string'&&typeof value.payloadHash==='string';}
function draft(value:unknown):value is ContextComposeDraft{
 if(!object(value)||value.version!==1||typeof value.revision!=='string'||!object(value.value))return false;
 const input=value.value;return Array.isArray(input.materials)&&input.materials.length<=8&&input.materials.every(material)
  &&Array.isArray(input.selected)&&input.selected.every(id=>typeof id==='string')&&typeof input.minutes==='string'&&(input.step===0||input.step===1)
  &&(value.attempt==null||Array.isArray(value.attempt)&&value.attempt.every(locator));
}
/** Validate the old local shape without rebuilding or reordering its bytes. */
export function checkedContextDraft(value:unknown){
 if(value==null)return null;if(!draft(value))throw Error('这份材料草稿暂时无法读取，请保留本页输入。');return value;
}
