export type ReportState='received'|'reviewing'|'resolved'|'appealed'|'withdrawn';
export type ReportCategory='advertising'|'harassment'|'privacy'|'misrepresentation'|'other';
export type ChatScope='sending-paused'|'invitations-paused';
export type ReportItem={
 reportId:string;target:{type:'room';id:string;version:number};currentTarget:{type:'room';id:string;version:number;state:string}|null;
 category:ReportCategory;version:number;state:ReportState;reporterAccountId:string|null;createdAt:string;updatedAt:string;closedAt:string|null;handling:string;
 materialCount?:number;additionalMaterialCapacity?:number;
 ownRestriction:{scopes:ChatScope[];until:string;eventId:string}|null;canModerate:boolean;materialsExpired:boolean;roomHistoryGranted:false;readExpiresAt:number;
};
export type ReportAttachment={attachmentId:string;name?:string;mediaType?:string;size?:number;expiresAt?:string;state:string;contentAvailable:boolean};
export type MessageVisibilityAction='hide'|'restore'|'keep';
export type MessageVisibilityDecision={eventId:string;operatorId:string|null;operatorDisplayName?:string|null;at:string;action:MessageVisibilityAction;sourceRevision:number};
export type MessageModeration={hidden:boolean;ownHidden:boolean;revision:number;sourceRevision:number|null;appliesToCurrent:boolean;canHide:boolean;canRestore:boolean;canKeep:boolean;initialDecision:MessageVisibilityDecision|null;currentDecision:MessageVisibilityDecision|null};
export type ReportMaterial={
 eventId:string;messageId:string;revision:number;roomId:string;authorRef:string;authorDisplayName?:string|null;authorUid?:string|null;authorAccountId?:string|null;
 sentAt:string;sourceExpiresAt:string;state:'available'|'unavailable';text:string|null;attachments:ReportAttachment[];moderation?:MessageModeration;
};
export type ReportEvent={eventId:string;kind:string;version:number;at:string;actorKind:string;accountId:string|null;operatorId:string|null;operatorDisplayName?:string|null;summary:string|null;decision?:{rule?:string|null;verdict?:string|null;scopes?:ChatScope[];until?:number|null;message?:{messageId:string;revision:number;action:MessageVisibilityAction;hidden:boolean}}};
export type ReportDetail=ReportItem&{materials:ReportMaterial[];events:ReportEvent[]};
export type ReportPage={items:ReportItem[];nextAfter:string|null;readExpiresAt:number};
export type ReportResource=ReportPage|ReportDetail;
export const reportStates:Record<ReportState,string>={received:'待处理',reviewing:'处理中',resolved:'已处理',appealed:'申诉中',withdrawn:'已撤回'};
export const reportCategories:Record<ReportCategory,string>={advertising:'广告',harassment:'骚扰',privacy:'隐私',misrepresentation:'冒用与误导',other:'其他'};
export const scopeLabels:Record<ChatScope,string>={'sending-paused':'暂停发送消息','invitations-paused':'暂停发出邀请'};
export const reportEventNames:Record<string,string>={report:'提交举报',supplement:'补充材料',appeal:'提出申诉','withdraw-report':'撤回举报',review:'记录处理进展',pause:'限制对话参与',resume:'解除本案参与限制',resolve:'记录处理结果','message-hide':'屏蔽选中消息','message-restore':'解除本案消息屏蔽','message-keep':'维持本案消息处置'};
export const messageVisibilityLabels:Record<MessageVisibilityAction,string>={hide:'屏蔽消息',restore:'解除本案屏蔽',keep:'维持本案处置'};
export const chatReportUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ChatReportFilters={report:string;state:ReportState|'';room:string;after:string;trail:string;view:'conversation'|'history'};
export function normalizeChatReportFilters(input:Partial<Record<keyof ChatReportFilters,string>>):ChatReportFilters{
 const identifier=(value:string|undefined)=>chatReportUuid.test(value??'')?value!.toLowerCase():'';
 const trail=(input.trail??'').split(',').slice(-30).filter(value=>value==='start'||chatReportUuid.test(value)).map(value=>value.toLowerCase()).join(',');
 return{report:identifier(input.report),state:Object.hasOwn(reportStates,input.state??'')?input.state as ReportState:'',room:identifier(input.room),after:identifier(input.after),trail,view:input.view==='history'?'history':'conversation'};
}
export function chatReportReadPath(filters:ChatReportFilters){
 const query=new URLSearchParams({limit:'20'});
 if(filters.state)query.set('state',filters.state);
 if(filters.room)query.set('roomId',filters.room);
 if(filters.after)query.set('after',filters.after);
 return '/v1/operations/chat-reports?'+query;
}
export function chatReportHref(filters:ChatReportFilters,change:Partial<ChatReportFilters>={}){
 const next=normalizeChatReportFilters({...filters,...change}),query=new URLSearchParams();
 for(const key of ['report','state','room','after','trail'] as const)if(next[key])query.set(key,next[key]);
 if(next.view!=='conversation')query.set('view',next.view);
 return '/admin/operations/chat-reports'+(query.size?'?'+query:'');
}
export const reportMaterialKey=(value:Pick<ReportMaterial,'eventId'|'messageId'|'revision'>)=>value.eventId+':'+value.messageId+':'+value.revision;
export function materialAuthorLabel(value:ReportMaterial){
 return value.authorDisplayName||value.authorUid||(value.authorRef.startsWith('account:')?'账户 '+value.authorRef.slice(8,16):value.authorRef)||'来源未记录';
}
