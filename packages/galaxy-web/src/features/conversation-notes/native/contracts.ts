import type {z} from "zod/v4";
import {summaryContentSchema} from "../../../../../galaxy-contracts/src/personal-summary-schema.mjs";
import type {sourceRefSchema} from "../../../../../galaxy-contracts/src/personal-summary-schema.mjs";
import type {createWebRuntime} from "../../../runtime.mjs";
import type {ChatMessage,ChatRoom} from "../../chat/chat-workspace-types";



export type SummaryRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'status'|'receiptStatus'|'getLocal'|'putLocal'|'updateLocal'>;
export type SummaryContent=z.infer<typeof summaryContentSchema>;
export type SummaryRef=z.infer<typeof sourceRefSchema>;
export type SummaryRoom=Pick<ChatRoom,'roomId'|'memberRevision'|'retentionDays'>&{endpoint?:string|null};
export type SummaryMessage=Pick<ChatMessage,'state'|'sharedSummaryId'|'messageId'|'revision'|'sequence'|'text'>;
export type SummarySource={available:false;temporarilyUnavailable?:boolean}|{available:true;sequence:string;revision:number;authorId:string;expiresAt:string};
export type SummaryLocation=SummaryRef&Extract<SummarySource,{available:true}>;
export type SummaryEmptyContent={fragments?:never;keyMessageRefs?:never;coverage?:never;generator?:never};
export type SummaryCloudVersion={versionId:string;summaryId:string;revision:number;state:string;content:SummaryContent|SummaryEmptyContent;updatedAt:string;sourcesTemporarilyUnavailable?:boolean};
export type SummaryCloud={summaryId:string;roomId?:string;revision:number;current:SummaryCloudVersion|null;conflicts:SummaryCloudVersion[]};
export type SummaryLocalRecord={summaryId:string;roomId:string;endpoint:string|null;content:SummaryContent;createdAt:number;updatedAt:number;localRevision:number;cloudRevision:number;syncState:string;conflicts:SummaryCloudVersion[];remoteCurrent?:SummaryCloudVersion|null;sourceState?:string};
export type SummaryIndex={summaryId:string;roomId:string;endpoint:string|null;updatedAt:number;localRevision:number;syncState:string;excerpt?:string|null};
export type SummaryPreference={state:string;endpoint:string|null;roomIds:string[]|null;includeExisting:boolean};
export type SummaryStatus={preference:SummaryPreference;connected:boolean;syncTargetMatches:boolean;summaryCount:number};
export type SummaryDraft={summaryId:string;baseRevision:number;content:SummaryContent;note:string;dirty:boolean;draftRevision?:string;blockedSources?:boolean;sourcesTemporarilyUnavailable?:boolean};
export type SummaryShare={shareId:string;roomId:string;authorId:string;state:string;createdAt:string;content:SummaryContent|SummaryEmptyContent;sourceInvalidated?:boolean};
export type SummaryPending={roomId:string;shareId:string;requestHash:string;phase:string;canRetry:boolean;canStartNewSelection:boolean};
export type SummaryPrevious={roomId:string;shareId:string;requestHash:string;receiptState?:string};
export type SummaryContinuation={state:string;reason?:string;serverRetractionConfirmed?:boolean};
export type SummaryBridge={
 local:{
  status:()=>Promise<SummaryStatus>;list:()=>Promise<SummaryIndex[]>;get:(input:{summaryId:string})=>Promise<SummaryLocalRecord|null>;
  save:(input:{summaryId:string;roomId:string;endpoint:string|null;expectedLocalRevision:number;content:SummaryContent})=>Promise<SummaryLocalRecord>;
  choose:(input:{enabled:boolean;endpoint?:string;roomIds?:string[]|null;includeExisting?:boolean},options:{confirmed:true})=>Promise<unknown>;
  synchronize:(input?:{force?:boolean})=>Promise<unknown>;onBinding:()=>Promise<unknown>;
  pull:(input:{summaryId:string})=>Promise<SummaryCloud>;
  resolve:(input:{summaryId:string;expectedLocalRevision:number;content:SummaryContent},options:{confirmed:true})=>Promise<SummaryLocalRecord>;
  deleteCloud:(input:{summaryId:string},options:{confirmed:true})=>Promise<unknown>;
 };
 client:{list:(input:{limit:number;after?:string})=>Promise<{items:SummaryCloud[];nextAfter:string|null}>};
 shared:{get:(input:{roomId:string;shareId:string})=>Promise<SummaryShare>;list:(input:{roomId:string;after?:string})=>Promise<{items:SummaryShare[];nextAfter:string|null}>;retract:(input:{roomId:string;shareId:string})=>Promise<unknown>};
 sourceCheck:(ref:SummaryRef&{roomId:string})=>Promise<SummarySource>;
 readDraft:(roomId:string)=>Promise<SummaryDraft|null>;saveDraft:(roomId:string,value:SummaryDraft|null,options:{expectedRevision:string|null})=>Promise<SummaryDraft|null>;
 summaryIdForRoom:(roomId:string)=>Promise<string>;pending:(roomId:string)=>Promise<SummaryPending|null>;
 resumePending:(roomId:string)=>Promise<SummaryContinuation|null>;previousShares:(roomId:string)=>Promise<SummaryPrevious[]>;
 reconcilePrevious:(roomId:string,shareId:string)=>Promise<SummaryContinuation>;cancelPending:(roomId:string)=>Promise<SummaryContinuation|null>;
 share:(input:{summaryId:string;expectedLocalRevision:number;fragmentIds:string[];keyMessageRefs:SummaryRef[];room:SummaryRoom})=>Promise<SummaryShare>;
};
export type SummaryUnavailableSource={key:string;temporary:boolean};
