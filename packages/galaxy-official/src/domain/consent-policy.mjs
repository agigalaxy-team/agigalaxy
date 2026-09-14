import { ServiceError } from '../shared/service-error.mjs';

const forbidden = new Set(['privateKey', 'privateKeyPem', 'token', 'password', 'credentials', 'rawContext', 'cookie', 'authorization']);

export function assertConsentPolicy(intent, { actor, endpoint, now }) {
      if (intent.subjectId !== actor.subjectId || intent.bindingId !== actor.bindingId || intent.endpoint !== endpoint
        || intent.issuedAt > now || intent.issuedAt < now - 300 || intent.expiresAt <= now || intent.expiresAt - intent.issuedAt > 2592000
        || intent.visibility === 'Local' || intent.fields.some(field => forbidden.has(field))
        || new Set(intent.fields).size !== intent.fields.length || new Set(intent.viewers).size !== intent.viewers.length
        || (intent.visibility === 'Hub-scoped' && (!intent.recipient.startsWith('https://') || !intent.viewers.length))
        || (intent.visibility === 'Public' && intent.purpose !== 'public-profile')) throw new ServiceError('consent_policy_denied', 403);
}

// Visibility check only; callers must first load a nonrevoked grant and binding
// through require() in their read transaction. It cannot establish DB validity.
export function canReadProjection(intent, { viewerId = null, projection = 'summary', hubEndpoint = null,
  now = Math.floor(Date.now() / 1000), revoked = false } = {}) {
  if (revoked || intent.issuedAt > now || intent.expiresAt <= now) return false;
  if (viewerId === intent.subjectId) return true;
  if (intent.currentVisibility?.deletionPending === true) return false;
  if (intent.visibility === 'Public') return intent.purpose === 'public-profile';
  if (intent.visibility === 'Private') return viewerId !== null && intent.viewers.includes(viewerId);
  if (intent.visibility === 'Proof-only') return projection === 'proof' && viewerId !== null && intent.viewers.includes(viewerId);
  if (intent.visibility === 'Hub-scoped') return hubEndpoint === intent.recipient && viewerId !== null && intent.viewers.includes(viewerId);
  return false;
}
