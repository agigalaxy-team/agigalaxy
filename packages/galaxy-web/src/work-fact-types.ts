import * as z from 'zod/v4';
import type {caseEventV2Schema} from '../../galaxy-official/src/shared/cases-schema.mjs';
import type {evidenceReferenceRecordSchema,verificationRecordSchema} from '../../galaxy-official/src/shared/verification-record-schema.mjs';
import {capsuleSourceV2Schema} from '../../galaxy-official/src/shared/capsule-v2-schema.mjs';
import {participationEventV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import type {CapsuleConfigurationView,CapsuleSourceItem} from './capsule-authoring-types';
import type {FactReference,InterventionOpinionsView,ResolutionDecision} from './work-fact-presentation-types';
import type {WorkTask,WorkParticipation} from './work-task-types';

type CaseEvent=z.infer<typeof caseEventV2Schema>;
type EvidenceRecord=z.infer<typeof evidenceReferenceRecordSchema>;
type VerificationRecord=z.infer<typeof verificationRecordSchema>;
export type WorkRecordType='evidence'|'verification';
export type WorkRecordLocator={type:WorkRecordType;id:string;version?:number};
export type WorkSourceRef=Extract<CaseEvent,{kind:'intervention'}>['sourceRefs'][number];
export type WorkFactBase=FactReference&{actorId:string;participationId:string|null;participationScopeVersion:number|null;scopeVersion:number;taskId?:string|null;reportedBy?:string|null;synthetic?:boolean|null};
export type WorkFactText={summary?:string;strategy?:string;description?:string;observedEffect?:string;limitations?:string|string[];failureReason?:string;reportedOutcome?:string;status?:string;types?:string[];affectsAttemptIds?:string[];sourceRefs?:WorkSourceRef[];deliverableRefs?:WorkSourceRef[];origin?:{kind:'attempt'|'intervention';id:string;version:number}};
export type WorkAttempt=WorkFactBase&WorkFactText&{strategy:string;status:string;inputScopeSummary?:string;permissionScope?:string[];environment?:string|{name:string;version:string};configurationCondition?:Partial<CapsuleConfigurationView>&{sourceStatus:string}};
export type WorkIntervention=WorkFactBase&WorkFactText&InterventionOpinionsView&{description:string;types:string[];sourceRefs:WorkSourceRef[]};
export type WorkResult=WorkFactBase&WorkFactText&{summary:string;reportedOutcome:string;origin:{kind:'attempt'|'intervention';id:string;version:number};deliverableRefs:WorkSourceRef[]};
export type WorkFacts={caseId:string;version:number;scopeVersion:number;synthetic:boolean|null;attempts:WorkAttempt[];interventions:WorkIntervention[];results:WorkResult[];resolution:ResolutionDecision;resolutions:(ResolutionDecision&{verificationRefs:FactReference[]})[];coverage:{complete:boolean}};
export type WorkRecordBody={
 kind:'evidence'|'verification'|'revoke';caseId:string;reportedBy:string;participationId?:string|null;synthetic:boolean;summary?:string;
 source?:EvidenceRecord['source'];evidenceType?:EvidenceRecord['evidenceType'];reportedSourceState?:EvidenceRecord['reportedSourceState'];
 method?:VerificationRecord['method'];scope?:string;conditions?:VerificationRecord['conditions'];observation?:VerificationRecord['observation'];
 relationship?:VerificationRecord['relationship'];target?:VerificationRecord['target'];evidenceRefs?:FactReference[];
};
export type WorkRecordReading=WorkRecordLocator&{version?:number;currentVersion?:number;currentState?:string;synthetic?:boolean;referenceStatus:string;record:WorkRecordBody|null;reason?:string};
export type WorkRecordView=WorkRecordReading&{version:number};
export type WorkEditorTarget=FactReference&WorkFactText&{actorId?:string;scopeVersion?:number;type?:WorkRecordType;currentVersion?:number;synthetic?:boolean|null;record?:WorkRecordBody|null};
export const isWorkRecordView=(value:WorkRecordReading):value is WorkRecordView=>typeof value.version==='number';
export function isWorkEvidence(value:WorkRecordReading):value is WorkRecordView&{record:WorkRecordBody&Pick<EvidenceRecord,'kind'|'source'|'evidenceType'|'summary'>}{
 return isWorkRecordView(value)&&value.record?.kind==='evidence'&&!!value.record.source&&!!value.record.evidenceType&&typeof value.record.summary==='string';
}
export type WorkViewAuthority={check:()=>void;isCurrent:()=>boolean};
export type WorkFactActionKind='attempt-start'|'attempt-end'|'attempt-correct'|'intervention'|'intervention-response'|'result-recorded'|'resolution-recorded'|'evidence'|'verification'|'revoke'|'deliver';
export type WorkFactAction={kind:WorkFactActionKind;target?:WorkEditorTarget;authority?:WorkViewAuthority;pendingOperation?:{taskId:string;participationId:string;eventId:string;payloadHash:string}};
export type WorkFactPending={kind:'case-link'|'fact'|'verification';taskId:string;caseId:string;operationId:string;payloadHash:string;state:string;localRetryStopped?:boolean;receiptState?:string};
export type WorkFactReceipt=Partial<WorkFactPending>&{state?:string;reason?:string;caseVersion?:number;type?:WorkRecordType;id?:string};
export type WorkFactRetry=WorkFactPending&{state:'absent';previewId:string;expiresAt:number;subjectId:string;endpoint:string;visibility:'Private';viewers:string[];items:{action:string;objectId:string;payloadJson:string;payloadHash:string}[]};
export const workFormBlank = {
  summary: '',
  strategy: '',
  environment: '',
  environmentVersion: '',
  inputScope: '',
  permissionScope: '',
  description: '',
  observedEffect: '',
  failureReason: '',
  limitations: '',
  reason: '',
  status: 'completed',
  outcome: 'inconclusive',
  type: 'diagnosis',
  resultChoice: '',
  sourceChoice: '',
  scope: '',
  conditions: '',
  command: '',
  method: 'participant-feedback',
  observation: 'comment',
  relationship: 'unknown',
  satisfied: '',
  remaining: '',
  resolution: 'unresolved',
  caseSummary: '',
  synthetic: false,
  evidenceType: 'self-assertion',
  originSystem: '',
  externalStableId: '',
  contentVersion: '',
  uri: '',
  issuer: '',
  originalAt: '',
  observedAt: '',
  sourceState: 'unknown',
  ciOwner: '',
  ciRepository: '',
  ciRunId: '',
  ciAttempt: '1',
  ciCommit: '',
};
export type WorkForm=typeof workFormBlank;
export type WorkTextField=Exclude<keyof WorkForm,'synthetic'>;
export type WorkComposeValue={ui:'work-editor-v1';kind:WorkFactActionKind;targetRef:(FactReference&{type:WorkRecordType|null})|null;participationId:string;participationScopeVersion:number|null;form:WorkForm;viewers:string[];related:string[];recordSelected:string[];configurationConditions:CapsuleSourceItem[];configurationSources:CapsuleSourceItem[]};
export type WorkComposeDraft={value:WorkComposeValue;revision:string|null;participationId?:string;operationId?:string|null;eventId?:string|null;submission?:string};
export type WorkWriteOptions={confirmed:boolean;viewers:string[];composeRevision?:string;caseSummary?:string;synthetic?:boolean};
export type WorkFactClient={
 readCase:(task:Pick<WorkTask,'taskId'|'caseId'>)=>Promise<WorkFacts|null>;
 readRecord:(ref:WorkRecordLocator)=>Promise<WorkRecordView>;
 discoverRecordRefs:(task:Pick<WorkTask,'taskId'|'caseId'>)=>Promise<{refs:WorkRecordLocator[]}>;
 pending:(taskId:string)=>Promise<WorkFactPending|null>;
 reconcile:(taskId:string)=>Promise<WorkFactReceipt>;
 resumePending:(taskId:string)=>Promise<WorkFactReceipt>;
 prepareRetry:(taskId:string)=>Promise<WorkFactRetry|WorkFactReceipt>;
 confirmRetry:(preview:WorkFactRetry,options:{confirmed:true})=>Promise<WorkFactReceipt>;
 stopRetry:(taskId:string,options:{confirmed:true})=>Promise<WorkFactReceipt>;
 readComposeDraft:(taskId:string)=>Promise<unknown>;
 saveComposeDraft:(taskId:string,input:WorkComposeValue,options:{expectedRevision:string|null})=>Promise<unknown>;
 clearComposeDraft:(taskId:string,options:{revision:string})=>Promise<unknown>;
 submitFact:(task:WorkTask,facts:WorkFacts|null,participant:WorkParticipation|null,fields:Record<string,unknown>,options:WorkWriteOptions)=>Promise<WorkFactReceipt>;
 submitRecord:(task:WorkTask,facts:WorkFacts|null,participant:WorkParticipation|null,fields:Record<string,unknown>,options:WorkWriteOptions)=>Promise<WorkFactReceipt>;
};
const composeKind=z.enum(['attempt-start','attempt-end','attempt-correct','intervention','intervention-response','result-recorded','resolution-recorded','evidence','verification','revoke','deliver']);
const formFields=z.object({
 summary:z.string(),strategy:z.string(),environment:z.string(),environmentVersion:z.string(),inputScope:z.string(),permissionScope:z.string(),description:z.string(),observedEffect:z.string(),failureReason:z.string(),limitations:z.string(),reason:z.string(),
 status:z.string(),outcome:z.string(),type:z.string(),resultChoice:z.string(),sourceChoice:z.string(),scope:z.string(),conditions:z.string(),command:z.string(),method:z.string(),observation:z.string(),relationship:z.string(),satisfied:z.string(),remaining:z.string(),resolution:z.string(),caseSummary:z.string(),synthetic:z.boolean(),
 evidenceType:z.string(),originSystem:z.string(),externalStableId:z.string(),contentVersion:z.string(),uri:z.string(),issuer:z.string(),originalAt:z.string(),observedAt:z.string(),sourceState:z.string(),ciOwner:z.string(),ciRepository:z.string(),ciRunId:z.string(),ciAttempt:z.string(),ciCommit:z.string(),
}).partial();
const selectedConfiguration=z.looseObject({ref:capsuleSourceV2Schema,label:z.string().optional()});
const composeValue=z.object({ui:z.literal('work-editor-v1'),kind:composeKind,targetRef:z.object({id:z.string(),version:z.number(),type:z.enum(['evidence','verification']).nullable().default(null)}).nullable().default(null),
 participationId:z.string().default(''),participationScopeVersion:z.number().nullable().default(null),form:formFields,
 viewers:z.array(z.string()).default([]),related:z.array(z.string()).default([]),recordSelected:z.array(z.string()).default([]),configurationConditions:z.array(selectedConfiguration).default([]),configurationSources:z.array(selectedConfiguration).default([]),
});
const composeRecord=z.object({value:composeValue,revision:z.string().nullable(),participationId:z.string().optional(),operationId:z.string().nullable().optional(),eventId:z.string().nullable().optional(),submission:z.string().optional()});
export function readWorkCompose(value:unknown):WorkComposeDraft|null{
 if(value==null)return null;
 const saved=composeRecord.safeParse(value);
 if(!saved.success)throw Error('本机编写稿格式当前无法读取，原记录已保留。');
 return {...saved.data,value:{...saved.data.value,form:{...workFormBlank,...saved.data.value.form}}};
}
export function requireWorkCompose(value:unknown):WorkComposeDraft{
 const saved=readWorkCompose(value);if(!saved)throw Error('本机编写稿尚未保存，原输入仍在。');return saved;
}
const locator=z.object({id:z.string(),type:z.enum(['evidence','verification']),version:z.number().optional()});
export function readWorkRecordLocators(value:unknown):WorkRecordLocator[]{return value==null?[]:z.array(locator).parse(value);}
export function recordText(value:string|number|boolean|null|undefined){return value==null?'':String(value);}
const queuedParticipation=z.object({taskId:z.string(),path:z.string(),eventId:z.string(),payloadHash:z.string(),payloadJson:z.string()});
export function readQueuedParticipation(value:unknown){
 const queued=queuedParticipation.safeParse(value);if(!queued.success)return null;
 let raw:unknown;try{raw=JSON.parse(queued.data.payloadJson);}catch{return null;}
 const payload=participationEventV2Schema.safeParse(raw);return payload.success?{...queued.data,payload:payload.data}:null;
}
