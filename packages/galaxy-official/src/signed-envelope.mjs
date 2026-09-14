import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { context, SIGNATURE_ALGORITHM, MAX_TOKEN_BYTES } from './shared/envelope-policy.mjs';
export { SIGNATURE_ALGORITHM } from './shared/envelope-policy.mjs';
export { verifyEnvelope } from './verification/envelope.mjs';

// JWT signs the exact encoded payload bytes. No verifier reserializes JSON.
export async function signEnvelope({ type, issuer, audience, kid, privateKey, data,
  now = Math.floor(Date.now() / 1000), maxAge = 300, id = randomUUID() }) {
  context({ type, issuer, audience, now, maxAge });
  if (typeof kid !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(kid)
    || typeof id !== 'string' || id.length < 1 || id.length > 128
    || !data || Object.getPrototypeOf(data) !== Object.prototype) throw new Error('Invalid signed object.');
  const token = await new SignJWT({ data })
    .setProtectedHeader({ alg: SIGNATURE_ALGORITHM, typ: `galaxy-${type}+jwt`, kid })
    .setIssuer(issuer).setAudience(audience).setIssuedAt(now).setNotBefore(now)
    .setExpirationTime(now + maxAge).setJti(id).sign(privateKey);
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new Error('Signed object too large.');
  return token;
}

