import type * as z from 'zod/v4';
import type {discoveryQueryV2Schema} from '../../galaxy-official/src/shared/discovery-schema-v2.mjs';
import type {GovernanceDraftRuntime} from './governance-draft-state';
import type {capsuleVersionSchema} from '../../galaxy-official/src/shared/capsule-schema.mjs';
import type {taskRequestV2Schema,taskEventV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import type {createTaskContactClient} from './task-contact-client.mjs';
import type {ProjectRuntime,ProjectViewClient,ContactView,VisibleOpportunity,ProjectOperationReview,ProjectContinuation,ContactWriteReceipt,RecruitmentView,DiscoveryQuery,DiscoveryPurpose,OpportunityRef} from './project-workspace-types';
import {object,projectErrorText} from './project-workspace-types';
import type {HistoryRecord} from './record-workspace-types';

export type SearchType='history'|'case'|'capsule'|'task'|'opportunity'|'proof'|'worker'|'hub';
export type SearchRequest={type:Exclude<SearchType,'opportunity'>;query:{query?:string;limit?:number;after?:string;capabilityId?:string;[key:string]:unknown}}|{type:'opportunity';query:z.input<typeof discoveryQueryV2Schema>};
export type SearchRef={type:SearchType;id:string;version:string;search:SearchRequest|null};
export type ResultRef={caseId:string;id:string;version:number};
export type SearchRecord={
 kind?:string;key?:string;caseId?:string|null;title?:string|null;summary?:string|null;
 attempts?:{id:string;version:number;strategy:string;reportedOutcome?:string;status:string;summary?:string;failureReason?:string;actorId?:string;environment?:{name:string;version:string}}[];
 interventions?:{id:string;version:number;types:string[];description:string;observedEffect:string;actorId?:string}[];
 results?:{id:string;version:number;reportedOutcome:string;summary:string;limitations:string;supersededInVisibleHistory?:boolean}[];
 request?:z.infer<typeof taskRequestV2Schema>;enrollmentOpen?:boolean;
 help?:{functions:string[]};newApplicationAllowed?:boolean;
 data?:{source:{owner:string;repository:string;runId:number|string;attempt:number};conclusion:string};
};
export type SearchItem={type:SearchType;id:string;title:string;summary:string;ref:{id:string;version:string};sourceVersion:string;
 source:{key?:string;versionId?:string};record:SearchRecord;limitations?:(string|{message?:string;description?:string;reason?:string})[]};
export type SearchPage={type:SearchType;items:SearchItem[];nextCursor:string|null;sourceState?:string;checkedAt:number};
export type ReferenceState={state:string;item:SearchItem|null};
export type SearchReference=ReferenceState&{priorRationaleCurrent?:boolean;checkedAt?:number};
export type HelpSource={type:SearchType;state:'fulfilled';page:SearchPage;loadedPages:number}|{type:SearchType;state:'failed';page:null;error?:string;loadedPages?:number};
export type SearchGroup={key:string;search:SearchRequest;pages:number;base:boolean;refs:SearchRef[]};
export type SearchGroupResult=SearchGroup&({state:'fulfilled';page:SearchPage;items:SearchItem[];loadedPages:number}|{state:'failed';page:null;items:SearchItem[];error:string});
export type ChoiceReference={type:SearchType;id:string;version:string};
export type ChoiceVersion={id:string;version:number;localTaskRef:string;visibleRationale:string;candidateRefs:ChoiceReference[];selectedRefs:ChoiceReference[];resultRefs:ResultRef[];hash:string;recordedAt:string};
export type LocalChoice={id:string;versions:ChoiceVersion[]};
export type HelpLocal={choices:LocalChoice[];referenceStates:Record<string,{state:string;priorRationaleCurrent?:boolean|null}>};
export type HelpDetail={capsuleId?:string;versionId?:string;version?:z.infer<typeof capsuleVersionSchema>;sourceStatus?:string;
 experience?:{items:HistoryRecord[];nextCursor:string|null;rebuild:{sourceHash:string}}};
export type HelpSearchClient={
 query:(search:SearchRequest)=>Promise<SearchPage>;local:()=>Promise<HelpLocal>;
 detail:(item:SearchItem,options:{after:string|null})=>Promise<HelpDetail>;
 refreshChoice:(id:string)=>Promise<HelpLocal>;removeChoice:(id:string)=>Promise<HelpLocal>;close:()=>void;
 saveChoice:(input:{id:string;expectedVersion:number;localTaskRef:string;visibleRationale:string;rationaleAuthor:'user';candidateKeys:string[];selectedKeys:string[];resultRefs:ResultRef[]})=>Promise<ChoiceVersion>;
};
export type ContactComposeValue={purpose:string;note:string;roomTitle:string};
export type ContactComposeRecord={version:1;revision:string;value:ContactComposeValue;attempt?:{operationId:string}};
export function checkedContactCompose(raw:unknown):ContactComposeRecord|null{
 if(raw==null)return null;
 if(!object(raw)||raw.version!==1||typeof raw.revision!=='string'||!object(raw.value)
  ||typeof raw.value.purpose!=='string'||typeof raw.value.note!=='string'||typeof raw.value.roomTitle!=='string'
  ||raw.attempt!==undefined&&(!object(raw.attempt)||typeof raw.attempt.operationId!=='string'))throw Error('联系草稿暂时无法读取，请保留本页输入。');
 // The verified envelope retains the existing property order and original bytes.
 return raw as ContactComposeRecord;
}
export type OpportunityClient=Omit<ProjectViewClient,'send'>&{
 pendingContact:(opportunity:VisibleOpportunity)=>Promise<(ProjectContinuation&{operationId:string})|null>;
 recentContact:(opportunity:VisibleOpportunity)=>Promise<ContactView|null>;
 contact:(id:string)=>Promise<ContactView>;recruitment:(id:string)=>Promise<RecruitmentView&{acceptingContacts:boolean;representativeCurrentlyAuthorized:boolean}>;
 send:(query:DiscoveryQuery,opportunity:VisibleOpportunity,selection:{purpose:DiscoveryPurpose;note:string;roomTitle:string;operationId:string})=>Promise<ContactWriteReceipt>;
 respond:(contact:ContactView,kind:'withdraw')=>Promise<ContactWriteReceipt>;
 reconcile:(operationId:string,retry?:boolean)=>Promise<ProjectContinuation&{contactId?:string;current?:ContactView}>;
 resumePending:(operationId:string)=>Promise<ProjectContinuation>;
 reviewPending:(operationId:string)=>Promise<ProjectOperationReview|null>;
};
export type TaskContactTask={taskId:string;requesterId:string;request:z.infer<typeof taskRequestV2Schema>;
 contacts?:{suggestions:{items:Extract<z.infer<typeof taskEventV2Schema>,{kind:'suggest-contacts'}>['items']};responses:{applications:{state:string;subjectId:string}[];invitations:{state:string;recipientId:string}[]}};
 participations?:{subjectId:string;state:string}[]};
export type ContactCandidate={subjectId:string;displayName?:string;willingness?:string;roles:string[];sources:{item:SearchItem;search:SearchRequest}[];help:string;basis:string;conditions:string};
export type ContactSearchPage=SearchPage&{search:SearchRequest;error?:string};
export type InvitationBatch={batchId:string;confirmed:boolean;items:{eventId:string;subjectId:string;note:string;expiresAt:number;state:string;error?:string|null}[]};
export type TaskRoom={roomId:string;title:string;members:{subjectId:string}[]};
export type RoomInvitation={subjectId:string;decisionId:string;state:string;input?:unknown;receipt?:unknown};
export type RoomBatch={batchId:string;mode:string;rooms:{input:{roomId:string;title:string};state:string;created?:boolean;error?:string|null;invitations:RoomInvitation[]}[]};
export type RoomProgress={roomId:string;unavailable:true}|{roomId:string;unavailable?:false;current:TaskRoom;invitations:{subjectId:string;joined:boolean;state:string}[]};
export type TaskContactClient=Omit<ReturnType<typeof createTaskContactClient>,'search'|'pending'|'pendingRooms'|'prepareInvites'|'sendInvites'|'stopUnsent'|'rooms'|'prepareRooms'|'sendRooms'|'roomProgress'|'refreshRoomPlan'|'cancelPreparedRooms'>&{
 search:(task:TaskContactTask,options:{keyword:string;functions:string[];only:SearchType|null;after:Record<string,string>})=>Promise<ContactSearchPage[]>;
 pending:()=>Promise<InvitationBatch|null>;pendingRooms:()=>Promise<RoomBatch|null>;
 prepareInvites:(items:{subjectId:string;note:string}[])=>Promise<InvitationBatch>;
 sendInvites:(options:{confirmed:boolean;batchId:string})=>Promise<InvitationBatch>;stopUnsent:(eventId:string)=>Promise<InvitationBatch>;
 rooms:(after?:string)=>Promise<{rooms:TaskRoom[];scanned:number;next:string|null}>;
 prepareRooms:(mode:string,recipients:string[])=>Promise<RoomBatch>;sendRooms:(options:{confirmed:boolean;batchId:string})=>Promise<RoomBatch>;
 roomProgress:()=>Promise<RoomProgress[]>;refreshRoomPlan:(id:string)=>Promise<RoomBatch>;cancelPreparedRooms:(options:{batchId:string})=>Promise<null>;
};
export type TaskPreparation={input:{keyword:string;functions:string[]};pages:ContactSearchPage[];candidates:ContactCandidate[];selected:string[];withheld:number};
export type DiscoveryInput={title:string;functions:string;technologies:string;selected:DiscoveryPurpose[];submittedQuery:DiscoveryQuery|null;openedRef:{id:string;subjectId:string;projectId:string;opportunityRef:OpportunityRef;sourceUnavailable:true}|null};
export type ContactRuntime=ProjectRuntime;
export function contactMessage(error:unknown,fallback='操作暂未完成，请稍后重试。'){return projectErrorText(error).trim()||fallback;}


const disconnectedDraft:GovernanceDraftRuntime={receiptStatus:{captureLease:()=>{throw Error('connection_required');}},getLocal:()=>Promise.resolve(null),updateLocal:()=>Promise.reject(Error('connection_required'))};
export function contactDraftRuntime(runtime:ProjectRuntime|null):GovernanceDraftRuntime{return runtime??disconnectedDraft;}
export function bodyFreeOpportunity(value:VisibleOpportunity):{id:string;subjectId:string;projectId:string;opportunityRef:OpportunityRef;sourceUnavailable:true}{return{id:value.id,subjectId:value.subjectId,projectId:value.projectId,opportunityRef:value.opportunityRef,sourceUnavailable:true};}
