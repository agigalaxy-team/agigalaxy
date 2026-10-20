import * as z from 'zod/v4';

const uuid = z.uuid();
export const readingBookmarkReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('forum-post'), postId: uuid}),
  z.strictObject({kind: z.literal('capsule'), capsuleId: uuid, versionId: uuid}),
  z.strictObject({kind: z.literal('project'), projectId: uuid}),
  z.strictObject({kind: z.literal('person'), subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/)}),
  z.strictObject({kind: z.literal('chat-message'), roomId: uuid, messageId: uuid}),
]);
export const readingBookmarkStatusSchema = z.strictObject({reference: readingBookmarkReferenceSchema});
export const readingBookmarkCommandSchema = z.strictObject({
  operationId: uuid,
  reference: readingBookmarkReferenceSchema,
  saved: z.boolean(),
  expectedRevision: z.number().int().nonnegative().max(2147483646),
});
export const readingBookmarkQuerySchema = z.strictObject({
  kind: z.enum(['forum-post', 'capsule', 'project', 'person', 'chat-message']).optional(),
  after: uuid.optional(),
  limit: z.number().int().min(1).max(30).default(20),
});
export const accountReadingBookmarkQuerySchema = z.strictObject({
  category: z.enum(['community', 'private-chat']).optional(),
  kind: readingBookmarkQuerySchema.shape.kind,
  after: z.string().max(512).regex(/^rb2\.[A-Za-z0-9_-]+$/).optional(),
  limit: readingBookmarkQuerySchema.shape.limit,
});
export const readingBookmarkReceiptSchema = z.strictObject({
  operationId: uuid, payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const readingBookmarkStateSchema = z.strictObject({
  reference: readingBookmarkReferenceSchema, saved: z.boolean(),
  revision: z.number().int().nonnegative(), id: uuid.optional(), savedAt: z.iso.datetime().optional(),
});
export const readingBookmarkReceiptReplySchema = z.discriminatedUnion('state', [
  z.strictObject({state: z.literal('acknowledged'), operationId: uuid, payloadHash: readingBookmarkReceiptSchema.shape.payloadHash,
    bookmark: readingBookmarkStateSchema}),
  z.strictObject({state: z.literal('absent'), operationId: uuid, payloadHash: readingBookmarkReceiptSchema.shape.payloadHash}),
]);
export const readingBookmarkSourceSchema = z.discriminatedUnion('state', [
  z.strictObject({state: z.literal('available'), title: z.string(), summary: z.string(), path: z.string(), availableUntil: z.number().int().positive(),
    revision: z.number().int().positive().optional(), authorAccountId: uuid.nullable().optional(), authorId: z.string().nullable().optional()}),
  z.strictObject({state: z.literal('unavailable'), reason: z.enum(['source-expired', 'source-withdrawn', 'source-not-readable'])}),
  z.strictObject({state: z.literal('temporarily-unavailable'), reason: z.literal('source-check-failed')}),
]);
export const readingBookmarksPageSchema = z.strictObject({
  items: z.array(readingBookmarkStateSchema.extend({source: readingBookmarkSourceSchema})),
  nextAfter: uuid.nullable(), checkedAt: z.number().int(), visibility: z.literal('Private'),
});
export const accountReadingBookmarksPageSchema = readingBookmarksPageSchema.extend({
  accountId: uuid, nextAfter: accountReadingBookmarkQuerySchema.shape.after.unwrap().nullable(),
});
export function readingBookmarkKey(reference) {
  const value = readingBookmarkReferenceSchema.parse(reference);
  switch (value.kind) {
    case 'forum-post': return `forum-post:${value.postId}`;
    case 'capsule': return `capsule:${value.capsuleId}:${value.versionId}`;
    case 'project': return `project:${value.projectId}`;
    case 'person': return `person:${value.subjectId}`;
    case 'chat-message': return `chat-message:${value.roomId}:${value.messageId}`;
  }
}
export function readingBookmarkPath(reference) {
  const value = readingBookmarkReferenceSchema.parse(reference);
  switch (value.kind) {
    case 'forum-post': return `/app/community/posts/${value.postId}`;
    case 'capsule': return `/app/capsules/${value.capsuleId}/versions/${value.versionId}`;
    case 'project': return `/app/projects/${value.projectId}`;
    case 'person': return `/app/people/${value.subjectId}`;
    case 'chat-message': return `/app/rooms/${value.roomId}?message=${value.messageId}`;
  }
}
