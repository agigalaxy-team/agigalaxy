import { validatePublicUrl } from './public-fetch.mjs';

// Process-scoped credential handoff for a trusted host. Never serialize the
// vault or expose readAuthorization as a generic MCP tool. No disk/network I/O.
export function createSessionMemory({ isCurrent, now = () => Math.floor(Date.now() / 1000), capacity = 32 }) {
  if (typeof isCurrent !== 'function' || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32)
    throw new Error('Invalid session memory configuration.');
  const sessions = new Map();
  const authorizations = new WeakMap();
  const origin = endpoint => {
    if (validatePublicUrl(endpoint).origin !== endpoint) throw new Error('Canonical session endpoint required.');
  };
  const publicState = record => Object.freeze({ ...record.metadata,
    state: record.credential ? 'session-local' : record.reason,
    connected: false, remoteState: 'not-checked' });
  function drop(record, reason) { record.credential = null; record.reason = reason; }
  function adopt(result) {
    origin(result.endpoint);
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(result.expiresAt)
      || result.expiresAt <= time || result.expiresAt > time + 600
      || !Number.isSafeInteger(result.bindingExpiresAt) || result.bindingExpiresAt < result.expiresAt
      || result.bindingExpiresAt > time + 86400
      || typeof result.subjectId !== 'string' || !/^GUID[0-9A-Z]{28}$/.test(result.subjectId)
      || typeof result.bindingId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.bindingId)
      || !Array.isArray(result.scopes) || !result.scopes.includes('binding')
      || new Set(result.scopes).size !== result.scopes.length
      || result.scopes.some(scope => !['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'history', 'assistance', 'context', 'notifications', 'moderation', 'capsules', 'builders', 'audit', 'audit-review', 'data-export', 'data-delete'].includes(scope))
      || typeof result.takeCredential !== 'function') throw new Error('Invalid completed connection.');
    if (!sessions.has(result.endpoint) && sessions.size >= capacity) throw new Error('Session memory capacity reached.');
    const credential = result.takeCredential();
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)
      || Buffer.from(credential, 'base64url').toString('base64url') !== credential)
      throw new Error('Connection credential unavailable.');
    const previous = sessions.get(result.endpoint);
    if (previous) drop(previous, 'replaced');
    const record = { credential, reason: 'session-local', issuedAt: time,
      metadata: { endpoint: result.endpoint, subjectId: result.subjectId, bindingId: result.bindingId,
        scopes: Object.freeze([...result.scopes]), expiresAt: result.expiresAt, bindingExpiresAt: result.bindingExpiresAt } };
    sessions.set(result.endpoint, record);
    return publicState(record);
  }
  async function current(endpoint) {
    origin(endpoint);
    const record = sessions.get(endpoint);
    if (!record || !record.credential) return null;
    const validTime = () => {
      const time = now();
      return Number.isSafeInteger(time) && time >= record.issuedAt && time < record.metadata.expiresAt;
    };
    if (!validTime()) { drop(record, 'expired'); return null; }
    let allowed;
    try { allowed = await isCurrent(publicState(record)); }
    catch { drop(record, 'local-check-failed'); return null; }
    // A late callback must not resurrect a forgotten or replaced credential.
    if (sessions.get(endpoint) !== record || !record.credential) return null;
    if (!validTime()) { drop(record, 'expired'); return null; }
    if (allowed !== true) { drop(record, 'local-authorization-changed'); return null; }
    return record;
  }
  async function readAuthorization(endpoint) {
    const record = await current(endpoint);
    if (!record || sessions.get(endpoint) !== record || !record.credential) return null;
    const authorization = { ...record.metadata, scopes: [...record.metadata.scopes], revoked: false, credential: record.credential };
    authorizations.set(authorization, record);
    return authorization;
  }
  async function status(endpoint) {
    await current(endpoint);
    const record = sessions.get(endpoint);
    return record ? publicState(record) : { endpoint, state: 'no-session', connected: false, remoteState: 'not-checked' };
  }
  function invalidate(endpoint, reason = 'disconnected') {
    if (!['disconnected', 'remote-outcome-unknown', 'remote-rejected', 'local-reset'].includes(reason))
      throw new Error('Invalid session invalidation reason.');
    const record = sessions.get(endpoint);
    if (record) drop(record, reason);
  }
  // Object identity is a lease on this exact record, not on its endpoint or ID.
  // A late remote response must never invalidate a newly adopted session.
  function matchesAuthorization(authorization) {
    const record = authorizations.get(authorization);
    return !!record && sessions.get(record.metadata.endpoint) === record && !!record.credential;
  }
  async function isAuthorizationCurrent(authorization) {
    const record = authorizations.get(authorization);
    if (!record) return false;
    const latest = await current(record.metadata.endpoint);
    return latest === record && sessions.get(record.metadata.endpoint) === record && !!record.credential;
  }
  function invalidateAuthorization(authorization, reason) {
    const record = authorizations.get(authorization);
    if (!record || sessions.get(record.metadata.endpoint) !== record || !record.credential) return false;
    invalidate(record.metadata.endpoint, reason);
    return true;
  }
  function forget(endpoint) {
    const record = sessions.get(endpoint);
    if (record) drop(record, 'forgotten');
    sessions.delete(endpoint);
  }
  function close() {
    for (const record of sessions.values()) drop(record, 'closed');
    sessions.clear();
  }
  return Object.freeze({ adopt, readAuthorization, matchesAuthorization, isAuthorizationCurrent, invalidateAuthorization, status, invalidate, forget, close });
}
