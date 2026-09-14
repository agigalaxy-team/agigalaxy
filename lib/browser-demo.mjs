import * as z from 'zod/v4';
export const demoStorageKey = 'galaxy-browser-demo-v2';
const text = z.string();
const stamp = z.iso.datetime();
const record = text.regex(/^demo_[a-z]+_[a-f0-9]{32}$/);
const state = z.strictObject({
  node: z.strictObject({ id: text.regex(/^DEMO-[a-f0-9-]{36}$/), fingerprint: text, createdAt: stamp }).nullable(),
  cases: z.array(z.strictObject({ id: record, title: text, failureSummary: text, createdAt: stamp, status: z.enum(['draft', 'local-proof-draft']) })),
  plans: z.array(z.strictObject({ id: record, caseId: record, recipient: text, purpose: text, include: z.array(text), exclude: z.array(text), expiresAt: stamp, status: z.enum(['preview', 'confirmed']) })),
  grants: z.array(z.strictObject({ id: record, disclosurePlanId: record, caseId: record, issuedAt: stamp, status: z.enum(['active', 'revoked']) })),
  proofs: z.array(z.strictObject({ id: record, caseId: record, consentGrantId: record, createdAt: stamp, status: z.literal('draft') })),
});
const envelope = z.strictObject({ schemaVersion: z.literal(2), kind: z.literal('galaxy-browser-demo'), data: state });
export function encodeDemoState(value) {
  const encoded = JSON.stringify(envelope.parse({ schemaVersion: 2, kind: 'galaxy-browser-demo', data: value }));
  if (encoded.length > 4194304) throw new Error('Demo cache too large.');
  return encoded;
}
export function decodeDemoState(value) {
  if (typeof value !== 'string' || value.length > 4194304) throw new Error('Invalid demo cache.');
  return envelope.parse(JSON.parse(value)).data;
}
export function exportDemoState(value) {
  return { exportVersion: 2, kind: 'galaxy-browser-demo', exportedAt: new Date().toISOString(),
    browserPreview: true, localOnly: true, signed: false, authoritative: false,
    data: state.parse(value), limitations: ['Simulation only; not Core identity, Consent or Proof.', 'User-entered content is included verbatim.'] };
}
export function createDemoNode() {
  return { id: 'DEMO-' + crypto.randomUUID(), fingerprint: 'demo-' + crypto.randomUUID(), createdAt: new Date().toISOString() };
}
