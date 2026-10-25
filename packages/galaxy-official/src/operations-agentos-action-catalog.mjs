import {z} from 'zod';
import {operationsContentCurationSchema,operationsContentVisibilitySchema,operationsContentBatchSchema} from './shared/operations-forum-content-schema.mjs';
import {operationsSectionClassificationSchema,operationsVisibilitySchema,operationsForumDecisionSchema,operationsFileRetrySchema} from './shared/operations-business-schema.mjs';
import {feedbackEventSchema} from './shared/operations-feedback-schema.mjs';
import {messagingActionSchema,messagingConfigSchema,messagingSaveSchema} from './shared/operations-messaging-schema.mjs';
import {p14KeySchema,p14PublishSchema} from './shared/p14-rules-schema.mjs';
import {operationsFileCleanupDecisionSchema} from './shared/operations-file-cleanup-schema.mjs';
import {businessRestrictionSchema,businessReleaseRestrictionSchema} from './shared/business-admin-schema.mjs';
import {operationsFileAccessChangeSchema} from './shared/operations-file-access-schema.mjs';
import {recommendationDirectionSchema,recommendationThemeKeySchema,recommendationPolicySaveSchema} from './shared/operations-recommendation-schema.mjs';
import {aiWorkPreparationRegistry} from './shared/operations-ai-action-registry.mjs';
import {p13OrdinaryDraftSchema,p13OrdinaryPublishSchema} from './shared/p13-strategies-schema.mjs';
import {operationsChatMessageVisibilitySchema} from './shared/operations-chat-message-schema.mjs';
import {delegatedAiRolePreparationSchema,delegatedAiPromptSaveSchema} from './operations/permissions/ai-delegation-schema.mjs';
import {operationsToolCallIdSchema} from './shared/operations-tool-call-id.mjs';

const id=z.uuid(),reason=z.string().trim().min(3).max(1600),targetKind=z.enum(['post','reply']);
const fields=(schema,excluded)=>Object.fromEntries(Object.entries(schema.shape).filter(([key])=>!excluded.includes(key)));
const contentChanges=z.strictObject(fields(operationsContentCurationSchema,['operationId','expectedVersion','expectedRevision']))
 .refine(value=>['topic','pinned','featured','tagIds'].some(key=>Object.hasOwn(value,key)));
const feedbackChanges=z.strictObject(fields(feedbackEventSchema,['operationId','expectedRevision']))
 .refine(value=>['category','module','state','note'].some(key=>Object.hasOwn(value,key)));
const decision=z.strictObject(fields(operationsForumDecisionSchema,['operationId','expectedVersion']))
 .refine(value=>(value.restrictionAction??(value.hideUntil!==undefined?'hide':'keep'))==='hide'?value.hideUntil!==undefined:value.hideUntil===undefined);
const visibility={action:z.enum(['hide','restore']),until:z.number().int().positive().optional(),reason};
const visibilityValid=(value,ctx)=>{if((value.action==='hide')!==(value.until!==undefined))ctx.addIssue({code:'custom',message:'An exact hide deadline is required only for hide'});};
const accountRestriction=z.strictObject({kind:z.literal('account-restriction'),targetId:id,action:z.enum(['apply','release']),
 reason:businessRestrictionSchema.shape.reason,until:businessRestrictionSchema.shape.until.optional()}).superRefine((value,ctx)=>{
  if((value.action==='apply')!==(value.until!==undefined))ctx.addIssue({code:'custom',message:'An exact restriction deadline is required only for apply'});
 });
const fileAccess=z.strictObject({kind:z.literal('file-access'),targetKind:z.enum(['chat','forum']),targetId:id,action:z.enum(['stop','restore']),
 reason,until:z.number().int().positive().max(253402300799).optional()}).superRefine((value,ctx)=>{
  if((value.action==='stop')!==(value.until!==undefined))ctx.addIssue({code:'custom',message:'An exact access deadline is required only for stop'});
 });
export const workbenchMessageDraftConfigSchema=messagingConfigSchema.omit({automation:true});
const humanReviewDraftConfig=messagingConfigSchema.refine(value=>value.automation?.kind==='human-required'&&value.automation.factsConfirmed===false);
export const workbenchAiPromptReviewSchema=z.strictObject({kind:z.literal('ai-work-prompt'),aiAccountId:id,domain:z.enum(['governance','messaging','discovery','maintenance']),name:z.string().max(100),configId:id,
 expectedRevision:z.number().int().positive(),promptVersion:z.number().int().positive(),nextPromptVersion:z.number().int().positive(),scope:z.literal('role-work-requirements'),source:z.enum(['saved-configuration','empty-default']),before:z.string().max(16000),after:z.string().max(16000),effect:z.literal('new-rounds-only')});
export const workbenchPrepareSchemas=Object.freeze({
 'ai-work-prompt-save':z.strictObject({kind:z.literal('ai-work-prompt-save'),aiAccountId:id,prompt:z.string().max(16000)}),
 'ai-role-command':z.strictObject({kind:z.literal('ai-role-command'),command:delegatedAiRolePreparationSchema}),
 'content-visibility':z.strictObject({kind:z.literal('content-visibility'),targetKind,targetId:id,...visibility}).superRefine(visibilityValid),
 'content-curation':contentChanges.safeExtend({kind:z.literal('content-curation'),targetKind,targetId:id}),
 'public-content-batch':z.strictObject({kind:z.literal('public-content-batch'),items:z.array(z.strictObject({kind:targetKind,id})).min(1).max(25).refine(items=>new Set(items.map(item=>item.kind+':'+item.id)).size===items.length),...visibility}).superRefine(visibilityValid),
 'private-case-message':z.strictObject({kind:z.literal('private-case-message'),reportId:id,messageId:id,action:z.enum(['hide','restore','keep']),summary:operationsChatMessageVisibilitySchema.shape.summary}),
 'section-classification':operationsSectionClassificationSchema.omit({operationId:true,expectedVersion:true}).safeExtend({kind:z.literal('section-classification'),targetId:id}),
 'section-visibility':z.strictObject({kind:z.literal('section-visibility'),targetId:id,...visibility}).superRefine(visibilityValid),
 'resource-visibility':z.strictObject({kind:z.literal('resource-visibility'),targetKind:z.enum(['projects','methods']),targetId:id,...visibility}).superRefine(visibilityValid),
 'account-restriction':accountRestriction,
 'feedback-update':feedbackChanges.safeExtend({kind:z.literal('feedback-update'),targetId:id}),
 'file-scan-retry':z.strictObject({kind:z.literal('file-scan-retry'),targetKind:z.enum(['chat','forum']),targetId:id,reason}),
 'file-access':fileAccess,
 'file-cleanup-approve':z.strictObject({kind:z.literal('file-cleanup-approve'),planId:id}),
 'case-resolve':decision.safeExtend({kind:z.literal('case-resolve'),targetId:id}),
 'messaging-state':z.strictObject({kind:z.literal('messaging-state'),targetId:id,action:z.enum(['activate','pause','resume','stop','withdraw'])}),
 'message-draft-create':z.strictObject({kind:z.literal('message-draft-create'),config:workbenchMessageDraftConfigSchema}),
 'message-draft-save':z.strictObject({kind:z.literal('message-draft-save'),targetId:id,config:workbenchMessageDraftConfigSchema}),
 'ordinary-strategy-draft':z.strictObject({...fields(p13OrdinaryDraftSchema,['operationId','expectedRevision']),kind:z.literal('ordinary-strategy-draft')}).refine(value=>value.parameterEdits.length>0||value.mode!==undefined||value.enabled!==undefined),
 'ordinary-strategy-publish':z.strictObject({...fields(p13OrdinaryPublishSchema,['operationId','expectedRevision']),kind:z.literal('ordinary-strategy-publish')}),
 'strategy-control':z.strictObject({kind:z.literal('strategy-control'),action:z.enum(['pause','resume']),reason}),
 'strategy-continue':z.strictObject({kind:z.literal('strategy-continue'),runId:id,decision:z.enum(['proceed','no-action'])}),
 'search-apply':z.strictObject({kind:z.literal('search-apply'),reason:z.string().trim().min(1).max(500)}),
 'search-restore':z.strictObject({kind:z.literal('search-restore'),versionId:id,reason:z.string().trim().min(1).max(500)}),
 'rule-publish':z.strictObject({kind:z.literal('rule-publish'),key:p14KeySchema,reason:p14PublishSchema.shape.reason}),
 'rule-restore':z.strictObject({kind:z.literal('rule-restore'),key:p14KeySchema,versionId:id,reason:p14PublishSchema.shape.reason}),
 'recommendation-direction':z.strictObject({kind:z.literal('recommendation-direction'),themeKey:recommendationThemeKeySchema,direction:recommendationDirectionSchema,reason:recommendationPolicySaveSchema.shape.reason}),
});
export const workbenchActionCatalog=aiWorkPreparationRegistry;
export const workbenchCommandSchemas=Object.freeze({
 'ai-work-prompt-save':delegatedAiPromptSaveSchema.safeExtend({delegationVersion:z.number().int().positive()}),
 'ai-role-command':z.strictObject({operationId:id,command:delegatedAiRolePreparationSchema,delegationVersion:z.number().int().positive()}),
 'content-visibility':operationsContentVisibilitySchema,'content-curation':operationsContentCurationSchema,
 'public-content-batch':operationsContentBatchSchema,'private-case-message':operationsChatMessageVisibilitySchema,
 'section-classification':operationsSectionClassificationSchema,'section-visibility':operationsVisibilitySchema,'resource-visibility':operationsVisibilitySchema,
 'account-restriction':z.union([businessRestrictionSchema,businessReleaseRestrictionSchema]),
 'feedback-update':feedbackEventSchema,'file-scan-retry':operationsFileRetrySchema,'file-access':operationsFileAccessChangeSchema,'file-cleanup-approve':operationsFileCleanupDecisionSchema,'case-resolve':operationsForumDecisionSchema,
 'messaging-state':messagingActionSchema,
 'message-draft-create':z.strictObject({operationId:id,planId:id,config:humanReviewDraftConfig}),
 'message-draft-save':messagingSaveSchema.safeExtend({config:humanReviewDraftConfig}),
 'ordinary-strategy-draft':p13OrdinaryDraftSchema,'ordinary-strategy-publish':p13OrdinaryPublishSchema,
 'strategy-control':z.strictObject({operationId:id,expectedRevision:z.number().int().nonnegative(),kind:z.enum(['pause','resume']),reason}),
 'strategy-continue':z.strictObject({operationId:id,confirmed:z.boolean().optional(),inputDecision:z.enum(['proceed','no-action']).optional()}).refine(value=>(value.confirmed!==undefined)!==(value.inputDecision!==undefined)),
 'search-apply':z.strictObject({operationId:id,expectedRevision:z.number().int().nonnegative(),versionId:id,reason:z.string().trim().min(1).max(500)}),
 'search-restore':z.strictObject({operationId:id,expectedRevision:z.number().int().nonnegative(),versionId:id,reason:z.string().trim().min(1).max(500)}),
 'rule-publish':p14PublishSchema,'rule-restore':p14PublishSchema,
 'recommendation-direction':recommendationPolicySaveSchema.extend({
  beforeDirections:z.array(z.strictObject({key:recommendationThemeKeySchema,direction:recommendationDirectionSchema})).refine(items=>new Set(items.map(item=>item.key)).size===items.length),
  themeVersion:z.number().int().min(0).max(2147483646),themeEnabled:z.boolean(),
 }),
});
export const workbenchActionToolSchema=z.strictObject({conversationId:id,sessionId:id,turnId:id,runId:z.string().min(1).max(128),callId:operationsToolCallIdSchema,
 tool:z.enum(['list-authorized-work','run-authorized-work','prepare-operation']),arguments:z.record(z.string(),z.unknown())});
export const workbenchEmptyArgumentsSchema=z.strictObject({});
export const workbenchRunArgumentsSchema=z.strictObject({executionId:id});

