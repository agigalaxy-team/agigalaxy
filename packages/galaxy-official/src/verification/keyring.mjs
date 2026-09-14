import { createPublicKey, createHash } from 'node:crypto';
import { verifyEnvelope } from './envelope.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function exact(value, expected) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== expected) throw new Error('Invalid keyring schema.');
}
export function validateKeyring(data, endpoint) {
  exact(data, 'endpoint,keys,sequence,version');
  if (data.version !== 1 || data.endpoint !== endpoint || !Number.isSafeInteger(data.sequence)
    || data.sequence < 1 || !Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 32)
    throw new Error('Invalid keyring.');
  const seen = new Set();
  for (const key of data.keys) {
    exact(key, 'kid,notAfter,notBefore,publicKeyPem,revoked');
    if (typeof key.kid !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(key.kid) || seen.has(key.kid)
      || !Number.isSafeInteger(key.notBefore) || key.notBefore < 0 || !Number.isSafeInteger(key.notAfter)
      || key.notAfter <= key.notBefore || typeof key.revoked !== 'boolean'
      || typeof key.publicKeyPem !== 'string' || key.publicKeyPem.length > 256) throw new Error('Invalid service key.');
    const parsed = createPublicKey(key.publicKeyPem);
    if (parsed.asymmetricKeyType !== 'ed25519' || parsed.export({ type: 'spki', format: 'pem' }) !== key.publicKeyPem)
      throw new Error('Invalid service key encoding.');
    seen.add(key.kid);
  }
  return data;
}

// previousState is locally retained per endpoint. It is public metadata, not an
// identity or a credential. A caller must persist nextState before using keys.
export async function verifyKeyring(document, { endpoint, rootPins, previousState = null,
  now = Math.floor(Date.now() / 1000) }) {
  exact(document, 'signed');
  const opened = await verifyEnvelope(document.signed, { type: 'keyring', issuer: endpoint,
    audience: endpoint, trustedKeys: rootPins, now, maxAge: 86400 });
  const data = validateKeyring(opened.data, endpoint);
  const documentHash = hash(document.signed);
  if (previousState && (previousState.endpoint !== endpoint || !Number.isSafeInteger(previousState.sequence)
    || data.sequence < previousState.sequence
    || (data.sequence === previousState.sequence && documentHash !== previousState.documentHash)))
    throw new Error('Keyring rollback or conflicting sequence.');
  const history = new Map((previousState?.history ?? []).map(item => [item.kid, item]));
  for (const key of data.keys) {
    const fingerprint = hash(key.publicKeyPem);
    const previous = history.get(key.kid);
    if (previous && (previous.fingerprint !== fingerprint || (previous.revoked && !key.revoked)))
      throw new Error('Signing key reuse or resurrection.');
    history.set(key.kid, { kid: key.kid, fingerprint, revoked: key.revoked });
  }
  const keys = new Map(data.keys.map(key => [key.kid, { ...key, trustedUntil: opened.expiresAt }]));
  return { keys, expiresAt: opened.expiresAt, nextState: { endpoint, sequence: data.sequence,
    documentHash, history: [...history.values()] } };
}
