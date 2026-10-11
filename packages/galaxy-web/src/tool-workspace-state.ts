import type {z} from 'zod/v4';
import type {createWebRuntime} from './runtime.mjs';
import {configurationEventV2Schema} from '../../galaxy-official/src/shared/configuration-v2-schema.mjs';
import type {configurationConditionsSchema} from '../../galaxy-official/src/shared/configuration-v2-schema.mjs';
import {packUseEventSchema} from '../../galaxy-official/src/shared/worker-pack-uses-v2-schema.mjs';
import {createConfigurationClient} from './configuration-client.mjs';
import {createWorkerPackUseClient} from './worker-pack-use-client.mjs';
import type {caseEventV2Schema} from '../../galaxy-official/src/shared/cases-schema.mjs';
import type {evidenceReferenceRecordSchema,verificationRecordSchema} from '../../galaxy-official/src/shared/verification-record-schema.mjs';
import type {WorkerPack} from './builder-authoring-state';
import type {BuilderDirectoryRow} from './builder-workspace-state';
import type {InterventionOpinionsView,ResolutionDecision} from './work-fact-presentation-types';

export type ToolRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'status'|'receiptStatus'|'getLocal'|'putLocal'|'updateLocal'>;
export type ConfigurationEvent=z.infer<typeof configurationEventV2Schema>;
export type ConfigurationRecord=Extract<ConfigurationEvent,{kind:'record'}>;
export type ConfigurationConditions=z.infer<typeof configurationConditionsSchema>;
export type ConfigurationView={id:string;version:number;subjectId:string;sourceStatus:string;record:ConfigurationRecord|null;contentAvailable:boolean;management?:{version:number;state:string};disclosure?:{visibility:'Private'|'Public';viewers:string[]}};
export type VersionRef={id:string;version:number};
export type PackUseEvent=z.infer<typeof packUseEventSchema>;
export type PackUseRecord=Extract<PackUseEvent,{kind:'record'}>;
export type ToolPayload=ConfigurationEvent|PackUseEvent;
export type ToolReceipt={state:string;operationId?:string;id?:string;version?:number;reason?:string};
export type ToolLocator={family:'configuration'|'worker-pack';operationId:string;payloadHash:string;id:string};
export type ToolPending={operationId:string;type:string;state:string};
export type ToolPrepared<P>={operationId:string;payloadHash:string;payload:P};
export type ToolOriginal<P>=ToolPrepared<P>&{visibility:'Private'|'Public';viewers:string[];expiresAt:number|null;localRetryStopped?:false};
export type ToolStopped={operationId:string;localRetryStopped:true;canContinue:false};
export type ToolAuthorization<P>=ToolPrepared<P>&{state:'reauthorization-required';visibility:'Private'|'Public';viewers:string[];expiresAt:number;originalExpiresAt:number|null};
export type ToolAuthorizationResult<P>=ToolAuthorization<P>|ToolReceipt;
export type ToolJournalClient<P>={
 pending:()=>Promise<ToolPending[]>;
 receiptFor:(locator:{operationId:string;payloadHash:string})=>Promise<ToolReceipt>;
 prepare:(payload:P,scope:{visibility:'Private'|'Public';viewers?:string[]})=>Promise<ToolPrepared<P>>;
 execute:(prepared:ToolPrepared<P>,options:{confirmed:true;onJournal?:()=>Promise<void>})=>Promise<ToolReceipt>;
 reconcile:(operationId:string)=>Promise<ToolReceipt>;
 reviewPending:(operationId:string)=>Promise<ToolOriginal<P>|ToolStopped>;
 reviewAuthorization:(operationId:string)=>Promise<ToolAuthorizationResult<P>>;
 reauthorize:(operationId:string,preview:unknown,options:{confirmed:true})=>Promise<ToolReceipt>;
 retry:(operationId:string,options:{confirmed:true})=>Promise<ToolReceipt>;
 resumePending:()=>Promise<ToolReceipt>;
 stopLocalRetry:(operationId:string,options:{confirmed:true})=>Promise<ToolReceipt>;
};
export function toolAuthorization<P>(value:ToolAuthorizationResult<P>):value is ToolAuthorization<P>{return value.state==='reauthorization-required'&&'payload'in value&&'viewers'in value&&'expiresAt'in value;}
export function toolReceiptId(receipt:ToolReceipt):string{if(!receipt.id)throw Error('原保存结果没有准确记录位置，请保留原操作。');return receipt.id;}
export function toolErrorField(error:unknown,key:string):string{const value=typeof error==='object'&&error!==null?Reflect.get(error,key):undefined;return typeof value==='string'?value:'';}
export const conditionPairs=[['model','模型'],['runtime','运行方式'],['environment','系统环境']] as const;
export const componentPairs=[['tools','工具'],['skills','Skill'],['mcp','MCP']] as const;
export type ConfigurationComponent=ConfigurationConditions['tools'][number];
export type ConfigurationInput={title:string;summary:string;modelName:string;modelVersion:string;runtimeName:string;runtimeVersion:string;environmentName:string;environmentVersion:string;
 tools:ConfigurationComponent[];skills:ConfigurationComponent[];mcp:ConfigurationComponent[];promptPolicyVersion:string;rulesVersion:string;operationScope:string;inputScopeSummary:string;contentFingerprint:string;limitations:string;
 observedAt:string;synthetic:boolean;visibility:'Private'|'Public';viewers:string[];expectedVersion:number;sections:string[]};
export type ConfigurationTextField={[K in keyof ConfigurationInput]:ConfigurationInput[K] extends string?K:never}[keyof ConfigurationInput];
export type ConfigurationLegacy={mode?:string;form?:Partial<Omit<ConfigurationInput,'tools'|'skills'|'mcp'>>&{tools?:string|ConfigurationComponent[];skills?:string|ConfigurationComponent[];mcp?:string|ConfigurationComponent[]};detail?:ConfigurationView;visibility?:'Private'|'Public';viewers?:string[]};
export type ConfigurationClient=ToolJournalClient<ConfigurationEvent>&{
 get:(input:{id:string;version?:number})=>Promise<ConfigurationView>;
 query:(input:{subjectId?:string;limit:number;after?:string})=>Promise<{items:ConfigurationView[];nextAfter:string|null}>;
 versions:(input:{id:string;afterVersion:number;limit:number})=>Promise<{id:string;items:ConfigurationView[];nextAfterVersion:number|null}>;
 loadDraft:()=>Promise<ConfigurationLegacy|null>;
};
export type ToolContact={state:string;initiatorId:string;recipientId:string};
export type ToolContactsPage={items:ToolContact[];nextAfter:string|null};
type CaseEvent=z.infer<typeof caseEventV2Schema>;
type CaseFact=VersionRef&{actorId:string;taskId?:string|null;reportedBy?:string|null;provenance?:string};
export type ToolAttempt=CaseFact&Pick<Extract<CaseEvent,{kind:'attempt-start'}>,'strategy'>&{status:string;configurationRef:VersionRef|null;configurationCondition?:ConfigurationView|null};
export type ToolCandidateAttempt=ToolAttempt&{configurationRef:VersionRef;configurationCondition:ConfigurationView&{record:ConfigurationRecord}};
export type ToolResult=CaseFact&Pick<Extract<CaseEvent,{kind:'result-recorded'}>,'origin'|'summary'|'reportedOutcome'>;
export type ToolEvidence=VersionRef&{record:z.infer<typeof evidenceReferenceRecordSchema>|null};
export type ToolVerification=VersionRef&{record:z.infer<typeof verificationRecordSchema>|null};
export type ToolIntervention=CaseFact&Pick<Extract<CaseEvent,{kind:'intervention'}>,'description'>&InterventionOpinionsView;
export type ToolCaseView={caseId:string;scopes:{summary:string}[];attempts:ToolAttempt[];interventions:ToolIntervention[];results:ToolResult[];resolution:ResolutionDecision;resolutions:ResolutionDecision[];coverage:{complete:boolean}};
export type ToolCaseCandidate={caseId:string;summary:string|null;attempts:ToolCandidateAttempt[];results:ToolResult[];evidence:ToolEvidence[];verifications:ToolVerification[];synthetic:boolean|null};
export type ToolManifest={builderId:string;manifestId:string;manifestHash:string;authorId:string;manifest:WorkerPack;versionStatus:string;delisted:boolean;securityIssue:boolean};
export type PackUseSources={pack:ToolManifest;attempt:ToolAttempt;result:ToolResult|null;configuration:ConfigurationView;attemptVersionStatus:string;reportedOutcome:string;synthetic:boolean|null;evidence:ToolEvidence[];verifications:ToolVerification[];roles:{packAuthorId:string;runnerId:string;configurationAuthorId:string|null;resultAuthorId:string|null;verificationAuthorIds:string[]}};
type PackUseBase={id:string;subjectId:string;version:number;currentVersion:number;state:string;sourceStatus:string;disclosure?:{visibility:'Private'|'Public';viewers:string[]}};
export type PackUseView=PackUseBase&({record:PackUseRecord;sources:PackUseSources}|{record:null;sources?:null});
export type PackUseInput={caseId:string;attempt:VersionRef|null;result:VersionRef|null;evidenceRefs:VersionRef[];verificationRefs:VersionRef[];visibility:'Private'|'Public';viewers:string[];expectedVersion:number;prior:PackUseRecord['follows'];query:string};
export type PackUseLegacy={event?:PackUseRecord;disclosure?:{visibility:'Private'|'Public';viewers:string[]}};
export type PackUseClient=ToolJournalClient<PackUseEvent>&{
 get:(input:{id:string})=>Promise<PackUseView>;
 query:(input:{subjectId?:string;builderId?:string;limit:number;after?:string})=>Promise<{items:PackUseView[];nextAfter:string|null}>;
 manifest:(input:{builderId:string;manifestId:string})=>Promise<ToolManifest>;
 builders:(input:{query:string;limit:number;after?:string})=>Promise<{items:BuilderDirectoryRow[];nextAfter:string|null}>;
 support:(builderId:string)=>Promise<{pack:{record:WorkerPack|null;eventId?:string}}>;
 candidates:(input:{limit:number;caseId?:string;after?:string})=>Promise<{items:ToolCaseCandidate[];nextAfter:string|null}>;
 caseFacts:(caseId:string,taskId?:string|null)=>Promise<ToolCaseView>;
 loadDraft:()=>Promise<PackUseLegacy|null>;
};
export type ToolDraftFlush=(()=>Promise<unknown>)|null;
export type ToolOriginWork={task:{taskId:string;caseId:string|null;request:{title:string}};facts:ToolCaseView|null};
export const sameToolRef=(a:VersionRef|null|undefined,b:VersionRef|null|undefined)=>a?.id===b?.id&&a?.version===b?.version;
export function toolRef(value:VersionRef):VersionRef;
export function toolRef(value:VersionRef|null|undefined):VersionRef|null;
export function toolRef(value:VersionRef|null|undefined){return value?{id:value.id,version:value.version}:null;}
/** Validate the family while retaining the exact preview object held by the SDK. */
export function checkedToolPrepared<P>(value:unknown,payload:(value:unknown)=>value is P):ToolPrepared<P>{
 function prepared(input:unknown):input is ToolPrepared<P>{return typeof input==='object'&&input!==null&&'operationId'in input&&typeof input.operationId==='string'&&'payloadHash'in input&&typeof input.payloadHash==='string'&&'payload'in input&&payload(input.payload);}
 if(!prepared(value))throw Error('原预览的内容类别或操作位置不匹配，请保留原输入。');return value;
}
export function createTypedConfigurationClient(runtime:ToolRuntime,subjectId?:string):ConfigurationClient{
 const client=createConfigurationClient({api:runtime.api,getLocal:runtime.getLocal,putLocal:runtime.putLocal,subjectId});
 return {...client,prepare:async(payload,scope)=>checkedToolPrepared(await client.prepare(payload,scope),(input):input is ConfigurationEvent=>configurationEventV2Schema.safeParse(input).success)};
}
export function createTypedPackUseClient(runtime:ToolRuntime,subjectId?:string):PackUseClient{
 const client=createWorkerPackUseClient({runtime,subjectId,now:()=>Math.floor(Date.now()/1000)});
 return {...client,prepare:async(payload,scope)=>checkedToolPrepared(await client.prepare(payload,scope),toolPackUsePayload)};
}
export function toolPackUsePayload(value:unknown):value is PackUseEvent{return packUseEventSchema.safeParse(value).success;}
