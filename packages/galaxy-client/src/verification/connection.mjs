import { sha256Hex as digest, equalJson as isDeepStrictEqual, isCredential } from '../../../galaxy-contracts/src/web-primitives.mjs';
import { verifyEnvelope } from './envelope.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(','))
    throw new Error('Invalid connection response.');
}
function credential(value) {
  return isCredential(value);
}
const options = (type, endpoint, trustedKeys, now, maxAge) => {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Explicit verification time required.');
  return { type, issuer: endpoint, audience: endpoint, trustedKeys, now, maxAge };
};

// Expected request comes from the immutable, locally confirmed request snapshot.
// Server signatures do not authorize changing the user's subject or scopes.
export async function verifyBindingChallenge(document, { request, endpoint, trustedKeys, now }) {
  exact(document, 'challengeId,challenge,clientSession');
  if (!uuid(document.challengeId) || !credential(document.clientSession)) throw new Error('Invalid binding response.');
  const opened = await verifyEnvelope(document.challenge, options('binding-challenge', endpoint, trustedKeys, now, 180));
  const data = opened.data;
  exact(data, 'subjectId,genesisProof,installationId,scopes,purpose,endpoint,clientSessionHash,bindingExpiresAt'+(request.control?',control':''));
  if (opened.id !== document.challengeId || data.purpose !== 'bind' || data.endpoint !== endpoint
    || !isDeepStrictEqual({ subjectId: data.subjectId, genesisProof: data.genesisProof,
      installationId: data.installationId, scopes: data.scopes,...(request.control?{control:data.control}:{}) }, request)
    || data.clientSessionHash !== await digest(document.clientSession)
    || !Number.isSafeInteger(data.bindingExpiresAt) || data.bindingExpiresAt <= now
    || data.bindingExpiresAt > opened.issuedAt + 86400) throw new Error('Binding challenge mismatch.');
  return { ...opened, challenge: document.challenge, clientSession: document.clientSession };
}

export async function verifyBindingReceipt(document, { challenge, endpoint, trustedKeys, now }) {
  exact(document, 'bindingId,receipt');
  if (!uuid(document.bindingId)) throw new Error('Invalid binding receipt.');
  const opened = await verifyEnvelope(document.receipt, options('binding-receipt', endpoint, trustedKeys, now, 86400));
  const data = opened.data, expected = challenge.data;
  exact(data, 'bindingId,subjectId,publicKeyFingerprint,installationId,endpoint,scopes,expiresAt,revokePath,auditReference'+(expected.control?',control':''));
  if (opened.id !== document.bindingId || data.bindingId !== document.bindingId
    || data.subjectId !== expected.subjectId || data.installationId !== expected.installationId
    || data.endpoint !== endpoint || !isDeepStrictEqual(data.scopes, expected.scopes)
    || !isDeepStrictEqual(data.control,expected.control)
    || data.publicKeyFingerprint !== await digest(expected.genesisProof.publicKeyPem)
    || data.expiresAt !== expected.bindingExpiresAt || data.expiresAt !== opened.expiresAt
    || data.revokePath !== `/v1/bindings/${document.bindingId}/revoke`
    || data.auditReference !== challenge.id) throw new Error('Binding receipt mismatch.');
  return opened;
}

// Reopening a device needs a fresh short-lived session, not a different
// binding. This public receipt is checked against the same local choice;
// neither its signature nor a stored ID can authorize another owner or scope.
export async function verifyExistingBindingReceipt(document, { request, endpoint, trustedKeys, now }) {
  exact(document, 'bindingId,receipt');
  if (!uuid(document.bindingId)) throw new Error('Invalid binding receipt.');
  const opened = await verifyEnvelope(document.receipt, options('binding-receipt', endpoint, trustedKeys, now, 86400));
  const data = opened.data;
  exact(data, 'bindingId,subjectId,publicKeyFingerprint,installationId,endpoint,scopes,expiresAt,revokePath,auditReference,control');
  if (opened.id !== document.bindingId || data.bindingId !== document.bindingId
    || data.subjectId !== request.subjectId || data.installationId !== request.installationId
    || data.endpoint !== endpoint || !isDeepStrictEqual(data.scopes, request.scopes)
    || !isDeepStrictEqual(data.control, request.control)
    || data.publicKeyFingerprint !== await digest(request.genesisProof.publicKeyPem)
    || !Number.isSafeInteger(data.expiresAt) || data.expiresAt !== opened.expiresAt
    || data.expiresAt <= now || data.expiresAt > opened.issuedAt + 86400
    || data.revokePath !== `/v1/bindings/${document.bindingId}/revoke` || !uuid(data.auditReference))
    throw new Error('Existing binding receipt mismatch.');
  return opened;
}

export async function verifySessionChallenge(document, { binding, credentialHash, endpoint, trustedKeys, now }) {
  exact(document, 'challenge');
  if (typeof credentialHash !== 'string' || !/^[a-f0-9]{64}$/.test(credentialHash)) throw new Error('Invalid credential hash.');
  const opened = await verifyEnvelope(document.challenge, options('session-challenge', endpoint, trustedKeys, now, 120));
  const data = opened.data;
  exact(data, 'bindingId,credentialHash,purpose,scopes,credentialExpiresAt');
  if (data.purpose !== 'session' || data.bindingId !== binding.data.bindingId
    || binding.data.endpoint !== endpoint || binding.expiresAt <= now
    || data.credentialHash !== credentialHash || !isDeepStrictEqual(data.scopes, binding.data.scopes)
    || !Number.isSafeInteger(data.credentialExpiresAt) || data.credentialExpiresAt <= now
    || data.credentialExpiresAt > Math.min(opened.issuedAt + 600, binding.expiresAt))
    throw new Error('Session challenge mismatch.');
  return { ...opened, challenge: document.challenge };
}

export function verifySessionActivation(document, { challenge, now }) {
  exact(document, 'bindingId,expiresAt,scopes');
  if (!Number.isSafeInteger(now) || now < challenge.issuedAt || challenge.expiresAt <= now
    || document.bindingId !== challenge.data.bindingId
    || document.expiresAt !== challenge.data.credentialExpiresAt || document.expiresAt <= now
    || !isDeepStrictEqual(document.scopes, challenge.data.scopes)) throw new Error('Session activation mismatch.');
  // An acknowledgement is not proof of live revocation status or valid Consent.
  return { bindingId: document.bindingId, expiresAt: document.expiresAt, scopes: [...document.scopes] };
}
