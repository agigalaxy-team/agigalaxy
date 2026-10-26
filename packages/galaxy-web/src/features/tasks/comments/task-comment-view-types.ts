import * as z from 'zod/v4';
import {taskCommentV2Schema,commentReportV2Schema,commentModerationV2Schema} from "../../../../../galaxy-official/src/shared/task-comment-v2-schema.mjs";
import type {WorkRuntime} from "../work-task-types";
export type CommentKind='create'|'edit'|'correct'|'retract'|'report'|'supplement'|'appeal'|'withdraw-report'|'pause'|'resolve'|'resume';
export type CommentType='comment'|'report'|'governance';
export type CommentTask={taskId:string;requesterId:string;request:{visibility:'Private'|'Public'};participations?:{subjectId:string}[]};
export type CommentProps={task:CommentTask;runtime:WorkRuntime;subjectId?:string;connected:boolean;navigate:(path:string)=>void};
export type CommentView={commentId:string;taskId:string;authorId:string;revision:number;currentRevision:number;state:string;body:string|null;replyTo:{id:string;revision:number;body:string|null;state:string}|null;createdAt:string;expiresAt:string;canEdit:boolean;canCorrect:boolean;canRetract:boolean;rule?:{version:string;reasons:string[]}};
export type CommentTarget=Pick<CommentView,'commentId'|'taskId'|'revision'|'currentRevision'>&Partial<Omit<CommentView,'commentId'|'taskId'|'revision'|'currentRevision'>>;
export type CommentReportView={reportId:string;taskId:string;version:number;state:string;target:{type:'task-comment';id:string;revision:number};pauseUntil:string|null;source:CommentView|null;events:{eventId:string;authorId:string;kind?:string;summary:string}[];decisionRecipients:string[];canModerate:boolean;canReviewSource:boolean;canAppeal:boolean;canSupplement:boolean;canWithdrawReport:boolean};
export type CommentReportTarget=Pick<CommentReportView,'reportId'|'taskId'|'version'>&Partial<Omit<CommentReportView,'reportId'|'taskId'|'version'>>;
export type CommentEditor={kind:CommentKind;comment?:CommentTarget;report?:CommentReportTarget};
export type CommentCategory=z.infer<typeof commentReportV2Schema>['category'];
export type CommentForm={id:string;revision:number;editor:CommentEditor|null;text:string;reason:string;audience:string[];category:CommentCategory;verdict:'upheld'|'dismissed';disposition:'unchanged'|'approve'|'reject';rule:string;pauseMinutes:number;operationId?:string};
export type CommentSnapshot=CommentForm&{editor:CommentEditor};
export type CommentDraft=Omit<CommentForm,'editor'>&{kind:CommentKind;commentRef?:{commentId:string;revision:number}|null;reportRef?:{id:string;version:number}|null};
export type CommentReading={query:string;submittedQuery:string;pages:number;reportOpen:boolean;reportComment:string|null;reportPages:number};
export const commentReadingInitial:CommentReading={query:'',submittedQuery:'',pages:1,reportOpen:false,reportComment:null,reportPages:1};
export type CommentConfig={moderatorIds?:string[];configured?:boolean;canModerate?:boolean;scopeRequired?:string;unavailable?:boolean;message?:string};
export type CommentQuota={quotas?:{category:string;remaining:number;resetAt?:string|null;used:number;limit:number}[];unavailable?:boolean};
type CommentEvent=z.infer<typeof taskCommentV2Schema>;
type ReportEvent=z.infer<typeof commentReportV2Schema>;
export type CommentPayload={schemaVersion:2;id:string;kind?:string;commentId?:string;taskId?:string;expectedRevision?:number;body?:string;visibility?:'inherit-task';replyTo?:Extract<CommentEvent,{kind:'create'}>['replyTo'];reason?:string;summary?:string;target?:ReportEvent['target'];category?:CommentCategory;reportId?:string;expectedVersion?:number;until?:number;rule?:string;verdict?:'upheld'|'dismissed';reviewDisposition?:'unchanged'|'approve'|'reject'};
type ContinuationDetails={operationId?:string;type?:CommentType;payloadHash?:string;reason?:string;message?:string;retryAt?:string|number|null;conditionUnavailable?:boolean;blockedReason?:string|null};
export type CommentContinuation=ContinuationDetails&{state:'none'|'acknowledged'|'absent'|'conflict'|'unconfirmed'|'reuse-original-authorization'|'stopped-local'|'awaiting-receipt'|'waiting'|'ready'|'changed'};
export type CommentPending=ContinuationDetails&{operationId:string;type:CommentType;payloadHash:string;state:string};
export type CommentPrepared={operationId:string;type:CommentType;payload:CommentPayload;payloadJson:string;payloadHash:string;visibility:'Private'|'Public';viewers:string[];expiresAt:number};
export type CommentOriginal=Omit<CommentPrepared,'expiresAt'>&ContinuationDetails&{expiresAt:number|null;state:string};
export type CommentReauthorization=Omit<CommentOriginal,'state'|'expiresAt'>&{state:'reauthorization-required';expiresAt:number;originalExpiresAt:number|null};
export type CommentAuthorization=CommentContinuation|CommentReauthorization;
export type CommentPreview={kind:'replace-draft';next:CommentEditor}|{kind:'prepared';operation:CommentPrepared;snapshot:CommentSnapshot}|{kind:'recovery';record:CommentOriginal;target:CommentContinuation;authorization:CommentAuthorization|null}|{kind:'stop-original';record:CommentOriginal}|{kind:'discard'|'reload-draft'};
export type CommentSourceChange={kind:'task';task:CommentTask;canContinue:true}|{kind:'comment';source:CommentView|null;nextKind?:CommentKind;canContinue:boolean}|{kind:'report';source:CommentReportView|null;canContinue:boolean};
export type CommentClient={
 draft:{load:()=>Promise<CommentDraft|null>;save:(draft:CommentDraft)=>Promise<unknown>;flush:()=>Promise<unknown>;clear:(expected:{id:string;revision:number})=>Promise<boolean>};
 prepare:(type:CommentType,payload:CommentPayload,scope:{visibility:'Private'|'Public';viewers:string[]})=>Promise<CommentPrepared>;
 execute:(operation:CommentPrepared,options:{confirmed:true})=>Promise<CommentContinuation>;
 pending:()=>Promise<CommentPending[]>;reconcile:(operationId:string)=>Promise<CommentContinuation>;resumePending:(operationId:string)=>Promise<CommentContinuation>;
 reviewPending:(operationId:string)=>Promise<CommentOriginal>;reviewAuthorization:(operationId:string)=>Promise<CommentAuthorization>;
 reauthorize:(preview:CommentReauthorization,options:{confirmed:true})=>Promise<CommentContinuation>;
 stopLocalRetry:(operationId:string,options:{confirmed:true})=>Promise<CommentContinuation>;
 get:(id:string)=>Promise<CommentView>;governanceConfig:()=>Promise<CommentConfig>;
 reports:(input:{commentId?:string;after?:string;limit:number})=>Promise<{items:CommentReportView[];nextAfter:string|null;scanTruncated?:boolean}>;
 report:(id:string)=>Promise<CommentReportView>;
};
const preparedComment=z.looseObject({type:z.enum(['comment','report','governance']),operationId:z.uuid(),payload:z.looseObject({schemaVersion:z.literal(2),id:z.uuid()}),payloadJson:z.string(),payloadHash:z.string(),visibility:z.enum(['Private','Public']),viewers:z.array(z.string()),expiresAt:z.number().int().positive()});
export function assertPreparedComment(value:unknown):asserts value is CommentPrepared{
 const record=preparedComment.parse(value),schema=record.type==='comment'?taskCommentV2Schema:record.type==='report'?commentReportV2Schema:commentModerationV2Schema;
 schema.parse(record.payload);
 if(record.operationId!==record.payload.id||record.payloadJson!==JSON.stringify(record.payload))throw Error('评论预览与原载荷不一致，请重新核对。');
 // Validation leaves the original preview object intact for the client's WeakMap.
}
export function commentPermitted(kind:string|undefined,comment:CommentTarget|null|undefined,report:CommentReportTarget|null|undefined,subjectId?:string){
 if(comment){if(kind==='create')return !!comment.body;if(kind==='report')return !!comment.body||comment.authorId===subjectId;if(kind==='edit')return !!comment.canEdit;if(kind==='correct')return !!comment.canCorrect;if(kind==='retract')return !!comment.canRetract;return false;}
 if(report){if(kind==='supplement')return !!report.canSupplement;if(kind==='appeal')return !!report.canAppeal;if(kind==='withdraw-report')return !!report.canWithdrawReport;if(kind==='pause')return !!report.canModerate&&!!report.canReviewSource;if(kind==='resolve')return !!report.canModerate&&!['resolved','withdrawn'].includes(report.state??'');if(kind==='resume')return !!report.canModerate&&!!report.pauseUntil;return false;}
 return kind==='create';
}
export function commentSubmission(snapshot:CommentSnapshot,taskId:string,privateTask:boolean,now:number):{type:CommentType;payload:CommentPayload;visibility:'Private'|'Public'}{
 const {kind,comment,report}=snapshot.editor;
 if(kind==='create'||kind==='edit'||kind==='correct'||kind==='retract'){
  if(kind!=='create'&&!comment)throw Error('请重新选择原评论的准确版本。');
  const payload=taskCommentV2Schema.parse({schemaVersion:2,id:crypto.randomUUID(),commentId:kind==='create'?crypto.randomUUID():comment?.commentId,taskId,expectedRevision:kind==='create'?0:comment?.revision,kind,
   ...(kind==='retract'?{}:{body:snapshot.text,visibility:'inherit-task',...(kind==='create'?{replyTo:comment?{id:comment.commentId,revision:comment.revision}:null}:{}),...(kind==='correct'?{reason:snapshot.reason}:{})})});
  return{type:'comment',payload,visibility:kind==='retract'||privateTask?'Private':'Public'};
 }
 if(kind==='report'){
  if(!comment)throw Error('请重新选择要处理的原评论版本。');
  return{type:'report',visibility:'Private',payload:commentReportV2Schema.parse({schemaVersion:2,id:crypto.randomUUID(),target:{type:'task-comment',id:comment.commentId,revision:comment.revision},category:snapshot.category,summary:snapshot.text})};
 }
 if(!report)throw Error('请重新选择原处理记录的准确版本。');
 const payload:CommentPayload={schemaVersion:2,id:crypto.randomUUID(),reportId:report.reportId,expectedVersion:report.version,kind,summary:snapshot.text,
  ...(kind==='pause'?{until:Math.floor(now/1000)+snapshot.pauseMinutes*60,rule:snapshot.rule}:{}),
  ...(kind==='resolve'?{rule:snapshot.rule,verdict:snapshot.verdict,reviewDisposition:snapshot.disposition}:{})};
 commentModerationV2Schema.parse(payload);
 return{type:'governance',visibility:'Private',payload};
}
