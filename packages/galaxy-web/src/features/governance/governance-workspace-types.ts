import type * as z from 'zod/v4';
import type {createWebRuntime} from "../../runtime.mjs";
import type {caseEventSchema,caseEventV2Schema} from "../../../../galaxy-contracts/src/cases-schema.mjs";
import type {moderationEventSchema,moderationReceiptSchema,moderationReportSchema,moderationVerifierTargetSchema} from "../../../../galaxy-contracts/src/moderation-schema.mjs";
import type {governanceScopeSchemaV2,governanceTargetSchemaV2,targetReportSchemaV2} from "../../../../galaxy-contracts/src/target-governance-v2-schema.mjs";

export type GovernanceRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'status'|'receiptStatus'|'getLocal'|'putLocal'|'updateLocal'>;
export type WorkspaceProps={runtime:GovernanceRuntime;subjectId?:string;connected:boolean;navigate:(path:string)=>void;reportId?:string};
export type SourceView={kind:'task'|'room'|'case';title:string;summary?:string;path?:string;memberIds?:string[]};
export type OperationResult={state:string;reason?:string};
type Confirmed={confirmed:true};

export type GovernanceTarget=z.infer<typeof governanceTargetSchemaV2>;
export type TargetReference=Pick<GovernanceTarget,'type'|'id'>;
export type TargetScope=z.infer<typeof governanceScopeSchemaV2>;
export type TargetReport=z.infer<typeof targetReportSchemaV2>;
export type TargetSimpleKind='supplement'|'appeal'|'withdraw-report'|'resume'|'review';
type TargetEventBase=Pick<TargetReport,'schemaVersion'|'id'|'summary'>&{reportId:string;expectedVersion:number};
// The schema's mapped simple-kind options erase its inferred output to unknown.
// Keep their actual wire union here; the client still parses every submission.
export type TargetEvent=TargetEventBase&(
 |{kind:TargetSimpleKind}
 |{kind:'pause';scopes:TargetScope[];until:number;targetVersion:number;rule:string}
 |{kind:'resolve';verdict:'upheld'|'dismissed';rule:string;targetVersion:number;restriction:{scopes:TargetScope[];until:number}|null}
);
export type TargetPayload=TargetReport|TargetEvent;
export type TargetDraft={action:string;summary:string;category:TargetReport['category'];viewers:string[];audienceChosen:boolean;rule:string;scopes:TargetScope[];hours:number;verdict:'upheld'|'dismissed'};
export type TargetLocator={operationId:string;payloadHash:string;type:'report'|'event';reportId:string};
export type TargetEventProjection=TargetEvent&{eventId:string;authorId:string;at:string;version:number};
export type TargetStatement=TargetEventProjection|(TargetReport&{kind?:undefined;eventId:string;authorId:string;at:string;version:number});

// Read projections mirror the fields emitted by target-governance-v2.mjs.
// Payloads retain their canonical schema types; these projections grant no authority.
export type TargetProjection={
 reportId:string;target:GovernanceTarget;version:number;state:string;reporterId:string;events:TargetStatement[];
 handling:string;requiredDecisionViewers:string[];canModerate:boolean;canAppeal:boolean|null;canRespond:boolean;canWithdraw:boolean;
 currentTarget:(GovernanceTarget&{state:string;sourceAvailable:boolean;contentAccess:string;canReadTarget:boolean})|null;
 ownRestriction:{scopes:TargetScope[];until:string;eventId:string}|null;
};
export type TargetInfo={target:GovernanceTarget;state:string;sourceAvailable:boolean;contentAccess:string};
export type TargetConfig={moderatorIds:string[];configured:boolean;roleConfigured:boolean;guaranteesResponse:false};
export type TargetPending={operationId:string;payloadHash:string;type:'report'|'event';state:string;payload?:TargetPayload};
export type TargetStopped={operationId:string;payloadHash:string;type:'report'|'event';reportId:string|null;target:TargetReference|null;canContinue:boolean};
export type TargetPrepared={type:string;operationId:string;payload:unknown;payloadJson:string;payloadHash:string;viewers:string[];expiresAt:number;subjectId:string;endpoint:string};
export type TargetReauthorization={state:'reauthorization-required';operationId:string;priorConsentId:string|null;payload:TargetPayload;payloadHash:string;viewers:string[];expiresAt:number;originalExpiresAt:number|null};
type AuthorizationUnchanged={state:'none'|'acknowledged'|'absent'|'conflict'|'reuse-original-authorization'};
export type TargetPreview=
 |{original:TargetPrepared;payload:TargetPayload;viewers:string[];endpoint:string;expiresAt:number;title?:string;revision:string|null;recovery?:false}
 |(TargetReauthorization&{original:TargetReauthorization;title?:string;recovery:true});
export type TargetClient={
 config:()=>Promise<TargetConfig>;
 get:(id:string)=>Promise<TargetProjection>;
 target:(target:TargetReference)=>Promise<TargetInfo>;
 query:(input:{target?:TargetReference;after?:string})=>Promise<{items:TargetProjection[];next:string|null}>;
 pending:()=>Promise<TargetPending[]>;
 stopped:()=>Promise<TargetStopped[]>;
 receipt:(locator:TargetLocator)=>Promise<OperationResult>;
 resumePending:(id:string)=>Promise<OperationResult>;
 prepare:(type:'report'|'event',payload:TargetPayload,options:{viewers:string[]})=>Promise<TargetPrepared>;
 execute:(preview:TargetPrepared,confirmed:Confirmed)=>Promise<unknown>;
 reviewAuthorization:(id:string)=>Promise<TargetReauthorization|AuthorizationUnchanged>;
 reauthorize:(preview:TargetReauthorization,confirmed:Confirmed)=>Promise<unknown>;
 continueStopped:(locator:Pick<TargetLocator,'operationId'|'payloadHash'>,confirmed:Confirmed)=>Promise<OperationResult>;
 stopLocalRetry:(id:string,confirmed:Confirmed)=>Promise<unknown>;
};

export type ReviewReport=z.infer<typeof moderationReportSchema>;
export type ReviewEvent=z.infer<typeof moderationEventSchema>;
export type ReviewLocator=z.infer<typeof moderationReceiptSchema>;
type ReviewTarget=z.infer<typeof moderationVerifierTargetSchema>;
type ReviewConclusion=Extract<ReviewEvent,{kind:'verification-response'}>['conclusion'];
type ReviewVerdict=Extract<ReviewEvent,{kind:'resolve'}>['verdict'];
export type ReviewDraft={action:string;summary:string;scope:string;verifier:string;conclusion:ReviewConclusion;corrects:string;reason:string;verdict:ReviewVerdict};
export type ReviewSource={caseId:string;reportedVersion:number;currentVersion:number;targetEventId:string;targetEvent:z.infer<typeof caseEventSchema>|z.infer<typeof caseEventV2Schema>|null};
export type ReviewSummary={reportId:string;caseId?:string;assistanceId?:string;version:number;state:string;paused:boolean};
type VerifierParticipation={own:{invitationId:string;subjectId:string;status:string;expiresAt:number;scope:string|null;target:ReviewTarget|null}|null;sourceAvailable:boolean};

// moderation.mjs projects source and report independently after current access checks.
export type ReviewProjection=ReviewSummary&{
 source?:ReviewSource|null;report:ReviewReport|null;events:(ReviewEvent&{actorId:string;version:number})[];
 reporterId?:string;participantIds?:string[];verifierParticipation:VerifierParticipation;
 canInviteVerifier:boolean;canAcceptVerifier:boolean;canDeclineVerifier:boolean;canWithdrawVerifier:boolean;
 canSubmitVerification:boolean;canAppeal:boolean;canSupplement:boolean;canCorrectEventIds:string[];canModerate:boolean;unavailable?:false;
};
export type ReviewListItem=ReviewProjection|(ReviewSummary&{report:null;source:null;events:[];verifierParticipation?:undefined;unavailable:true});
export type ReviewPending=ReviewLocator&{phase:string;payload:ReviewEvent};
export type ReviewStopped=ReviewLocator&{kind:string;canContinue:boolean};
export type ReviewPrepared=ReviewLocator&{endpoint:string;subjectId:string;payload:ReviewEvent;payloadJson:string;viewers:string[];expiresAt:number};
export type ReviewReauthorization=ReviewLocator&{state:'reauthorization-required';payload:ReviewEvent;viewers:string[];priorConsentId:string|null;expiresAt:number;originalExpiresAt:number|null};
export type ReviewPreview=
 |{original:ReviewPrepared;payload:ReviewEvent;viewers:string[];endpoint:string;expiresAt:number;title?:string;revision:string|null;recovery?:false}
 |(ReviewReauthorization&{original:ReviewReauthorization;title?:string;recovery:true});
type ClientGeneratedReviewFields='id'|'expectedVersion'|'target'|'invitationId';
type ReviewInputFields<T>=T extends ReviewEvent?Omit<T,ClientGeneratedReviewFields>:never;
export type ReviewInput=ReviewInputFields<ReviewEvent>;
export type ReviewClient={
 get:(id:string)=>Promise<ReviewProjection>;
 query:(input:{caseId?:string;after?:string})=>Promise<{items:ReviewSummary[];nextAfter:string|null}>;
 pending:(id:string)=>Promise<ReviewPending|null>;
 stopped:(id:string)=>Promise<ReviewStopped[]>;
 receipt:(locator:ReviewLocator)=>Promise<OperationResult>;
 resumePending:(id:string)=>Promise<OperationResult>;
 prepare:(input:ReviewInput)=>Promise<ReviewPrepared>;
 execute:(preview:ReviewPrepared,confirmed:Confirmed)=>Promise<unknown>;
 reviewAuthorization:(id:string)=>Promise<ReviewReauthorization|AuthorizationUnchanged>;
 reauthorize:(preview:ReviewReauthorization,confirmed:Confirmed)=>Promise<unknown>;
 continueStopped:(locator:ReviewLocator,confirmed:Confirmed)=>Promise<OperationResult>;
 stop:(id:string,confirmed:Confirmed)=>Promise<unknown>;
};
