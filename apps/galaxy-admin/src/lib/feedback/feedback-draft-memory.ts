import type {FeedbackCategory,FeedbackItem,FeedbackModule,FeedbackState} from "../../components/feedback/feedback-types";
import {feedbackModules,feedbackStates} from "../../components/feedback/feedback-types";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const integer=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=2147483647;
const category=(value:unknown):value is FeedbackCategory=>value===null||value==='problem'||value==='suggestion';
const module=(value:unknown):value is FeedbackModule=>feedbackModules.includes(value as FeedbackModule);
const state=(value:unknown):value is FeedbackState=>feedbackStates.includes(value as FeedbackState);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const iso=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&/([zZ]|[+-]\d\d:\d\d)$/.test(value);

export type FeedbackDraft={baseRevision:number;baseCategory:FeedbackCategory;baseModule:FeedbackModule;baseState:FeedbackState;category:FeedbackCategory;module:FeedbackModule;state:FeedbackState;note:string};
export type FeedbackDraftSnapshot={drafts:Record<string,FeedbackDraft>;readingPositions:[string,number][];directoryPositions:[string,number][]};
export type FeedbackPendingReceipt={operationId:string;kind:'event';feedbackId:string;expectedRevision:number};
export const feedbackDraft=(value:FeedbackItem,note=''):FeedbackDraft=>({baseRevision:value.revision,baseCategory:value.category,baseModule:value.module,baseState:value.state,category:value.category,module:value.module,state:value.state,note});
export const feedbackDraftChanged=(value:FeedbackDraft)=>value.category!==value.baseCategory||value.module!==value.baseModule||value.state!==value.baseState||!!value.note.trim();

/** Only authored processing fields and their base facts; never a feedback body,
 * API reply, permissions, command body or authentication material. */
export function feedbackDraftSnapshot(input:unknown):FeedbackDraftSnapshot{
 const visit=(node:unknown)=>{if(!node||typeof node!=='object')return;for(const[key,value]of Object.entries(node)){if(/password|credential|^(?:body|requestBody|rawBody|token|secret|authorization|cookie|csrfToken|storageState)$/i.test(key))throw Error('Excluded feedback draft field');visit(value);}};visit(input);
 const row=object(input),drafts:Record<string,FeedbackDraft>={};
 for(const[id,value]of Object.entries(object(row.drafts))){const item=object(value);if(!uuid.test(id)||!integer(item.baseRevision,1)||!category(item.baseCategory)||!module(item.baseModule)||!state(item.baseState)||!category(item.category)||!module(item.module)||!state(item.state)||typeof item.note!=='string'||Array.from(item.note).length>2000)continue;
  drafts[id]={baseRevision:item.baseRevision,baseCategory:item.baseCategory,baseModule:item.baseModule,baseState:item.baseState,category:item.category,module:item.module,state:item.state,note:item.note};
 }
 const positions=(input:unknown):[string,number][]=>Array.isArray(input)?input.flatMap(value=>Array.isArray(value)&&typeof value[0]==='string'&&value[0].length<=2048&&typeof value[1]==='number'&&Number.isFinite(value[1])&&value[1]>=0?[[value[0],value[1]] as [string,number]]:[]):[];
 return{drafts,readingPositions:positions(row.readingPositions),directoryPositions:positions(row.directoryPositions)};
}
export function feedbackPendingReceipt(input:unknown):FeedbackPendingReceipt|null{
 const row=object(input);return exact(row,['operationId','kind','feedbackId','expectedRevision'])&&typeof row.operationId==='string'&&uuid.test(row.operationId)&&row.kind==='event'&&typeof row.feedbackId==='string'&&uuid.test(row.feedbackId)&&integer(row.expectedRevision,1)&&row.expectedRevision<=2147483646?{operationId:row.operationId.toLowerCase(),kind:'event',feedbackId:row.feedbackId.toLowerCase(),expectedRevision:row.expectedRevision}:null;
}
export const feedbackReceiptPath=(locator:FeedbackPendingReceipt)=>'/v1/operations/feedback/'+locator.feedbackId+'/operations/'+locator.operationId;

export type FeedbackOriginalReceipt={state:'recorded';operationId:string;feedbackId:string;action:'feedback-update';selection:{expectedRevision:number;category?:FeedbackCategory;module?:FeedbackModule;state?:FeedbackState;noteHash:string|null};result:{feedbackId:string;revision:number;operationId:string;recordedAt:string};recordedAt:string;checkedAt:number;readExpiresAt:number;metadataOnly:true};
export async function feedbackExpectedSelection(input:unknown){
 const row=object(input),note=typeof row.note==='string'?row.note:null;
 const noteHash=note?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(note)))).map(value=>value.toString(16).padStart(2,'0')).join(''):null;
 return{expectedRevision:row.expectedRevision,...(Object.hasOwn(row,'category')?{category:row.category}:{}),...(Object.hasOwn(row,'module')?{module:row.module}:{}),...(Object.hasOwn(row,'state')?{state:row.state}:{}),noteHash};
}
export function feedbackOriginalReceipt(input:unknown,locator:FeedbackPendingReceipt,expected?:Record<string,unknown>,now=Math.floor(Date.now()/1000)):FeedbackOriginalReceipt|null{
 const row=object(input),selection=object(row.selection),result=object(row.result);
 if(!feedbackPendingReceipt(locator)||!exact(row,['state','operationId','feedbackId','checkedAt','readExpiresAt','metadataOnly','action','selection','result','recordedAt'])||row.operationId!==locator.operationId||row.feedbackId!==locator.feedbackId||row.metadataOnly!==true||typeof row.checkedAt!=='number'||!Number.isFinite(row.checkedAt)||typeof row.readExpiresAt!=='number'||!Number.isFinite(row.readExpiresAt)||row.checkedAt>now+5||row.readExpiresAt<=now||row.readExpiresAt<row.checkedAt||row.readExpiresAt-row.checkedAt>31)return null;
 if(row.state!=='recorded'||row.action!=='feedback-update'||!iso(row.recordedAt)||selection.expectedRevision!==locator.expectedRevision||Object.keys(selection).some(key=>!['expectedRevision','category','module','state','noteHash'].includes(key))||!Object.hasOwn(selection,'noteHash')||selection.noteHash!==null&&(typeof selection.noteHash!=='string'||!/^[a-f0-9]{64}$/.test(selection.noteHash))||Object.hasOwn(selection,'category')&&!category(selection.category)||Object.hasOwn(selection,'module')&&!module(selection.module)||Object.hasOwn(selection,'state')&&!state(selection.state))return null;
 if(expected&&(Object.keys(expected).length!==Object.keys(selection).length||Object.keys(expected).some(key=>selection[key]!==expected[key])))return null;
 if(!exact(result,['feedbackId','revision','operationId','recordedAt'])||result.feedbackId!==locator.feedbackId||result.operationId!==locator.operationId||result.revision!==locator.expectedRevision+1||result.recordedAt!==row.recordedAt)return null;
 return row as unknown as FeedbackOriginalReceipt;
}
export function feedbackPostAcknowledged(input:unknown,locator:FeedbackPendingReceipt){const row=object(input),feedback=object(row.feedback);return row.operationId===locator.operationId&&feedback.id===locator.feedbackId&&integer(feedback.revision,locator.expectedRevision+1)&&typeof row.replayed==='boolean';}
