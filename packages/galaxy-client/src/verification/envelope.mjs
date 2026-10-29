import { jwtVerify, importSPKI } from 'jose';
import { context, SIGNATURE_ALGORITHM, MAX_TOKEN_BYTES } from '../../../galaxy-contracts/src/envelope-policy.mjs';

// Trust is supplied by pinned configuration, never from the received payload.
// The caller must separately validate each data schema and persist one-use JTIs.
export async function verifyEnvelope(token, { type, issuer, audience, trustedKeys,
  now = Math.floor(Date.now() / 1000), maxAge = 300 }) {
  context({ type, issuer, audience, now, maxAge });
  if (typeof token !== 'string' || new TextEncoder().encode(token).length > MAX_TOKEN_BYTES
    || !(trustedKeys instanceof Map)) throw new Error('Invalid signed object.');
  const { payload, protectedHeader } = await jwtVerify(token, async (header) => {
    if (Object.keys(header).sort().join(',') !== 'alg,kid,typ'
      || typeof header.kid !== 'string') throw new Error('Untrusted signature header.');
    const pin = trustedKeys.get(header.kid);
    if (!pin || pin.revoked || !Number.isSafeInteger(pin.notBefore)
      || !Number.isSafeInteger(pin.notAfter) || now < pin.notBefore || now >= pin.notAfter
      || (pin.trustedUntil !== undefined && (!Number.isSafeInteger(pin.trustedUntil) || now >= pin.trustedUntil)))
      throw new Error('Unknown, revoked or expired signing key.');
    return importSPKI(pin.publicKeyPem, SIGNATURE_ALGORITHM);
  }, { algorithms: [SIGNATURE_ALGORITHM], typ: `galaxy-${type}+jwt`, issuer, audience,
    requiredClaims: ['iat', 'nbf', 'exp', 'jti', 'data'], currentDate: new Date(now * 1000),
    clockTolerance: 0, maxTokenAge: maxAge });
  if (Object.keys(payload).sort().join(',') !== 'aud,data,exp,iat,iss,jti,nbf'
    || payload.aud !== audience || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp) || payload.nbf !== payload.iat
    || payload.exp <= payload.iat || payload.exp - payload.iat > maxAge
    || typeof payload.jti !== 'string' || payload.jti.length < 1 || payload.jti.length > 128
    || !payload.data || Object.getPrototypeOf(payload.data) !== Object.prototype)
    throw new Error('Invalid signed claims.');
  const pin = trustedKeys.get(protectedHeader.kid);
  if (payload.iat < pin.notBefore || payload.exp > pin.notAfter)
    throw new Error('Signed object exceeds key validity.');
  return { data: payload.data, id: payload.jti, issuedAt: payload.iat,
    expiresAt: payload.exp, kid: protectedHeader.kid };
}
