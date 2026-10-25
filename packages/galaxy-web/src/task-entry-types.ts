import type {z} from "zod/v4";
import type {taskEventV2Schema} from "../../galaxy-official/src/shared/task-schema-v2.mjs";
import type {WorkRuntime,WorkSignedRequest,WorkTask} from "./work-task-types";
import type {WorkAttempt,WorkFacts} from "./features/work-records/contracts";
import type {ContactCandidate,SearchRequest,SearchItem,SearchType} from "./help-contact-view-types";
import {object,projectErrorText} from "./features/projects/contracts";
import {taskDraft} from "./task-bounty-client.mjs";
import {isDraftTaskText,isDraftMaterials,isDraftMaterialBodies} from "./task-material-types";
import type {TaskText,TaskMaterial,TaskMaterialBody} from "./task-material-types";

export type TaskEntryRuntime=WorkRuntime;
export type TaskPublication=Omit<WorkSignedRequest,'operationId'|'taskId'>;
export type TaskDraftHead={id:string;revision:number};
export type AttemptRef={id:string;version:number};
export type HelpOriginSelection={ownerId:string;endpoint:string;taskId:string;caseId:string|null;attemptRefs:AttemptRef[];returnTo:string|null};
export type HelpOriginLocator={taskId:string;returnTo:string|null};
export type HelpOriginView={ownerId:string;endpoint:string;task:WorkTask;facts:WorkFacts|null;attempts:WorkAttempt[]};
export type HelpOriginClient={read:(taskId:string)=>Promise<HelpOriginView>;validate:(selection:HelpOriginSelection)=>Promise<HelpOriginView>;check:()=>void;close:()=>void};
export type PreparationInput={keyword:string;functions:string[];capabilityId:string};
export type PreparationSource={search:SearchRequest;ref:{id:string;version:string}};
export type PreparationChoice={input:PreparationInput|null;selected:string[];sources:{subjectId:string;sources:PreparationSource[]}[];open:boolean};
export type PreparationPage={type:SearchType;items:SearchItem[];search:SearchRequest;nextCursor?:string|null;error?:string|null;sourceState?:string;checkedAt?:number;retainedSelection?:boolean};
export type PreparationView={ownerId:string;endpoint:string;input:PreparationInput;pages:PreparationPage[];candidates:ContactCandidate[];selected:string[];preparedAt:string;unavailable?:string[];retainedSelection?:PreparationChoice['sources']};
export type TaskEntryPreparationClient={check:()=>void;query:(input:PreparationInput)=>Promise<PreparationView>;freeze:(payload:TaskPublication,preparation:PreparationView|null,originReturn:{taskId:string;returnTo:string}|null)=>Promise<string>;attach:(task:WorkTask)=>Promise<{originReturn?:{taskId:string;returnTo:string}}|null>;close:()=>void};

export type PublishDraft=Record<string,unknown>&{
 title:TaskText;summary:TaskText;goal:TaskText;situation:TaskText;visibility:string;intent:string;expectedOutcome:TaskText;
 collaboration:string;budgetMode:string;amount:string;minimum:string;maximum:string;unit:string;policyKey:string;capabilityId:string;enrollmentLocal:string;
 materials:TaskMaterial[];materialBodies:TaskMaterialBody[];materialRestore:Record<string,TaskText>;
 helpOrigin?:HelpOriginSelection|null;helpPreparation?:unknown;searchKeyword?:TaskText;searchFunctions?:string;
};
const draftStrings=['visibility','intent','collaboration','budgetMode','amount','minimum','maximum','unit','policyKey','capabilityId','enrollmentLocal'] as const;
const draftTexts=['title','summary','goal','situation','expectedOutcome'] as const;
export function isHelpOriginSelection(value:unknown):value is HelpOriginSelection{
 return object(value)&&typeof value.ownerId==='string'&&typeof value.endpoint==='string'&&typeof value.taskId==='string'
  &&(value.caseId===null||typeof value.caseId==='string')&&(value.returnTo===null||typeof value.returnTo==='string')
  &&Array.isArray(value.attemptRefs)&&value.attemptRefs.every((ref:unknown)=>object(ref)&&typeof ref.id==='string'&&Number.isSafeInteger(ref.version)&&typeof ref.version==='number'&&ref.version>0);
}
export function readPublishDraft(value:Record<string,unknown>={}):PublishDraft{
 const result:Record<string,unknown>=taskDraft(value);
 function valid(raw:Record<string,unknown>):raw is PublishDraft{return draftStrings.every(key=>typeof raw[key]==='string')&&draftTexts.every(key=>isDraftTaskText(raw[key]))
  &&isDraftMaterials(raw.materials)&&isDraftMaterialBodies(raw.materialBodies)&&object(raw.materialRestore)&&Object.values(raw.materialRestore).every(isDraftTaskText)
  &&(raw.helpOrigin===undefined||raw.helpOrigin===null||isHelpOriginSelection(raw.helpOrigin))
  &&(raw.searchKeyword===undefined||isDraftTaskText(raw.searchKeyword))&&(raw.searchFunctions===undefined||typeof raw.searchFunctions==='string');}
 if(!valid(result))throw Object.assign(Error('本机稿的编辑字段或原工作引用暂时无法核对，原稿仍保留。'),{code:'task_draft_value_invalid'});
 return result;
}
export const taskEntryError=(value:unknown,key='message')=>projectErrorText(value,key);
export function taskEntryScope(runtime:TaskEntryRuntime|null,connected:boolean,subjectId?:string,...ids:(string|null|undefined)[]){
 const connection=runtime?.api.snapshot();return JSON.stringify([runtime?.api.endpoint,subjectId,connected,connection?.subjectId,connection?.bindingId,connection?.generation,...ids]);
}

type TaskEvent=z.infer<typeof taskEventV2Schema>;
export type ApplicationPreview=Omit<Extract<TaskEvent,{kind:'apply'}>,'eventId'>;
export type ApplicationDraft=Record<string,unknown>&{proposal:string;scope:string};
export const blankApplication=():ApplicationDraft=>({proposal:'',scope:'',quoteMode:'task',selected:[]});
export function readApplicationDraft(value:unknown):ApplicationDraft{
 if(value===null||value===undefined)return blankApplication();
 if(!object(value)||typeof value.proposal!=='string'||value.scope!==undefined&&typeof value.scope!=='string')throw Error('原参与草稿暂时无法读取，原内容仍保留。');
 return{...blankApplication(),...value,proposal:value.proposal,scope:value.scope??''};
}
export function sameApplication(left:unknown,right:unknown){return object(left)&&object(right)&&left.proposal===right.proposal&&left.scope===right.scope;}
export function meaningfulApplication(value:unknown){return object(value)&&(typeof value.proposal==='string'&&!!value.proposal.trim()||typeof value.scope==='string'&&!!value.scope.trim());}
export type QualificationMissing=string|{condition?:string;available?:number;required?:number;code?:string};
export type QualificationSummaryView={state?:string;missing:QualificationMissing[];calculation:boolean;sourceReasons:string[]};
export function qualificationSummaryView(value:unknown):QualificationSummaryView|null{
 if(!object(value))return null;
 const rows=value.missing??value.reasons;
 const missing:QualificationMissing[]=Array.isArray(rows)?rows.flatMap((row:unknown):QualificationMissing[]=>{
  if(typeof row==='string')return[row];if(!object(row))return[];
  return[{condition:typeof row.condition==='string'?row.condition:undefined,available:typeof row.available==='number'?row.available:undefined,required:typeof row.required==='number'?row.required:undefined,code:typeof row.code==='string'?row.code:undefined}];
 }):[];
 return{state:typeof value.state==='string'?value.state:undefined,missing,calculation:!!value.calculation,sourceReasons:Array.isArray(value.sourceStatuses)?value.sourceStatuses.map((row:unknown)=>object(row)&&typeof row.reason==='string'?row.reason:''):[]};
}
