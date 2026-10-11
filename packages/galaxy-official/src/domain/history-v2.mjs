import { digest } from '../shared/digest.mjs';

// Aggregate sequence numbers include invisible writes. Exact object versions
// stay available; unrelated hidden event counts never enter a History response.
const hiddenOrdinals = new Set(['recordEventIds', 'caseVersion', 'expectedVersion', 'expectedTaskVersion', 'expectedParticipationVersion']);
export function historyVisibleValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(historyVisibleValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !hiddenOrdinals.has(key) && item !== undefined).map(([key, item]) => [key, historyVisibleValue(item)]));
  return value;
}
export function visibleFactVersions(facts) {
  const versions = new Map();
  for (const fact of facts) versions.set(fact.id, Math.max(versions.get(fact.id) ?? 0, fact.version));
  return facts.map(fact => ({ ...historyVisibleValue(fact), currentVisibleVersion: versions.get(fact.id),
    supersededInVisibleHistory: fact.version < versions.get(fact.id), capabilityVerified: false }));
}
function fingerprintValue(value,materialView=false){
  if(Array.isArray(value))return value.map(item=>fingerprintValue(item,materialView));
  if(value&&typeof value==='object'){
    const controlled=materialView||value.format==='task-text-view-v1';
    return Object.fromEntries(Object.entries(value).filter(([key])=>!controlled||key!=='checkedAt')
      .map(([key,item])=>[key,fingerprintValue(item,controlled)]));
  }
  return value;
}
// A reader's check time is not a new Task source fact. Only the finite new
// material view ignores it; actual text/state/deadline and old objects persist.
export function sourceFingerprint(value) { return digest(JSON.stringify(fingerprintValue(historyVisibleValue(value)))); }
export function matchesHistoryWindow(occurredAt, window, now) {
  if (window.kind === 'all-visible') return true;
  const time = Date.parse(occurredAt);
  if (!Number.isFinite(time)) return false;
  const before = window.kind === 'custom' ? Date.parse(window.before) : now * 1000 + 1;
  const from = window.kind === 'custom' ? Date.parse(window.from) : (now - (window.kind === '90-days' ? 90 : 365) * 86400) * 1000;
  return time >= from && time < before;
}
// These are explicit field matches for the user's model to interpret. They are
// not a similarity score, expertise grade, or inferred semantic capability.
export function historyRelevance(item, options) {
  const terms = options.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean);
  const text = JSON.stringify(item).toLocaleLowerCase('en-US');
  if (terms.some(term => !text.includes(term))) return null;
  if (options.capabilityId && !item.capabilityIds.includes(options.capabilityId)) return null;
  const matchReasons = terms.map(term => ({ kind: 'visible-field-text', term }));
  if (options.capabilityId) matchReasons.push({ kind: 'declared-task-capability', capabilityId: options.capabilityId, capabilityVerified: false });
  if (options.context?.taskId) matchReasons.push({ kind: item.taskIds.includes(options.context.taskId) ? 'same-task' : 'different-task', taskId: options.context.taskId });
  if (options.context?.environment) {
    const environments = item.attempts?.map(a => typeof a.environment === 'string' ? a.environment : JSON.stringify(a.environment)) ?? [];
    matchReasons.push({ kind: environments.some(e => e.toLocaleLowerCase('en-US').includes(options.context.environment.toLocaleLowerCase('en-US')))
      ? 'environment-field-match' : environments.length ? 'environment-different-or-unknown' : 'environment-unknown',
    requestedEnvironment: options.context.environment, environmentCompatibilityVerified: false });
  }
  return { ...item, matchReasons, ranking: 'stable-source-id; no-capability-ranking' };
}
