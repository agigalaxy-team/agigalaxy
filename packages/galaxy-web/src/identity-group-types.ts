import type {RefObject} from 'react';
import type {z} from 'zod/v4';
import type {identityGroupIntentSchema,identityGroupSourceSchema,identityGroupSourceSelectionSchema} from '../../galaxy-official/src/shared/identity-group-v2-schema.mjs';
import type {ChoiceViewLease} from './choice-retained-operations';
import type {createWebRuntime} from './runtime.mjs';

export type IdentityGroupRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'status'|'receiptStatus'|'identityGroups'|'getLocal'|'updateLocal'>;
export type IdentityGroupLease=ChoiceViewLease;
export type IdentityGroupIntent=z.infer<typeof identityGroupIntentSchema>;
export type IdentityGroupDisplayIntent=Exclude<IdentityGroupIntent,{kind:'revoke'}>;
export type IdentityGroupRef=z.infer<typeof identityGroupSourceSchema>;
export type IdentityGroupSelection=z.infer<typeof identityGroupSourceSelectionSchema>;
export type IdentityGroupCandidateRef=IdentityGroupSelection&{originalSubjectId:string;sourceHash?:string};
export type IdentityGroupDecision='approve'|'decline'|'cancel';
export type IdentityGroupDirection='all'|'incoming'|'outgoing';
export type IdentityGroupEditorKind='create'|'edit'|'revoke';
export type IdentityGroupCorrection=IdentityGroupDisplayIntent['attributionCorrections'][number];

export type IdentityGroupRecord={
 kind?:string;title?:string;summary?:string;strategy?:string;description?:string;observedEffect?:string;reason?:string;failureReason?:string;
 reportedOutcome?:string;status?:string;limitations?:string|string[];
 conditions?:{model?:{name?:string;version?:string};runtime?:{name?:string;version?:string};environment?:{name?:string;version?:string};inputScopeSummary?:string;limitations?:string};
};
export type IdentityGroupSourceView={ref:IdentityGroupCandidateRef;record:IdentityGroupRecord|null;displaySubjectId?:string;state?:string};
export type IdentityGroupSelectedSource=IdentityGroupSourceView&{ref:IdentityGroupRef};
export type IdentityGroup={
 groupId:string;version:number;operationId:string;state:string;memberIds:string[];canonicalDisplayId:string|null;visibility:'Private'|'Public';viewers:string[];
 sources:IdentityGroupSourceView[];sourceCount:number;canRevoke:boolean;availableActions:('revise'|'revoke')[];
};
export type IdentityGroupProposal={
 operationId:string;groupId:string;state:string;kind:IdentityGroupIntent['kind'];proposerId:string;payloadJson:string|null;expiresAt:string;
 requiredSubjectIds:string[];approvals:{id:string;subjectId:string;decision:IdentityGroupDecision;keyId:string;epoch:number;at:string;expiresAt:number}[];
 sources:IdentityGroupSourceView[];availableActions:IdentityGroupDecision[];
};
export type IdentityGroupLocator={endpoint:string;ownerId:string;operationId:string;groupId:string;proofId:string;payloadHash:string};
export type IdentityGroupResult={
 state:string;locator:IdentityGroupLocator;operationState?:string|null;ownApprovalAcknowledged?:boolean;operationClosed?:boolean;reason?:string;
 businessFailure?:{code:string;status:number|null}|null;
};
export type IdentityGroupPending={
 operationId:string;groupId:string;proofId:string;payloadHash:string;state:string;locator:IdentityGroupLocator;
 blockedReason?:string|null;businessFailure?:{code:string;status:number|null}|null;
};
export type IdentityGroupPreview={payload:IdentityGroupIntent;payloadHash:string;subjectId:string;decision:IdentityGroupDecision;scope:string;control:{keyId:string;epoch:number}};
export type IdentityGroupClient={
 current:()=>Promise<{availableActions:('create')[]}>;
 source:(selection:IdentityGroupSelection)=>Promise<IdentityGroupSelectedSource>;
 read:(groupId:string)=>Promise<IdentityGroup>;
 proposal:(operationId:string)=>Promise<IdentityGroupProposal>;
 query:(input:{after?:string;limit:number})=>Promise<{items:IdentityGroup[];next:string|null}>;
 invitations:(input:{after?:string;limit:number;direction:IdentityGroupDirection})=>Promise<{items:IdentityGroupProposal[];next:string|null}>;
 contacts:(input:{after?:string})=>Promise<{items:{state:string;initiatorId:string;recipientId:string}[];nextAfter?:string|null}>;
 prepare:(intent:IdentityGroupIntent)=>Promise<IdentityGroupPreview>;
 prepareResponse:(operationId:string,decision:IdentityGroupDecision)=>Promise<IdentityGroupPreview>;
 execute:(preview:IdentityGroupPreview,options:{confirmed:true;onJournal?:(locator:IdentityGroupLocator)=>Promise<unknown>})=>Promise<IdentityGroupResult>;
 receiptFor:(locator:IdentityGroupLocator)=>Promise<IdentityGroupResult>;
 pending:()=>Promise<IdentityGroupPending[]>;
 resumePending:(options:{explicitRetry:false})=>Promise<{items:IdentityGroupResult[]}>;
 reviewPending:(proofId:string)=>Promise<IdentityGroupPreview>;
 retry:(proofId:string,options:{explicitRetry:true})=>Promise<IdentityGroupResult>;
 reconcile:(proofId:string)=>Promise<IdentityGroupResult>;
 stopLocalRetry:(proofId:string,options:{confirmed:true})=>Promise<IdentityGroupResult>;
};
export type IdentityGroupSourceChoice={kind:'case-event';caseId:string;taskId?:string}|{kind:'configuration';id:string};
export type IdentityGroupInput={
 groupId:string;expectedVersion:number;previousOperationId:string|null;memberIds:string[];canonicalDisplayId:string;visibility:'Private'|'Public';viewers:string[];
 sourceRefs:IdentityGroupRef[];attributionCorrections:IdentityGroupCorrection[];memberQuery:string;memberManual:string;viewerQuery:string;viewerManual:string;
 sourceKind:'case-event'|'configuration';sourceChoice:IdentityGroupSourceChoice|null;reason:string;
};
export type IdentityGroupDraft={
 value:IdentityGroupInput;ready:boolean;status:string;attempt:IdentityGroupLocator|null;change:(patch:Partial<IdentityGroupInput>)=>void;
 snapshot:()=>Promise<{revision:string|null;value:IdentityGroupInput}>;
 attach:(locator:IdentityGroupLocator,revision:string|null)=>Promise<unknown>;
 settle:(receiptFor:(locator:IdentityGroupLocator)=>Promise<IdentityGroupResult>)=>Promise<boolean>;
};
export type IdentityGroupDraftRef=RefObject<IdentityGroupDraft>;
