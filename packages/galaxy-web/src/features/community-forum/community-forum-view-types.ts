import type {z} from 'zod/v4';
import type {newForumDraft} from './community-forum-client.mjs';
import {forumCreatePostSchema,forumPublishVersionSchema,forumCreateReplySchema,forumWithdrawPostSchema,forumWithdrawVersionSchema,forumWithdrawReplySchema,forumReportSchema,forumSupplementSchema,forumWithdrawReportSchema,forumAppealSchema,forumResolveSchema,forumTargetSchema,forumPostsQuerySchema} from "../../../../galaxy-contracts/src/community-forum-v1-schema.mjs";
import {forumReadTopicSchema} from "../../../../galaxy-contracts/src/community-forum-topics-v1.mjs";
import {forumAudienceSchema,forumAudienceRuleSchema,forumSectionWriteSchema} from "../../../../galaxy-contracts/src/community-forum-access-v2.mjs";
import type {ForumAttachmentClient,ForumAttachmentView} from './forum-attachments';

export type ForumDraft=ReturnType<typeof newForumDraft>;
export type ForumKind=ForumDraft['kind'];
export type ForumDraftRef=Pick<ForumDraft,'id'|'revision'>;
export type ForumDraftTarget=Partial<{kind:'post-version'|'reply';postId:string;versionId:string;versionNumber:number;replyId:string;contentRevision:1;expectedHeadVersion:number;reportId:string;expectedReportVersion:number;sectionId:string;expectedVersion:number;accountId:string}>;
export type ForumDraftValues=Partial<Pick<ForumDraft,'title'|'body'|'linksText'|'attachments'|'topic'|'replyTo'|'category'|'resolution'|'hide'|'hideHours'|'audience'|'sectionId'|'theme'|'description'|'sectionState'>>;
export type ForumAudience=z.infer<typeof forumAudienceSchema>;
export type ForumAudienceRule=z.infer<typeof forumAudienceRuleSchema>;
export type ForumAccessOptions={rules:{kind:string;label:string}[];honors:{ruleId:string;ruleVersion:string;label:string;issuer:string}[];externalCredentials:{kind:'external-credential';issuerId:string;conditionId:string;label:string;issuerName:string}[];externalCredentialsState:string;checkedAt:number};
export type ForumSection={sectionId:string;title:string;theme:string;description:string;maintainerAccountId:string;creatorSubjectId:string|null;version:number;state:'active'|'archived';category:ForumTopic|null;audience:ForumAudience;canMaintain:boolean;canParticipate:boolean;createdAt:number|string;updatedAt:number|string;checkedAt:number};
export type ForumNotification=ForumAuthorFields&{replyId:string;postId:string;postVersionId:string;title:string;preview:string;at:number|string;read:boolean;sourceExpiresAt:number|string;readUntil?:number};
export type ForumTopic=z.infer<typeof forumReadTopicSchema>;
export type ForumPostsQuery=z.input<typeof forumPostsQuerySchema>;
export type ForumTarget=z.infer<typeof forumTargetSchema>;
export type ForumPayload=z.infer<typeof forumCreatePostSchema>|z.infer<typeof forumPublishVersionSchema>|z.infer<typeof forumCreateReplySchema>|z.infer<typeof forumWithdrawPostSchema>|z.infer<typeof forumWithdrawVersionSchema>|z.infer<typeof forumWithdrawReplySchema>|z.infer<typeof forumReportSchema>|z.infer<typeof forumSupplementSchema>|z.infer<typeof forumWithdrawReportSchema>|z.infer<typeof forumAppealSchema>|z.infer<typeof forumResolveSchema>|z.infer<typeof forumSectionWriteSchema>;
export type ForumPreviewPayload=Partial<Pick<z.infer<typeof forumCreatePostSchema>,'title'|'body'|'links'|'topic'|'publishedUntil'|'audience'|'sectionId'>&Pick<z.infer<typeof forumReportSchema>,'summary'>&Pick<z.infer<typeof forumResolveSchema>,'reason'|'resolution'|'effect'>&Pick<z.infer<typeof forumSectionWriteSchema>,'theme'|'description'|'state'>>;
export type ForumPrepared={kind:ForumKind;payload:ForumPayload;visibility:'Public'|'Private';viewers:string[];payloadHash:string};
export type ForumReview=ForumPrepared&{operationId:string;expiresAt:number|null;originalBindingId:string|null;requiresReauthorization:boolean};
export type ForumLocator={kind:'post'|'post-version'|'reply'|'report'|'section';postId?:string;versionId?:string;versionNumber?:number;replyId?:string;postVersionId?:string;contentRevision?:1;reportId?:string;sectionId?:string};
export type ForumPostLocator={kind:'post';postId:string};
export type ForumPostLocation={kind:'post'|'post-version';postId:string;versionId?:string;versionNumber?:number};
export type ForumVersionLocator={kind:'post-version';postId:string;versionId:string;versionNumber:number};
export type ForumReplyLocator={kind:'reply';replyId:string;contentRevision:1;postId:string;postVersionId:string};
export type ForumPostPayload=Pick<z.infer<typeof forumCreatePostSchema>,'title'|'body'|'links'|'topic'|'attachments'>;
export type ForumContentPayload=Pick<z.infer<typeof forumCreateReplySchema>,'body'|'replyTo'|'attachments'>|ForumPostPayload;
export type ForumAuthorFields={authorId?:string|null;authorAccountId?:string|null;author?:{kind:'account'|'identity'|'business-operator';accountId?:string|null;subjectId?:string|null;operatorId?:string;displayName?:string|null;uid?:string|null;avatarKey?:string|null;subjectType?:'person'|'organization'|'agent'|null}};
export type ForumContentView={
 locator:ForumPostLocation|ForumReplyLocator;availability:string;checkedAt:number;headVersion?:number;currentVersionId?:string|null;
  payload?:ForumContentPayload;attachments?:ForumAttachmentView[];publishedUntil?:number;permissionId?:string;topic?:ForumTopic;createdAt?:number;versionCreatedAt?:number;updatedAt?:number;audience?:ForumAudience;sectionId?:string|null;canParticipate?:boolean;audienceInherited?:boolean;
}&ForumAuthorFields;
export type ForumPostView=ForumContentView&{locator:ForumPostLocation;payload?:ForumPostPayload};
export type ForumReplyView=ForumContentView&{locator:ForumReplyLocator;payload?:Pick<z.infer<typeof forumCreateReplySchema>,'body'|'replyTo'|'attachments'>};
export type ForumVersionEntry={locator:ForumVersionLocator;availability:string;checkedAt:number;permissionId?:string;publishedUntil?:number};
export type ForumOwnedPostSummary=ForumAuthorFields&{locator:ForumPostLocator;headVersion:number;currentVersionId:string|null;state:string;checkedAt:number;availability?:string;payload?:ForumPostPayload;publishedUntil?:number;topic?:ForumTopic;createdAt?:number;versionCreatedAt?:number;updatedAt?:number;audience?:ForumAudience;sectionId?:string|null;canParticipate?:boolean};
export type ForumOwnedVersion={locator:ForumVersionLocator;state:string;permissionId:string;publishedUntil:number;availability:string};
export type ForumOwnedPost=ForumOwnedPostSummary&{versionLocators:ForumOwnedVersion[]};
export type ForumOwnedReply=ForumAuthorFields&{locator:ForumReplyLocator;revision:number;state:string;permissionId:string;publishedUntil:number;availability:string};
export type ForumCardView=ForumPostView|ForumOwnedPostSummary;
export type ForumReportEvent=ForumAuthorFields&{operationId:string;governanceEventId:string;version:number;kind:'report'|'supplement'|'withdraw'|'appeal'|'resolve';payload?:ForumPreviewPayload;availability?:string};
export type ForumReport={reportId:string;target:ForumTarget;version:number;state:string;events:ForumReportEvent[];canAppeal:boolean;canSupplement:boolean;canWithdrawReport:boolean;canModerate:boolean;actionAccountId?:string|null;decisionRecipients?:string[];decisionAccountRecipients?:string[];operationsHandling?:boolean;operationsDisclosure?:string};
export type ForumConfig={moderatorIds:string[];maxPermissionSeconds:number;maxGovernanceHideSeconds:number;report?:ForumReport;operationsHandling?:boolean;operationsDisclosure?:string};
export type ForumAccountChoice={id:string;accountId?:string;displayName?:string|null;subjectType?:'person'|'organization'|'agent'|null;current?:boolean};
export type ForumQuota={accountVerified:boolean;accountId?:string|null;currentAccount?:ForumAccountChoice|null;availableAccounts?:ForumAccountChoice[];reason?:string;policyHash:string;policy:{maxPermissionSeconds:number};publication?:{checkedAt:number;minPublishedUntil:number;maxPublishedUntil:number;maxPermissionSeconds:number}};
export type ForumPermission={kind?:string;publishedUntil:number;originBindingExpiresAt?:number|null;stoppedReasons:string[]};
export type ForumPending={operationId:string;payloadHash:string;kind:ForumKind;context:string;draftRef:ForumDraftRef|null;state:string;publishedUntil?:number;locator?:ForumLocator;originalBindingId?:string|null};
export type ForumReceipt={status:'absent'|'acknowledged'|'none';operationId?:string;payloadHash?:string;locator?:ForumLocator};
export type ForumPage<T>={items:T[];nextAfter:string|null;order?:'published'|'id'};
export type ForumClient={
  check:()=>void;close:()=>void;attachments:ForumAttachmentClient;
 draft:{load:()=>Promise<ForumDraft|null>;save:(value:ForumDraft)=>Promise<ForumDraft>;flush:()=>Promise<void>;clear:(reference:ForumDraftRef)=>Promise<boolean>;importVisitor:(reference:ForumDraftRef)=>Promise<{status:string;draft:ForumDraft|null}>};
 posts:(input?:ForumPostsQuery)=>Promise<ForumPage<ForumPostView>>;owned:(input?:ForumPostsQuery)=>Promise<ForumPage<ForumOwnedPostSummary>>;reports:(input?:{after?:string})=>Promise<ForumPage<ForumReport>>;
 post:(postId:string)=>Promise<ForumPostView>;version:(postId:string,versionId:string)=>Promise<ForumPostView>;reply:(replyId:string)=>Promise<ForumReplyView>;
 versions:(postId:string,input?:{afterVersion?:number})=>Promise<{items:ForumVersionEntry[];nextAfterVersion:number|null}>;
 replies:(input:{postId:string;postVersionId:string;after?:string})=>Promise<ForumPage<ForumReplyView>>;
 ownPost:(postId:string)=>Promise<ForumOwnedPost>;ownReply:(replyId:string)=>Promise<ForumOwnedReply>;
 quotas:(input?:{postId?:string;replyId?:string;sectionId?:string})=>Promise<ForumQuota>;permission:(id:string)=>Promise<ForumPermission>;
 accounts:(input?:{query?:string;after?:string;limit?:number})=>Promise<ForumPage<ForumAccountChoice>>;
 accessOptions:()=>Promise<ForumAccessOptions>;sections:(input?:{after?:string;limit?:number;managed?:boolean})=>Promise<ForumPage<ForumSection>>;section:(sectionId:string)=>Promise<ForumSection>;
 notifications:(input?:{after?:string;limit?:number;unreadOnly?:boolean})=>Promise<ForumPage<ForumNotification>>;readNotification:(replyId:string)=>Promise<unknown>;
 reportConfig:(input?:{target:ForumTarget})=>Promise<ForumConfig>;report:(id:string)=>Promise<ForumReport>;
 prepare:(kind:ForumKind,payload:ForumPayload,options:{viewers:string[];draftRef:ForumDraftRef|null;authorizationExpiresAt:number})=>Promise<ForumPrepared>;
 execute:(preview:ForumPrepared,options:{confirmed:true})=>Promise<ForumReceipt>;
 pending:()=>Promise<ForumPending[]>;resumePending:()=>Promise<ForumReceipt>;reconcile:(operationId:string)=>Promise<ForumReceipt>;reviewOperation:(operationId:string)=>Promise<ForumReview>;
 retry:(operationId:string,options:{confirmed:true;reauthorize:true})=>Promise<ForumReceipt>;stopLocalRetry:(operationId:string,options:{confirmed:true})=>Promise<ForumPending>;
};
export function availableForumContent<T extends ForumContentView|ForumCardView>(view:T|null,now:number):view is T&{payload:NonNullable<T['payload']>;publishedUntil:number}{
 return !!view&&view.availability==='available'&&!!view.payload&&typeof view.publishedUntil==='number'&&view.publishedUntil>now&&(typeof view.authorId==='string'||typeof view.authorAccountId==='string'||typeof view.author?.accountId==='string');
}
export function forumPayload(kind:ForumKind,value:unknown):ForumPayload{
 switch(kind){
  case'create-post':return forumCreatePostSchema.parse(value);
  case'publish-version':return forumPublishVersionSchema.parse(value);
  case'create-reply':return forumCreateReplySchema.parse(value);
  case'withdraw-post':return forumWithdrawPostSchema.parse(value);
  case'withdraw-version':return forumWithdrawVersionSchema.parse(value);
  case'withdraw-reply':return forumWithdrawReplySchema.parse(value);
  case'create-report':return forumReportSchema.parse(value);
  case'supplement':return forumSupplementSchema.parse(value);
  case'withdraw-report':return forumWithdrawReportSchema.parse(value);
  case'appeal':return forumAppealSchema.parse(value);
  case'resolve':return forumResolveSchema.parse(value);
  case'create-section':case'update-section':return forumSectionWriteSchema.parse(value);
 }
}
/** Validate the exact client preview without replacing its WeakMap identity. */
export function assertForumPrepared(value:ForumPrepared):void{
 const parsed=forumPayload(value.kind,value.payload);
 if(JSON.stringify(parsed)!==JSON.stringify(value.payload))throw Error('预览与原提交内容不一致，请重新核对。');
}
export function forumSourceTarget(value:ForumContentView):ForumTarget{
 const locator=value.locator;
 return forumTargetSchema.parse(locator.kind==='reply'?{kind:'reply',replyId:locator.replyId,contentRevision:1}:{kind:'post-version',postId:locator.postId,versionId:locator.kind==='post-version'?locator.versionId:value.currentVersionId});
}
export function forumTargetString(value:string|number|null|undefined):string{
 if(typeof value!=='string')throw Error('原目标记录不完整，请保留本机稿后重新核对。');return value;
}
export function forumSourceTargetFromDraft(draft:ForumDraft):ForumTarget{return forumTargetSchema.parse(draft.target);}
export const forumCategory=(value:string)=>forumReportSchema.shape.category.parse(value);
export const forumResolution=(value:string)=>forumResolveSchema.shape.resolution.parse(value);
export function forumPreviewProjection(payload:ForumPayload|ForumPreviewPayload):ForumPreviewPayload{
 return{...('title'in payload?{title:payload.title}:{}),...('body'in payload?{body:payload.body}:{}),...('links'in payload?{links:payload.links}:{}),...('topic'in payload?{topic:payload.topic}:{}),...('publishedUntil'in payload?{publishedUntil:payload.publishedUntil}:{}),...('audience'in payload?{audience:payload.audience}:{}),...('sectionId'in payload?{sectionId:payload.sectionId}:{}),...('theme'in payload?{theme:payload.theme}:{}),...('description'in payload?{description:payload.description}:{}),...('state'in payload?{state:payload.state}:{}),...('summary'in payload?{summary:payload.summary}:{}),...('reason'in payload?{reason:payload.reason}:{}),...('resolution'in payload?{resolution:payload.resolution}:{}),...('effect'in payload?{effect:payload.effect}:{})};
}
