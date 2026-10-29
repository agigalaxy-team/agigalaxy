import {summaryContentSchema} from "../../../../../galaxy-contracts/src/personal-summary-schema.mjs";
import type {SummaryBridge,SummaryContent,SummaryEmptyContent,SummaryRef,SummarySource,SummaryUnavailableSource} from './contracts';


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
