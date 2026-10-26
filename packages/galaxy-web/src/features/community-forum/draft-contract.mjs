import * as z from 'zod/v4';
import { forumTopicSchema, forumReadTopicSchema } from "../../../../galaxy-official/src/shared/community-forum-topics-v1.mjs";
import { forumAudienceSchema } from "../../../../galaxy-official/src/shared/community-forum-access-v2.mjs";
import { forumDraftAttachmentsSchema } from "./forum-attachment-client.mjs";

export const draftSchema = z.strictObject({
  id: z.uuid(), revision: z.number().int().positive(),
  kind: z.enum(['create-post', 'publish-version', 'create-reply', 'withdraw-post', 'withdraw-version', 'withdraw-reply', 'create-report', 'supplement', 'withdraw-report', 'appeal', 'resolve', 'create-section', 'update-section']),
  title: z.string().default(''), body: z.string().default(''), linksText: z.string().default(''),
  attachments:forumDraftAttachmentsSchema.default([]),
  topic: forumReadTopicSchema.optional(),
  sectionId: z.uuid().nullable().optional(), audience: forumAudienceSchema.optional(),
  theme: z.string().default(''), description: z.string().default(''), sectionState: z.enum(['active','archived']).default('active'),
  category: z.enum(['spam', 'harassment', 'privacy', 'misleading', 'other']).default('other'),
  target: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
  replyTo: z.strictObject({ replyId: z.uuid(), contentRevision: z.literal(1) }).nullable().default(null),
  resolution: z.enum(['dismissed', 'accepted', 'needs-review']).default('needs-review'),
  hide: z.boolean().default(false), hideHours: z.number().min(0).max(24).default(24),
  operationId: z.uuid().optional(),
});
export const draftRefSchema = z.strictObject({ id: z.uuid(), revision: z.number().int().positive() });
export function newForumDraft(kind = 'create-post', target = {}, values = {}) {
  return draftSchema.parse({ id: crypto.randomUUID(), revision: 1, kind, target, ...values });
}

export function forumDraftPayload(value, { maxPermissionSeconds, maxGovernanceHideSeconds }, now = Math.floor(Date.now() / 1000)) {
  const draft = draftSchema.parse(value), target = draft.target;
  const base = { schemaVersion: 1, operationId: crypto.randomUUID(), ...(typeof target.accountId==='string'?{accountId:z.uuid().parse(target.accountId)}:{}) };
  const content = () => ({ versionId: crypto.randomUUID(), title: draft.title.trim(), body: draft.body.trim(),
    links: draft.linksText.split(/\r?\n/).map(line => line.trim()).filter(Boolean), publishedUntil: now + maxPermissionSeconds,
    ...(forumTopicSchema.safeParse(draft.topic).success?{topic:draft.topic}:{}),
    ...(draft.attachments.length?{attachments:draft.attachments.map(({id,sha256})=>({id,sha256}))}:{}),
    ...(draft.sectionId!==undefined?{sectionId:draft.sectionId}:{}),...(draft.audience?{audience:draft.audience}:{}) });
  switch (draft.kind) {
    case 'create-post': return { ...base, postId: crypto.randomUUID(), expectedHeadVersion: 0, ...content() };
    case 'publish-version': return { ...base, postId: target.postId, expectedHeadVersion: target.expectedHeadVersion, ...content() };
    case 'create-reply': return { ...base, replyId: crypto.randomUUID(), postId: target.postId, postVersionId: target.versionId,
      expectedRevision: 0, body: draft.body.trim(), publishedUntil: now + maxPermissionSeconds, replyTo: draft.replyTo,
      ...(draft.attachments.length?{attachments:draft.attachments.map(({id,sha256})=>({id,sha256}))}:{}),...(draft.audience?{audience:draft.audience}:{}) };
    case 'create-section': case 'update-section': return {...base,sectionId:target.sectionId??crypto.randomUUID(),expectedVersion:target.expectedVersion??0,
      title:draft.title.trim(),theme:draft.theme.trim(),description:draft.description.trim(),audience:draft.audience,state:draft.sectionState};
    case 'withdraw-post': return { ...base, postId: target.postId, expectedHeadVersion: target.expectedHeadVersion };
    case 'withdraw-version': return { ...base, postId: target.postId, versionId: target.versionId, expectedHeadVersion: target.expectedHeadVersion };
    case 'withdraw-reply': return { ...base, replyId: target.replyId, expectedRevision: 1 };
    case 'create-report': return { ...base, reportId: crypto.randomUUID(), category: draft.category, summary: draft.body.trim(),
      target: target.kind === 'reply' ? { kind: 'reply', replyId: target.replyId, contentRevision: 1 }
        : { kind: 'post-version', postId: target.postId, versionId: target.versionId } };
    default: {
      const event = { ...base, governanceEventId: crypto.randomUUID(), reportId: target.reportId, expectedReportVersion: target.expectedReportVersion,
        kind: draft.kind === 'withdraw-report' ? 'withdraw' : draft.kind };
      if (draft.kind === 'withdraw-report') return event;
      if (draft.kind === 'resolve') return { ...event, resolution: draft.resolution, reason: draft.body.trim(),
        effect: draft.hide ? { kind: 'hide-version', until: now + Math.floor(Math.min(draft.hideHours * 3600, maxGovernanceHideSeconds)) } : null };
      return { ...event, summary: draft.body.trim() };
    }
  }
}
