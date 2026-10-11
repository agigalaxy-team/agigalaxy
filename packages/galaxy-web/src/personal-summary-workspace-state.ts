import type {z} from 'zod/v4';
import {summaryContentSchema} from '../../galaxy-official/src/shared/personal-summary-schema.mjs';
import type {sourceRefSchema} from '../../galaxy-official/src/shared/personal-summary-schema.mjs';
import type {createWebRuntime} from './runtime.mjs';
import type {ChatMessage,ChatRoom} from './chat-workspace-types';

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
export const emptySummary=():SummaryContent=>({generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:false},fragments:[],keyMessageRefs:[]});
export const summaryRefKey=(r:SummaryRef)=>r.messageId+':'+r.revision;
export function summaryError(error:unknown){
 const value=typeof error==='object'&&error!==null?Reflect.get(error,'code')??Reflect.get(error,'message'):undefined;
 const messages:Record<string,string>={summary_draft_conflict:'另一页已保存不同的输入。本页内容仍在，请读取已保存输入后比较，或先保存本页副本。',summary_draft_unavailable:'本机草稿暂时无法读取。本页输入仍保留。',summary_sync_not_authorized:'私有同步的授权或范围已变化，请重新查看选择。',local_summary_conflict:'另一处编辑已保存，请重新读取并比较版本。',shared_summary_audience_changed:'房间成员已变化，请重新选择分享范围。',shared_summary_sources_unavailable:'选中来源已变化或暂不可用，请重新核对。',shared_summary_request_conflict:'原分享标识与内容不一致，请保留原记录核对。',chat_access_denied:'当前无法读取这个房间。原分享的保存位置仍保留。',connection_required:'当前未连接，已保存的本地笔记仍在。',summary_binding_changed:'身份连接已变化，请重新打开当前笔记。',chat_delivery_unknown:'分享结果尚未确认，原操作保留，会继续核对。'};
 return typeof value==='string'?(messages[value]??(/[\u3400-\u9fff]/.test(value)?value:'暂时无法完成，原输入和分享记录仍保留。')):'暂时无法完成，原输入和分享记录仍保留。';
}
/** Called only after local.save has returned the saved record. */
export function summaryDraftCleanupNotice(error:unknown){const value=typeof error==='object'&&error!==null?Reflect.get(error,'code')??Reflect.get(error,'message'):undefined;return value==='summary_draft_conflict'?'原笔记已保存。另一页保存的输入仍保留，未清理草稿。本页未保存输入也仍在。':'原笔记已保存。草稿清理尚未确认，请保留本页输入。';}
export function summaryVersionReadable(value:SummaryContent|SummaryEmptyContent):value is SummaryContent{return summaryContentSchema.safeParse(value).success;}
export type SummaryUnavailableSource={key:string;temporary:boolean};
/** Read only the exact sources of this page's input; never replace it with another page's draft. */
export async function readSummaryUnavailableSources(bridge:Pick<SummaryBridge,'sourceCheck'>,roomId:string,content:SummaryContent){
 const references=new Map([...content.fragments.flatMap(fragment=>fragment.sourceRefs),...content.keyMessageRefs].map(reference=>[summaryRefKey(reference),reference]));
 const unavailable:SummaryUnavailableSource[]=[];
 for(const [key,reference] of references){let source:SummarySource;try{source=await bridge.sourceCheck({roomId,...reference});}catch{source={available:false,temporarilyUnavailable:true};}if(!source.available)unavailable.push({key,temporary:source.temporarilyUnavailable===true});}
 return unavailable;
}
/** Temporary failures affect the view; permanent losses also filter the exact local input. */
export function filterSummarySources(content:SummaryContent,unavailable:SummaryUnavailableSource[],retainTemporary=false):SummaryContent{
 const hidden=new Set(unavailable.filter(source=>!retainTemporary||!source.temporary).map(source=>source.key));
 const fragments=content.fragments.filter(fragment=>!fragment.sourceRefs.some(reference=>hidden.has(summaryRefKey(reference)))),keyMessageRefs=content.keyMessageRefs.filter(reference=>!hidden.has(summaryRefKey(reference)));
 return fragments.length===content.fragments.length&&keyMessageRefs.length===content.keyMessageRefs.length?content:{...content,fragments,keyMessageRefs,coverage:{...content.coverage,complete:false}};
}
/** The excerpt reads the current local permission-filtered version, never a cached shared body. */
export async function readSummaryIndex(bridge:SummaryBridge){const items=await bridge.local.list();return Promise.all(items.map(async(item,index)=>{if(index>=12)return item;try{const value=await bridge.local.get({summaryId:item.summaryId});return {...item,excerpt:value?.content.fragments[0]?.text.slice(0,120)??null};}catch{return item;}}));}
