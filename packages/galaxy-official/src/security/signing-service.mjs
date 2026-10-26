import { signEnvelope } from './signed-envelope.mjs';
import { ServiceError } from "../shared/service-error.mjs";

// The private key stays in this closure. Application consumers receive only a
// purpose-limited signing function and a live availability check.
export function createSigningService({ endpoint, signingKey, kid, trustedKeys,
  now = () => Math.floor(Date.now() / 1000) }, types) {
  const allowed = new Set(types);
  const assertAvailable = maxAge => {
    const key = trustedKeys.get(kid);
    const time = now();
    if (!key || key.revoked || key.notBefore > time || key.notAfter < time + maxAge
      || (key.trustedUntil !== undefined && key.trustedUntil <= time))
      throw new ServiceError('signing_unavailable', 503);
  };
  return Object.freeze({
    assertAvailable,
    async sign(type, data, id, maxAge) {
      if (!allowed.has(type)) throw new ServiceError('signing_purpose_denied', 403);
      assertAvailable(maxAge);
      return signEnvelope({ type, data, id, maxAge, issuer: endpoint, audience: endpoint,
        privateKey: signingKey, kid, now: now() });
    },
  });
}
