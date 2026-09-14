// Interoperability example only. No Galaxy implementation or JOSE dependency.
// Cryptographic validity is NOT authorization, freshness of remote revocation,
// data-schema validity, or one-time challenge consumption.
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyIndependent({ token, publicKeyPem, policy }) {
  const reject = () => { throw new Error('Envelope rejected'); };
  if (typeof token !== 'string' || token.length > 65536 || !policy) reject();
  const parts = token.split('.');
  if (parts.length !== 3) reject();
  const decoded = parts.map(part => {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) reject();
    const bytes = Buffer.from(part, 'base64url');
    if (bytes.toString('base64url') !== part) reject();
    return bytes;
  });
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded[0]));
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded[1]));
  if (!header || Object.keys(header).sort().join(',') !== 'alg,kid,typ'
    || header.alg !== 'Ed25519' || header.typ !== `galaxy-${policy.type}+jwt`
    || header.kid !== policy.kid || policy.revoked !== false) reject();
  for (const origin of [policy.issuer, policy.audience]) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) reject();
  }
  if (![policy.now, policy.maxAge, policy.notBefore, policy.notAfter].every(Number.isSafeInteger)
    || policy.now < 0 || policy.maxAge < 1 || policy.maxAge > 86400
    || policy.now < policy.notBefore || policy.now >= policy.notAfter
    || (policy.trustedUntil !== undefined && (!Number.isSafeInteger(policy.trustedUntil)
      || policy.now >= policy.trustedUntil))) reject();
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519' || decoded[2].length !== 64
    || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key, decoded[2])) reject();
  if (!body || Object.keys(body).sort().join(',') !== 'aud,data,exp,iat,iss,jti,nbf'
    || body.iss !== policy.issuer || body.aud !== policy.audience
    || !Number.isSafeInteger(body.iat) || !Number.isSafeInteger(body.exp)
    || body.nbf !== body.iat || body.iat > policy.now || body.exp <= policy.now
    || body.exp <= body.iat || body.exp - body.iat > policy.maxAge
    || body.iat < policy.notBefore || body.exp > policy.notAfter
    || typeof body.jti !== 'string' || !body.jti.length || body.jti.length > 128
    || !body.data || Object.getPrototypeOf(body.data) !== Object.prototype) reject();
  return { validSignature: true, authorized: false, id: body.jti, data: body.data };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected fixture path');
    const result = verifyIndependent(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify({ validSignature: result.validSignature, authorized: false }));
  } catch {
    console.error('Independent envelope verification failed');
    process.exitCode = 1;
  }
}
