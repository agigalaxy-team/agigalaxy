import * as z from 'zod/v4';
import {ServiceError} from './service-error.mjs';

const uuid=z.uuid(),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Limits are explicitly Unicode code points, not user-perceived graphemes.
const validText=value=>Array.from(value).every(point=>point.length!==1||point.charCodeAt(0)<0xd800||point.charCodeAt(0)>0xdfff);
const text=max=>z.string().refine(value=>value.trim().length>0&&validText(value)&&Array.from(value).length<=max,'Invalid text length or Unicode');
const link=z.string().refine(value=>{try{const url=new URL(value);return Array.from(value).length<=2048&&['https:','http:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password;}catch{return false;}},'Invalid public link');
const base={schemaVersion:z.literal(1),operationId:uuid};
const content={versionId:uuid,title:text(160),body:text(8000),links:z.array(link).max(8),publishedUntil:positive};
export const forumCreatePostSchema=z.strictObject({...base,postId:uuid,expectedHeadVersion:z.literal(0),...content});
export const forumPublishVersionSchema=z.strictObject({...base,postId:uuid,expectedHeadVersion:positive,...content});
export const forumWithdrawPostSchema=z.strictObject({...base,postId:uuid,expectedHeadVersion:positive});
export const forumWithdrawVersionSchema=z.strictObject({...base,postId:uuid,versionId:uuid,expectedHeadVersion:positive});
export const forumCreateReplySchema=z.strictObject({...base,replyId:uuid,postId:uuid,postVersionId:uuid,expectedRevision:z.literal(0),body:text(2000),publishedUntil:positive,
 replyTo:z.strictObject({replyId:uuid,contentRevision:z.literal(1)}).nullable()});
export const forumWithdrawReplySchema=z.strictObject({...base,replyId:uuid,expectedRevision:z.literal(1)});
export const forumTargetSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('post-version'),postId:uuid,versionId:uuid}),
 z.strictObject({kind:z.literal('reply'),replyId:uuid,contentRevision:z.literal(1)}),
]);
export const forumReportSchema=z.strictObject({...base,reportId:uuid,target:forumTargetSchema,category:z.enum(['spam','harassment','privacy','misleading','other']),summary:text(1600)});
const event={...base,governanceEventId:uuid,reportId:uuid,expectedReportVersion:positive};
export const forumSupplementSchema=z.strictObject({...event,kind:z.literal('supplement'),summary:text(1600)});
export const forumWithdrawReportSchema=z.strictObject({...event,kind:z.literal('withdraw')});
export const forumAppealSchema=z.strictObject({...event,kind:z.literal('appeal'),summary:text(1600)});
export const forumResolveSchema=z.strictObject({...event,kind:z.literal('resolve'),resolution:z.enum(['dismissed','accepted','needs-review']),reason:text(1600),
 effect:z.strictObject({kind:z.literal('hide-version'),until:positive}).nullable()});
export const forumReportEventSchema=z.discriminatedUnion('kind',[forumSupplementSchema,forumWithdrawReportSchema,forumAppealSchema,forumResolveSchema]);
const page={after:uuid.optional(),limit:z.number().int().min(1).max(50).default(20)};
export const forumPostsQuerySchema=z.strictObject(page);
export const forumVersionsQuerySchema=z.strictObject({afterVersion:z.number().int().nonnegative().optional(),limit:page.limit});
export const forumRepliesQuerySchema=z.strictObject({postId:uuid,postVersionId:uuid,...page});
export const forumReportQuerySchema=z.strictObject({target:forumTargetSchema.optional(),after:uuid.optional(),limit:z.number().int().min(1).max(30).default(10)});
export const forumConfigSchema=z.strictObject({target:forumTargetSchema.optional()});
export const forumReceiptSchema=z.strictObject({operationId:uuid,payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
export const forumEnvelopeSchema=z.strictObject({signedIntent:z.string().min(1).max(16384),payloadJson:z.string()});

const definitions={
 'create-post':[forumCreatePostSchema,'forum.post.publish','versionId','/v2/community/posts','Public'],
 'publish-version':[forumPublishVersionSchema,'forum.post.publish','versionId','/v2/community/posts','Public'],
 'create-reply':[forumCreateReplySchema,'forum.reply.publish','replyId','/v2/community/replies','Public'],
 'withdraw-post':[forumWithdrawPostSchema,'forum.withdraw','operationId','/v2/community/posts/withdraw','Public'],
 'withdraw-version':[forumWithdrawVersionSchema,'forum.withdraw','operationId','/v2/community/versions/withdraw','Public'],
 'withdraw-reply':[forumWithdrawReplySchema,'forum.withdraw','operationId','/v2/community/replies/withdraw','Public'],
 'create-report':[forumReportSchema,'forum.report.publish','reportId','/v2/community/reports','Private'],
 supplement:[forumSupplementSchema,'forum.report.event','governanceEventId',null,'Private'],
 'withdraw-report':[forumWithdrawReportSchema,'forum.report.event','governanceEventId','/v2/community/reports/withdraw','Private'],
 appeal:[forumAppealSchema,'forum.report.event','governanceEventId',null,'Private'],
 resolve:[forumResolveSchema,'forum.governance.resolve','governanceEventId',null,'Private'],
};
export const forumWriteKinds=Object.freeze(Object.keys(definitions));
export function forumWriteSpec(kind,payload){
 const definition=definitions[kind];if(!definition)throw new ServiceError('invalid_forum_action');
 const [schema,action,objectKey,path,visibility]=definition;
 const parsed=schema.safeParse(payload);if(!parsed.success)throw new ServiceError('invalid_forum_payload');
 return {schema,action,objectId:parsed.data[objectKey],path:path??`/v2/community/reports/${parsed.data.reportId}/${kind==='appeal'?'appeal':'events'}`,visibility};
}
export function parseForumPayload(payloadJson,schema,maxBytes=49152){
 if(typeof payloadJson!=='string'||new TextEncoder().encode(payloadJson).length>maxBytes)throw new ServiceError('forum_payload_too_large',413);
 let value;try{value=JSON.parse(payloadJson);}catch{throw new ServiceError('invalid_forum_payload');}
 const parsed=schema.safeParse(value);if(!parsed.success)throw new ServiceError('invalid_forum_payload');return parsed.data;
}
