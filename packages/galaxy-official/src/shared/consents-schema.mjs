import * as z from 'zod/v4';

export const consentSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/),
  bindingId: z.uuid(), endpoint: z.url(), objectId: z.string().min(1).max(128),
  action: z.enum(['hub.publish','qualification.request','configuration.publish', 'ci.observe', 'proof.publish', 'case.teaser.publish', 'history.query', 'profile.publish', 'project.write', 'contact.write', 'recruitment.write', 'contribution.publish', 'experience.submit', 'qualification.compute', 'qualification.source-permission', 'context.grant', 'evidence.submit', 'outcome.material', 'assistance.publish', 'task.owner-read', 'comment.publish', 'moderation.publish', 'capsule.publish', 'capsule.use', 'capsule.permission', 'builder.publish', 'forum.post.publish', 'forum.reply.publish', 'forum.withdraw', 'forum.report.publish', 'forum.report.event', 'forum.governance.resolve','forum.section.write','forum.section.classify']),
  purpose: z.enum(['operational', 'public-profile', 'federated-proof']),
  recipient: z.string().min(1).max(240), fields: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)).min(1).max(32),
  visibility: z.enum(['Local', 'Private', 'Hub-scoped', 'Proof-only', 'Public']),
  viewers: z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(16),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/), policyVersion: z.literal('0.1'),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
});
