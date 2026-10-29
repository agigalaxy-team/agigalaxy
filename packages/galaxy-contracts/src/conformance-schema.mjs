import * as z from 'zod/v4';
import { builderEventSchema, conformanceChecks } from './builders-schema.mjs';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = max => z.string().trim().min(1).max(max);
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const reference = z.url().max(500).refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
export const conformanceSuitePinsSchema = z.array(z.strictObject({ name: text(100), version: text(80), sha256: sha,
  source: reference, notBefore: z.number().int().nonnegative(), notAfter: z.number().int().positive(), revoked: z.boolean() })
  .refine(pin => pin.notAfter > pin.notBefore)).max(32)
  .refine(pins => new Set(pins.map(pin => JSON.stringify([pin.name, pin.version]))).size === pins.length);
export const conformanceRequestSchema = z.strictObject({ builderId: z.uuid(), reportId: z.uuid() });
export const compatibilityReportSchema = builderEventSchema.options.find(option => option.shape.kind.value === 'compatibility');
export const conformanceSnapshotSchema = z.strictObject({ version: z.union([z.literal(1),z.literal(2)]), id: z.uuid(), builderId: z.uuid(),
  ownerId: subject, assessorId: subject, declarationId: z.uuid(), declarationHash: sha,
  release: z.strictObject({ version: text(80), buildHash: sha, sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/) }),
  report: compatibilityReportSchema, reportHash: sha, sourceEventHash: sha,
  checkedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  suiteVerification: z.literal('operator-pinned-reference'), authority: z.literal('registry-signed-assessor-report'),
  capabilityVerified: z.literal(false), independentExecutionVerified: z.literal(false),
  maintenance: z.strictObject({ delisted: z.boolean(), securityIssue: z.boolean() }),
  statusPath: z.literal('/v1/builders/reports/export') }).refine(data=>data.version===(data.report.profile?2:1));

export function suiteValidity(suite, pins, now, observedAt) {
  const pin = pins.find(item => item.name === suite.name && item.version === suite.version);
  if (!pin) return { state: 'untracked', portable: false };
  const state = pin.revoked ? 'revoked' : pin.sha256 !== suite.sha256 || pin.source !== suite.source ? 'source-changed'
    : now < pin.notBefore || observedAt < pin.notBefore ? 'outside-validity' : now >= pin.notAfter ? 'expired' : 'current';
  return { state, portable: state === 'current', validUntil: pin.notAfter };
}

export function reportCoverage(report) {
  const missing=conformanceChecks.filter(id=>!report.checks.some(check=>check.id===id));
  return {profile:report.profile??'galaxy-conformance/1',required:conformanceChecks.length,reported:report.checks.length,
    missing,complete:missing.length===0};
}
