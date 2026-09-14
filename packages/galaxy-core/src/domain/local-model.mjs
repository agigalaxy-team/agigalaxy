import {createHash,randomUUID} from 'node:crypto';

export const STORE_VERSION = 2;

export const FORBIDDEN_DISCLOSURE_ITEMS = [
  'secrets',
  'env',
  'tokens',
  'credentials',
  'unselected_source',
];

export const PERMITTED_DISCLOSURE_ITEMS = [
  'failure_summary',
  'attempt_metadata',
  'verification_note',
];

export function now() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function fingerprint(publicKeyPem) {
  const digest = createHash('sha256').update(publicKeyPem).digest('hex');
  return digest.match(/.{1,4}/g)?.join(':') ?? digest;
}

export function emptyState() {
  return {
    version: STORE_VERSION,
    integration: null,
    cases: [],
    disclosurePlans: [],
    consentGrants: [],
    localProofDrafts: [],
    auditEvents: [],
  };
}

export function normalizeState(state) {
  const defaults = emptyState();
  return {
    ...defaults,
    ...state,
    version: STORE_VERSION,
    integration: state.integration && Array.isArray(state.integration.modules)
      ? state.integration
      : null,
    cases: Array.isArray(state.cases) ? state.cases : [],
    disclosurePlans: Array.isArray(state.disclosurePlans) ? state.disclosurePlans : [],
    consentGrants: Array.isArray(state.consentGrants) ? state.consentGrants : [],
    localProofDrafts: Array.isArray(state.localProofDrafts) ? state.localProofDrafts : [],
    auditEvents: Array.isArray(state.auditEvents) ? state.auditEvents : [],
  };
}

export function addAuditEvent(state, action, subjectId, details = {}) {
  state.auditEvents.push({
    id: makeId('audit'),
    action,
    subjectId,
    occurredAt: now(),
    details,
  });
}

export function assertText(value, field, maxLength) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) {
    throw new Error(`${field} is required.`);
  }
  if (candidate.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  }
  return candidate;
}

export function requiredRecord(records, id, label) {
  const record = records.find((item) => item.id === id);
  if (!record) {
    throw new Error(`${label} ${id} was not found in this local Galaxy ID.`);
  }
  return record;
}

export function permittedIncludeList(include) {
  const requested = Array.isArray(include) && include.length > 0
    ? include
    : ['failure_summary', 'attempt_metadata'];
  const safe = [...new Set(requested.filter((item) => PERMITTED_DISCLOSURE_ITEMS.includes(item)))];
  if (safe.length === 0) {
    throw new Error('At least one permitted disclosure item is required.');
  }
  return safe;
}
