import { isDeepStrictEqual } from 'node:util';
export { createBindingManagementClient } from './binding-management-client.mjs';
import { fetchBindingJson, validatePublicUrl } from './public-fetch.mjs';

// An explicit point-in-time check, never a heartbeat or automatic reconnect.
export function createBindingStatusClient({ endpoint, sessions, send = fetchBindingJson,
  now = () => Math.floor(Date.now() / 1000) }) {
  if (validatePublicUrl(endpoint).origin !== endpoint) throw new Error('Canonical endpoint required.');
  const result = (state, remoteState = 'unknown') => Object.freeze({ endpoint, state, remoteState, connected: false });
  async function check({ signal } = {}) {
    signal?.throwIfAborted();
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization) return result('no-session', 'not-checked');
    const startedAt = now();
    const validTime = () => {
      const time = now();
      return Number.isSafeInteger(startedAt) && startedAt >= 0
        && Number.isSafeInteger(time) && time >= startedAt && time < authorization.expiresAt;
    };
    try {
      signal?.throwIfAborted();
      if (!validTime()) throw new Error('Check expired.');
      if (!await sessions.isAuthorizationCurrent(authorization) || !sessions.matchesAuthorization(authorization))
        return result('superseded');
      signal?.throwIfAborted();
      const document = await send(`${endpoint}/v1/bindings/${authorization.bindingId}`,
        { credential: authorization.credential, signal });
      signal?.throwIfAborted();
      const exactKeys = ['bindingId', 'expiresAt', 'scopes', 'state', 'subjectId'];
      if (!document || typeof document !== 'object' || Array.isArray(document)
        || !isDeepStrictEqual(Object.keys(document).sort(), exactKeys)
        || document.bindingId !== authorization.bindingId || document.subjectId !== authorization.subjectId
        || !isDeepStrictEqual(document.scopes, authorization.scopes) || document.state !== 'active'
        || typeof document.expiresAt !== 'string'
        || document.expiresAt !== new Date(authorization.bindingExpiresAt * 1000).toISOString()) {
        const error = new Error('Binding status mismatch.');
        error.code = 'GALAXY_REMOTE_REJECTED'; throw error;
      }
      if (!validTime()) throw new Error('Check expired.');
      if (!await sessions.isAuthorizationCurrent(authorization) || !sessions.matchesAuthorization(authorization))
        return result('superseded');
      signal?.throwIfAborted();
      const checkedAt = now();
      if (!Number.isSafeInteger(checkedAt) || checkedAt < startedAt || checkedAt >= authorization.expiresAt)
        throw new Error('Check expired.');
      return Object.freeze({ endpoint, state: 'binding-verified', remoteState: 'active', connected: false,
        checkedAt, bindingId: authorization.bindingId, subjectId: authorization.subjectId,
        scopes: Object.freeze([...authorization.scopes]), expiresAt: authorization.expiresAt,
        bindingExpiresAt: authorization.bindingExpiresAt });
    } catch (error) {
      const reason = error.code === 'GALAXY_REMOTE_REJECTED' ? 'remote-rejected' : 'remote-outcome-unknown';
      if (!sessions.invalidateAuthorization(authorization, reason)) return result('superseded');
      return result(reason, reason === 'remote-rejected' ? 'rejected' : 'unknown');
    }
  }
  return Object.freeze({ check });
}
