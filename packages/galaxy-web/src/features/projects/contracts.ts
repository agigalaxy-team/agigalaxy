import type * as z from "zod/v4";
import type {createWebRuntime} from "../../runtime.mjs";
import type {projectDocumentV2Schema,projectEventV2Schema} from "../../../../galaxy-official/src/shared/projects-schema-v2.mjs";
import type {recruitmentDocumentV2Schema,recruitmentEventV2Schema} from "../../../../galaxy-official/src/shared/recruitment-schema-v2.mjs";
import type {contactEventV2Schema} from "../../../../galaxy-official/src/shared/contacts-schema-v2.mjs";
import type {discoveryQueryV2Schema,opportunityRefV2Schema} from "../../../../galaxy-official/src/shared/discovery-schema-v2.mjs";
import type {discoveryPreferencesSchema} from "../../../../galaxy-official/src/shared/discovery-schema.mjs";
import type {HistoryRecord} from "../../record-workspace-types";
import type {useGovernanceDraft} from "../../governance-presentation";

export type ProjectRuntime=Awaited<ReturnType<typeof createWebRuntime>>;
export type ProjectLease=ReturnType<ProjectRuntime['receiptStatus']['captureLease']>;
export type ProjectDocument=z.infer<typeof projectDocumentV2Schema>;
export type ProjectEvent=z.infer<typeof projectEventV2Schema>;
export type RecruitmentDocument=z.infer<typeof recruitmentDocumentV2Schema>;
export type RecruitmentEvent=z.infer<typeof recruitmentEventV2Schema>;
export type ContactEvent=z.infer<typeof contactEventV2Schema>;
export type OpportunityRef=z.infer<typeof opportunityRefV2Schema>;
export type DiscoveryQuery=Pick<z.infer<typeof discoveryQueryV2Schema>,'context'|'purposes'>;
export type DiscoveryPurpose=DiscoveryQuery['purposes'][number];
export type DiscoveryPreferences=z.infer<typeof discoveryPreferencesSchema>;
export type ProjectRole='editor'|'representative';
export type ProjectRoleView={subjectId:string;role:ProjectRole;grantOperationId:string};
export type ProjectTransfer={transferId:string;fromSubjectId:string;toSubjectId:string;state:'offered';operationId:string};
export type ProjectView={
 projectId:string;ownerId:string;creatorId:string;revision:number;state:string;visibility:'Public'|'Private';
 document:ProjectDocument|null;ownRoles:string[];permissions:{edit:boolean;represent:boolean;manage:boolean};
 management?:{roles:ProjectRoleView[];transfers:ProjectTransfer[]};
 source?:{documentEventId:string;policyEventId:string;sourceStatementId:string|null;fieldSources:{field:string;operationId:string;subjectId:string}[]};
};
export type RecruitmentView={
 recruitmentId:string;projectId:string;publisherId:string;contactSubjectId:string;revision:number;state:string;
 sourceEventId:string;expiresAt:string;document?:RecruitmentDocument;contentUnavailable?:boolean;
 taskLinks?:{taskId:string;linkedBy:string;operationId:string;linkedAt:string}[];
};
type ContactReadEventBase={operationId:string;subjectId:string;revision:number;recordedAt:string};
export type ContactReadEvent=ContactReadEventBase&(
 {kind:'send';contentUnavailable?:false;note:string;opportunityRef:OpportunityRef;context:DiscoveryQuery['context'];roomTitle:string}
 |{kind:'accept'|'decline'|'withdraw';contentUnavailable?:false;note:string}
 |{kind:ContactEvent['kind'];contentUnavailable:true});
export type ContactView={
 contactId:string;initiatorId:string;recipientId:string;purpose:DiscoveryPurpose;state:string;revision:number;
 roomId:string|null;expiresAt:string;events:ContactReadEvent[];sourceNeedsRefresh?:boolean;
};
export type ProjectPage={items:ProjectView[];nextAfter:string|null};
export type RecruitmentPage={items:RecruitmentView[];nextAfter:string|null};
export type ContactsPage={items:ContactView[];nextAfter:string|null};
export type OpportunityLocation={id:string;subjectId:string;projectId:string;opportunityRef:OpportunityRef;sourceUnavailable:true};
export type Opportunity={
 id:string;subjectId:string;projectId:string;recruitmentId?:string;opportunityRef:OpportunityRef;sourceUnavailable?:false;
 project:{title:string;summary:string;kind:string;functions:string[];technologies:string[];sourceUrl?:string};
 help:{statement:string;functions:string[];purposes:DiscoveryPurpose[]};
 participant:{kind:string};contactState:string;willingness:{temporaryUntil:string|null};
 match:{score:number;sharedFunctions:string[];sharedTechnologies:string[];purposes:DiscoveryPurpose[]};
 sources:{sourceUrl?:string|null}[];
};
export type VisibleOpportunity=Opportunity|OpportunityLocation;
export type DiscoveryPage={items:Opportunity[];nextAfter:string|null;enabled:boolean;coverage:{windowLimited:boolean}};
export type OpportunityDetail={opportunity:Opportunity;experience:{items:HistoryRecord[];nextCursor:string|null;nextAfter?:string|null}};
export type UnavailableOpportunityDetail={opportunity:OpportunityLocation;experience?:{items:HistoryRecord[];nextCursor?:string|null;nextAfter?:string|null}};
export type PreferencesView={preferences:DiscoveryPreferences;revision:number;effective:{temporaryUntil:number|null}};
export type ProjectPreferencesView={preferences:DiscoveryPreferences|null;revision:number};
export type TaskChoice={taskId:string;version:number;request?:{title:string};title?:string};
export type Quota={category:string;remaining:number;resetAt:string|null};
export type ProjectWriteReceipt={operationId:string;projectId:string;revision:number};
export type ContactWriteReceipt={operationId:string;contactId:string;roomId:string|null;state:string};
export type RecruitmentWriteReceipt={operationId:string;recruitmentId:string;state:string};
export type OperationType='project'|'recruitment'|'contact';
export type OperationWait={reason?:string;retryAt?:string|null;rejectionCode?:string;code?:string};
export type PendingProjectOperation=OperationWait&{type:OperationType;operationId:string;objectId:string;state:string;wait?:OperationWait};
type ReviewBase=PendingProjectOperation&{payloadHash:string;visibility:'Public'|'Private';viewers:string[];authorization:'original-consent'|'review-required'};
export type OriginalProjectOperation=ReviewBase&(
 {type:'project';payload:ProjectEvent}|{type:'recruitment';payload:RecruitmentEvent}|{type:'contact';payload:ContactEvent});
export type ProjectOperationReview=OriginalProjectOperation|{state:'acknowledged';operationId:string;objectId:string;type:OperationType;receipt:unknown;payload:null};
export type ProjectContinuation=OperationWait&{state:string;operationId?:string;objectId?:string};
type WriteOptions={confirmed:boolean;visibility?:string;viewers?:string[]};
export type ProjectContactClient={
 submit(type:'project',input:unknown,options:WriteOptions):Promise<ProjectWriteReceipt>;
 submit(type:'contact',input:unknown,options:WriteOptions):Promise<ContactWriteReceipt>;
 submit(type:'recruitment',input:unknown,options:WriteOptions):Promise<RecruitmentWriteReceipt>;
 pending:()=>Promise<PendingProjectOperation[]>;
 reviewPending:(operationId:string)=>Promise<ProjectOperationReview|null>;
 resumePending:(operationId:string)=>Promise<ProjectContinuation>;
 reconcile:(operationId:string,options?:{retry?:boolean;confirmed?:boolean})=>Promise<ProjectContinuation>;
};
export type ProjectViewClient={
 current:()=>void;
 project:(id:string)=>Promise<ProjectView>;
 related:(id:string,purposes:DiscoveryPurpose[],after?:string|null)=>Promise<{project:ProjectView;query:DiscoveryQuery;result:DiscoveryPage}>;
 detail:(query:DiscoveryQuery,ref:OpportunityRef,after?:string|null)=>Promise<OpportunityDetail>;
 contactForProject:(id:string)=>Promise<{project:ProjectView;query:DiscoveryQuery;detail:OpportunityDetail}>;
 send:(query:DiscoveryQuery,opportunity:Opportunity,selection:{purpose:DiscoveryPurpose;note:string;roomTitle:string})=>Promise<ContactWriteReceipt>;
};
export type ProjectForm={kind:string;title:string;summary:string;functions:string;technologies:string;sourceUrl?:string;participantKind:string;discoverable:boolean;[key:string]:unknown};
export type RecruitmentForm={title:string;role:string;summary:string;functions:string;technologies:string;conditions:string;days:number;[key:string]:unknown};
export type DiscoveryForm={title:string;functions:string;technologies:string;purpose:DiscoveryPurpose};
export type ProjectPeopleForm={person:string;query:string;role:string};
export type ProjectSelectionLocator={kind:'project-management';operationId:string;projectId:string;action:string;person?:string;role?:string};
export type ProjectSelectionDraft=ReturnType<typeof useGovernanceDraft<ProjectPeopleForm,ProjectSelectionLocator>>;
export type ProjectSelection={draft:ProjectSelectionDraft;revision:string|null};
type DistributiveOmit<T,K extends PropertyKey>=T extends object?Omit<T,K>:never;
export type ProjectChoice=DistributiveOmit<ProjectEvent,'projectId'|'expectedRevision'|'operationId'|'document'|'patch'>&{projectId?:string;expectedRevision?:number;document?:unknown;patch?:unknown};
export type ProjectComposeValue={changes:Partial<ProjectForm>;step:number;visibility:string;viewers:string;projectId?:never};
export type RecruitmentComposeValue={changes:Partial<RecruitmentForm>;step:number;projectId:string;visibility?:never;viewers?:never};
export type ComposeValue=ProjectComposeValue|RecruitmentComposeValue;
export type ComposeRecord={version:1;targetId:string;objectId:string;revision:string;baseRevision?:unknown;value:ComposeValue;attempt?:{operationId:string;revision:string};acknowledgedObjectId?:string};
type LaneBase={key:string;targetId:string;objectId:string;head:string|null;queue:Promise<unknown>;ready:boolean;started:boolean;open:boolean;failed?:boolean;clearedRevision?:string;baseRevision:number;acknowledgedId?:string|null};
export type ProjectComposeLane=LaneBase&{kind:'project';base:ProjectForm;input:{form:ProjectForm;step:number;visibility:string;viewers:string}};
export type RecruitmentComposeLane=LaneBase&{kind:'recruitment';base:RecruitmentForm;input:{form:RecruitmentForm;step:number;projectId:string}};
export type ComposeLane=ProjectComposeLane|RecruitmentComposeLane;
export type ComposeMarker={lane:ComposeLane;revision:string|null;value:ComposeValue};
export type SendResult={id:string;subjectId:string;result?:ContactWriteReceipt;error?:string;unknown?:boolean;operationId?:string};
export type Confirmation={title:string;body:import("react").ReactNode;execute:()=>Promise<unknown>};

export function projectErrorField(error:unknown,key:string):unknown{return typeof error==='object'&&error!==null?Reflect.get(error,key):undefined;}
export function projectErrorText(error:unknown,key='message'){const value=projectErrorField(error,key);return typeof value==='string'?value:'';}
export function projectErrorNumber(error:unknown,key='status'){const value=projectErrorField(error,key);return typeof value==='number'?value:undefined;}
export function projectErrorFlag(error:unknown,key:string){return projectErrorField(error,key)===true;}
export function object(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null;}
function attempt(value:unknown):value is NonNullable<ComposeRecord['attempt']>{return object(value)&&typeof value.operationId==='string'&&typeof value.revision==='string';}
function composeRecord(raw:unknown,kind:'project'|'recruitment',targetId:string,base:ProjectForm|RecruitmentForm):raw is ComposeRecord{
 if(!object(raw)||raw.version!==1||raw.targetId!==targetId||typeof raw.objectId!=='string'||typeof raw.revision!=='string'
  ||!object(raw.value)||(raw.value.step!==0&&raw.value.step!==1)||!object(raw.value.changes))return false;
 const changes=raw.value.changes;
 if(Object.keys(changes).some(key=>!Object.hasOwn(base,key)||typeof changes[key]!==typeof base[key]))return false;
 if(raw.attempt!==undefined&&!attempt(raw.attempt)||raw.acknowledgedObjectId!==undefined&&typeof raw.acknowledgedObjectId!=='string')return false;
 return kind==='project'?typeof raw.value.visibility==='string'&&typeof raw.value.viewers==='string':typeof raw.value.projectId==='string';
}
/** Check the existing envelope and retain its original property order and bytes. */
export function checkedProjectCompose(raw:unknown,kind:'project'|'recruitment',targetId:string,base:ProjectForm|RecruitmentForm){
 if(raw==null)return null;if(!composeRecord(raw,kind,targetId,base))throw Error('这份草稿暂时无法读取，请保留原记录后重新打开。');return raw;
}
export function savedDiscoveryForm(raw:unknown):DiscoveryForm|undefined{
 if(!object(raw)||typeof raw.title!=='string'||typeof raw.functions!=='string'||typeof raw.technologies!=='string'
  ||!['conversation','reuse','collaboration','recruitment'].includes(String(raw.purpose)))return undefined;
 return{title:raw.title,functions:raw.functions,technologies:raw.technologies,purpose:discoveryPurpose(raw.purpose)};
}
export function isDiscoveryPurpose(value:unknown):value is DiscoveryPurpose{return value==='conversation'||value==='reuse'||value==='collaboration'||value==='recruitment';}
export function discoveryPurpose(value:unknown):DiscoveryPurpose{
 if(isDiscoveryPurpose(value))return value;
 throw Error('请选择当前可用的交流目的。');
}
export function projectFormFor(value:ProjectView|null,blank:ProjectForm):ProjectForm{
 return value?.document?{...blank,...value.document,functions:value.document.functions.join('、'),technologies:value.document.technologies.join('、')}:{...blank};
}
export function recruitmentFormFor(value:RecruitmentView|null,blank:RecruitmentForm):RecruitmentForm{
 return value?.document?{...blank,...value.document,functions:value.document.functions.join('、'),technologies:value.document.technologies.join('、'),days:30}:{...blank};
}
export function projectRole(value:unknown):ProjectRole|''{return value==='editor'||value==='representative'?value:'';}

export function isProjectForm(value:unknown):value is ProjectForm{return object(value)&&typeof value.kind==='string'&&typeof value.title==='string'&&typeof value.summary==='string'&&typeof value.functions==='string'&&typeof value.technologies==='string'&&(value.sourceUrl===undefined||typeof value.sourceUrl==='string')&&typeof value.participantKind==='string'&&typeof value.discoverable==='boolean';}
export function isRecruitmentForm(value:unknown):value is RecruitmentForm{return object(value)&&typeof value.title==='string'&&typeof value.role==='string'&&typeof value.summary==='string'&&typeof value.functions==='string'&&typeof value.technologies==='string'&&typeof value.conditions==='string'&&typeof value.days==='number';}

export function recruitmentExpiry(days:number){return Math.floor(Date.now()/1000)+Number(days)*86400;}
