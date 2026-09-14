import * as z from 'zod/v4';

const reference = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
});
const common = {
  schemaVersion: z.literal(2),
  id: z.uuid(),
  commentId: z.uuid(),
  taskId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
};
const content = {
  body: z.string().trim().min(1).max(6000),
  visibility: z.literal('inherit-task'),
};
export const taskCommentV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    ...content,
    kind: z.literal('create'),
    replyTo: reference.nullable().default(null),
  }),
  z.strictObject({ ...common, ...content, kind: z.literal('edit') }),
  z.strictObject({
    ...common,
    ...content,
    kind: z.literal('correct'),
    reason: z.string().trim().min(1).max(600),
  }),
  z.strictObject({ ...common, kind: z.literal('retract') }),
]);
export const commentQueryV2Schema = z.strictObject({
  taskId: z.uuid(),
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().trim().max(120).default(''),
});
export const commentReceiptV2Schema = z.strictObject({
  operationId: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const commentReportV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  id: z.uuid(),
  target: z.strictObject({
    type: z.literal('task-comment'),
    ...reference.shape,
  }),
  category: z.enum([
    'advertising',
    'harassment',
    'privacy',
    'review-request',
    'other',
  ]),
  summary: z.string().trim().min(1).max(1600),
});
const moderationCommon = {
  schemaVersion: z.literal(2),
  id: z.uuid(),
  reportId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  summary: z.string().trim().min(1).max(1600),
};
export const commentModerationV2Schema = z.discriminatedUnion('kind', [
  ...['supplement', 'appeal', 'withdraw-report', 'resume'].map((kind) =>
    z.strictObject({ ...moderationCommon, kind: z.literal(kind) }),
  ),
  z.strictObject({
    ...moderationCommon,
    kind: z.literal('pause'),
    until: z.number().int().positive(),
    rule: z.string().trim().min(1).max(120),
  }),
  z.strictObject({
    ...moderationCommon,
    kind: z.literal('resolve'),
    verdict: z.enum(['upheld', 'dismissed']),
    reviewDisposition: z
      .enum(['unchanged', 'approve', 'reject'])
      .default('unchanged'),
    rule: z.string().trim().min(1).max(120),
  }),
]);
export const commentRulePolicySchema = z.strictObject({
  version: z.string().min(1).max(80),
  duplicateWindowSeconds: z.number().int().min(60).max(86400),
  duplicateThreshold: z.number().int().min(2).max(20),
  linkTaskThreshold: z.number().int().min(3).max(20),
  maxMentions: z.number().int().min(4).max(50),
  maxVersions: z.number().int().min(10).max(200),
});
// Implementation parameters under CUR-33, not user-quoted thresholds or a fraud verdict.
export const defaultCommentRulePolicy = Object.freeze({
  version: 'comment-rules/1',
  duplicateWindowSeconds: 86400,
  duplicateThreshold: 3,
  linkTaskThreshold: 4,
  maxMentions: 8,
  maxVersions: 100,
});
