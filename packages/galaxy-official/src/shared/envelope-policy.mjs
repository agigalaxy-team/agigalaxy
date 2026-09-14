export const SIGNATURE_ALGORITHM = 'Ed25519';
const TYPES = new Set(['hub-peering', 'keyring', 'manifest', 'binding-challenge', 'binding-receipt', 'session-challenge', 'proof', 'conformance', 'node-control']);
export const MAX_TOKEN_BYTES = 65536;

export function context({ type, issuer, audience, now, maxAge }) {
  if (!TYPES.has(type)) throw new Error('Unsupported signed object type.');
  for (const endpoint of [issuer, audience]) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || url.origin !== endpoint) throw new Error('A canonical HTTPS origin is required.');
  }
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAge)
    || maxAge < 1 || maxAge > 86400) throw new Error('Invalid signing time policy.');
}

