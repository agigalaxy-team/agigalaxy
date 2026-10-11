import type {z} from 'zod/v4';
import type {createWebRuntime} from './runtime.mjs';
import type {chatCreateSchema,chatDecisionSchema,chatSendSchema} from '../../galaxy-official/src/shared/chat-schema.mjs';
import type {attachmentReferenceSchema} from '../../galaxy-official/src/shared/chat-attachments-schema.mjs';

export type ChatRuntime=Awaited<ReturnType<typeof createWebRuntime>>;
export type ChatAttachmentReference=z.infer<typeof attachmentReferenceSchema>;
export type ChatProposal=Omit<z.infer<typeof chatDecisionSchema>,'decisionId'|'expectedRevision'>&{decisionId?:string};
export type ChatRoom={
 roomId:string;title:string;kind:'ordinary'|'ai-subzone';parentRoomId:string|null;taskRefs:string[];
 revision:number;memberRevision:number;state:string;mode:string;ownerSubjectId:string|null;persistent:boolean;retentionDays:7|30|90;
 decisionRequired:boolean;members:{subjectId:string;joinedAt:string;singleMemberPromptDismissed:boolean}[];transportAvailable:boolean;
};
export type ChatDecision={
 decisionId:string;roomId:string;action:z.infer<typeof chatDecisionSchema>['action'];payload:z.infer<typeof chatDecisionSchema>;
 state:string;effectiveState?:string;memberRevision:number;proposerSubjectId:string;
 myVote:{subjectId:string;choice:string}|null;canApprove:boolean;canReject:boolean;canCancel:boolean;canAccept:boolean;canDecline:boolean;
 actionReasons?:{approve:string|null;reject:string|null;cancel:string|null;accept:string|null;decline:string|null};title?:string;
};
export type ChatMessage={
 messageId:string;clientMessageId:string;sequence:string;subjectId:string;actorKind:'human'|'agent';agentGrantId:string|null;
 state:string;revision:number;text:string|null;replyTo:string|null;sharedSummaryId:string|null;sentAt:string;expiresAt:string;editedAt:string|null;kind?:string;
 attachments?:{attachmentId:string;state:string;name?:string;size?:number;sha256?:string;expiresAt?:string|null}[];
};
export type ChatHistory={messages:ChatMessage[];next:string|null;previous?:string|null;scannedThrough:string;complete:boolean};
export type ChatPending={roomId:string|null;path:string;input:Partial<z.infer<typeof chatSendSchema>&z.infer<typeof chatCreateSchema>&z.infer<typeof chatDecisionSchema>>;requestHash?:string};
export type ChatLinkedTask={id:string;title:string;caseId:string|null;available:true}|{id:string;available:false};
export type ChatAction={kind:'leave'|'dissolve'}|{kind:'retract';messageId:string};

export function chatErrorCode(reason:unknown):string|undefined{
 if(typeof reason==='string')return reason;
 if(!reason||typeof reason!=='object')return undefined;
 const value=('code' in reason?reason.code:undefined)??('message' in reason?reason.message:undefined);
 return typeof value==='string'?value:undefined;
}
export function chatMessageAvailable(message:ChatMessage|null|undefined,now:number):message is ChatMessage{
 return !!message&&Number.isFinite(Date.parse(message.expiresAt))&&Date.parse(message.expiresAt)>now;
}
export function availableChatMessages(messages:ChatMessage[],now:number):ChatMessage[]{return messages.filter(message=>chatMessageAvailable(message,now));}
export function nextChatMessageExpiry(messages:(ChatMessage|null|undefined)[],now:number):number|null{
 const deadlines=messages.flatMap(message=>{const expiresAt=message?Date.parse(message.expiresAt):NaN;return Number.isFinite(expiresAt)&&expiresAt>now?[expiresAt]:[];});
 return deadlines.length?Math.min(...deadlines):null;
}
