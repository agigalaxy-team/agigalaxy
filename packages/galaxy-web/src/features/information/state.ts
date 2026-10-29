import type {z} from 'zod/v4';
import {informationQuerySchema,informationSelectionSchema} from "../../../../galaxy-contracts/src/information-v2-schema.mjs";
import type {informationWatchCommandSchema,informationWatchPlanSchema} from "../../../../galaxy-contracts/src/information-v2-schema.mjs";
import type {createWebRuntime} from "../../runtime.mjs";
import type {HistoryFactsRecord} from "../work-records/history-types";

export type InformationRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'status'|'receiptStatus'|'getLocal'|'putLocal'|'updateLocal'|'taskDraftScope'>;
export type InformationQuery=z.input<typeof informationQuerySchema>;
export type InformationSelection=z.infer<typeof informationSelectionSchema>;
type WatchCommand=z.infer<typeof informationWatchCommandSchema>;
export type InformationCommand=Extract<WatchCommand,{action:'start'|'revise'}>|(Exclude<WatchCommand,{action:'start'|'revise'}>&{plan?:never});
export type InformationPlan=z.infer<typeof informationWatchPlanSchema>;
type InformationItemBase={id:string;ref:{id:string;version:string};sourceVersion:string;recordKind?:string;title?:string|null;summary?:string|null};
export type InformationItem=InformationItemBase&({type:'history'|'case';record:HistoryFactsRecord}|{type?:'capsule'|'proof'|'task'|'opportunity'|'worker'|'hub';record:unknown});
export type InformationScope=InformationSelection&{state:string;items:InformationItem[];nextCursor:string|null;complete:boolean};
export type InformationPage={purpose:string;items:InformationScope[]};
export type InformationWatch={watchId:string;revision:number;state:string;plan:InformationPlan;lastCheckedAt:number|null;sourceCoverage:{key:string;state:string;complete:boolean}[]};
export type InformationEvents={watch:InformationWatch;current:InformationPage;events:{id:string;at:number;changes:{kind:string}[]}[]};
export type InformationPrepared={command:InformationCommand;requestHash:string;state:'prepared'|'result-unknown'|'acknowledged';result?:InformationWatch};
export type InformationStopped={command:null;operationId:string;requestHash:string;state:'stopped-local'};
export type InformationOperation=InformationPrepared|InformationStopped;
export type InformationReceipt={state:string;operationId?:string;result?:InformationWatch};
export type InformationEditing={watchId:string;revision:number};
export type QueryComposer={query?:string;types?:string[];windowKind?:string;environment?:string;functions?:string;technologies?:string};
export type WatchComposer={selected?:InformationSelection[];selectionLabels?:Record<string,string>;watchPurpose?:string;expires?:string;report?:'changes'|'daily';reportTime?:string;editing?:InformationEditing|null};
export type ComposerValues={query:QueryComposer;watch:WatchComposer};
export type ComposerKind=keyof ComposerValues;
export type ComposerDraft<K extends ComposerKind=ComposerKind>={version:number;kind:K;revision:string;value:ComposerValues[K]};
export type HonorRule={id?:string;ruleId?:string;version?:string;ruleVersion?:string;name?:string;title?:string;sourceProfile:string};
export type InformationClient={
 query:(input:InformationQuery)=>Promise<InformationPage>;
 rules:()=>Promise<{rules:HonorRule[]}>;
 readComposerDraft:<K extends ComposerKind>(kind:K)=>Promise<ComposerDraft<K>|null>;
 saveComposerDraft:<K extends ComposerKind>(kind:K,value:ComposerValues[K],options:{expectedRevision:string|null})=>Promise<ComposerDraft<K>|null>;
 clearComposerDraft:<K extends ComposerKind>(kind:K,options:{revision:string|null})=>Promise<ComposerDraft<K>|null>;
 prepare:(command:InformationCommand)=>Promise<InformationPrepared>;
 execute:(id:string,options:{confirmed:true})=>Promise<InformationWatch>;
 reconcile:(id:string)=>Promise<InformationReceipt>;
 stopLocal:(id:string,options:{onlyPrepared:true})=>Promise<InformationReceipt>;
 pending:()=>Promise<InformationOperation[]>;
 watches:(input:{limit?:number;after?:string;watchId?:string})=>Promise<{items:InformationWatch[];nextAfter:string|null}>;
 events:(watchId:string)=>Promise<InformationEvents>;
 checkDue:()=>Promise<{items:{state:string}[]}>;
};
export type InformationDetail={selection:InformationSelection;page:InformationPage|null;title:string;unavailable?:boolean};

/** Heterogeneous records are read field by field; the original object is retained for source export. */
export function informationField(value:unknown,key:string):unknown{return typeof value==='object'&&value!==null?Reflect.get(value,key):undefined;}
export function informationText(value:unknown):string|null{
 if(typeof value==='string'&&value.trim())return value;
 if(Array.isArray(value))return value.map(informationText).filter(Boolean).join('\n')||null;
 for(const key of ['summary','description','name']){const field=informationField(value,key);if(typeof field==='string'&&field.trim())return field;}
 return null;
}
export function informationError(error:unknown){const message=informationField(error,'message');return typeof message==='string'&&/[\u3400-\u9fff]/.test(message)?message:'暂时无法完成，请稍后再试。已输入的内容仍保留。';}
export function informationLocalTime(seconds:number){const d=new Date(seconds*1000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,19);}
export function restoredInformationSearch(history:unknown,owner:string):InformationQuery|null{
 const saved=informationField(history,'informationSearch');if(informationField(saved,'owner')!==owner)return null;
 const request=informationField(saved,'request');return validQuery(request)?request:null;
}
function validQuery(value:unknown):value is InformationQuery{return informationQuerySchema.safeParse(value).success;}
export function informationSelections(value:unknown):InformationSelection[]{return informationSelectionSchema.array().parse(value);}
export const informationOperationActive=(value:InformationOperation):value is InformationPrepared=>value.command!==null&&value.state!=='acknowledged';

export type InformationWorkspaceProps = {
  runtime: InformationRuntime|null;
  subjectId?: string;
  connected: boolean;
  navigate: (path: string) => void;
  onNeedIdentity?: () => void;
  watchId?: string;
};
