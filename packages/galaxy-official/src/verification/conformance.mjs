import { verifyEnvelope } from './envelope.mjs';
import { conformanceSnapshotSchema, reportCoverage } from '../shared/conformance-schema.mjs';
import { digest } from '../shared/digest.mjs';

// A locally verified signature authenticates a short-lived registry snapshot.
// Current report/Consent/binding state requires another authorized live export.
export async function verifyConformance(signed, { endpoint, trustedKeys, now = Math.floor(Date.now() / 1000), builderId, reportId }) {
  const envelope = await verifyEnvelope(signed, { type: 'conformance', issuer: endpoint, audience: endpoint, trustedKeys, now, maxAge: 300 });
  const data = conformanceSnapshotSchema.parse(envelope.data), report = data.report;
  if (data.id !== envelope.id || data.id !== report.id || data.id !== reportId || data.builderId !== builderId
    || report.builderId !== data.builderId || report.declarationId !== data.declarationId || report.declarationHash !== data.declarationHash
    || data.reportHash !== digest(JSON.stringify(report)) || data.assessorId === data.ownerId
    || data.checkedAt !== envelope.issuedAt || data.expiresAt !== envelope.expiresAt
    || report.observedAt > data.checkedAt || report.expiresAt < data.expiresAt)
    throw new Error('Conformance snapshot mismatch.');
  return { data, signed, coverage:reportCoverage(report), source: 'registry-signed-assessor-report', verification: 'signature-and-schema-only',
    currentRevocationChecked: false, capabilityVerified: false, kid: envelope.kid, expiresAt: envelope.expiresAt };
}
