import { z } from 'zod';
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const unique = values => new Set(values).size === values.length;
export const auditRoleIdsSchema = z.array(subject).max(32).refine(unique);
export const auditGrantSchema = z.object({ version: z.literal(1), id: z.uuid(), endpoint: z.url(),
  reviewerId: subject, reviewerBindingId: z.uuid(), readerId: subject,
  subjectIds: z.array(subject).min(1).max(16).refine(unique),
  actions: z.array(z.enum(['query', 'export'])).min(1).max(2).refine(unique),
  reasonCode: z.string().regex(/^[a-z][a-z0-9.-]{2,79}$/),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
}).strict().refine(value => value.readerId !== value.reviewerId && value.expiresAt > value.issuedAt
  && value.expiresAt - value.issuedAt <= 3600);
const cursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value => BigInt(value) <= 9223372036854775807n);
export const auditQuerySchema = z.object({ subjectId: subject.optional(), grantId: z.uuid().optional(),
  action: z.string().regex(/^[a-z][a-z0-9._-]{0,79}$/).optional(), objectId: z.union([z.uuid(), subject, z.string().regex(/^[a-f0-9]{64}$/)]).optional(),
  requestId: z.uuid().optional(), after: cursor.default('0'), through: cursor.optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict().refine(value => !value.through || BigInt(value.after) <= BigInt(value.through));
export const auditGrantIdSchema = z.object({ id: z.uuid() }).strict();
