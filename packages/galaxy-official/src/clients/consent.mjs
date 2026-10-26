import { createHash } from 'node:crypto';
import { consentSchema } from "../shared/consents-schema.mjs";
import { assertConsentPolicy } from "../domain/consent-policy.mjs";
import { postPublicJson, validatePublicUrl } from "../infrastructure/public-fetch.mjs";

// Trusted host composition supplies local authorization and a local signer.
// No identity initialization, key loading, database or server signer dependency.
export function createConsentClient({ endpoint, readAuthorization, signIntent,
  send = postPublicJson, now = () => Math.floor(Date.now() / 1000) }) {
  if (validatePublicUrl(endpoint).origin !== endpoint
    || typeof readAuthorization !== 'function' || typeof signIntent !== 'function')
    throw new Error('Invalid consent client configuration.');
  const pending = new WeakMap();
  function prepare(input) {
    const intent = consentSchema.parse(input);
    assertConsentPolicy(intent, { actor: intent, endpoint, now: now() });
    const intentJson = JSON.stringify(intent);
    if (Buffer.byteLength(intentJson) > 11000) throw new Error('Consent too large.');
    const hash = createHash('sha256').update(intentJson).digest('hex');
    // Display this exact JSON to the user, not a lossy summary of its scope.
    const preview = Object.freeze({ endpoint, path: '/v1/consents', intentJson,
      confirmation: `CONFIRM CONSENT ${intent.id} ${hash}`, expiresAt: intent.expiresAt });
    pending.set(preview, { intent, state: 'prepared', controller: new AbortController() });
    return preview;
  }
  function cancel(preview) {
    const operation = pending.get(preview);
    if (!operation) throw new Error('Unknown preview.');
    operation.state = 'canceled'; operation.controller.abort();
    // Cancellation after dispatch does not promise server-side rollback.
  }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact confirmation required.');
    operation.state = 'executing';
    const { intent, controller } = operation;
    const check = async () => {
      controller.signal.throwIfAborted();
      const actor = await readAuthorization();
      controller.signal.throwIfAborted();
      const time = now();
      if (!actor || actor.revoked !== false || !Number.isSafeInteger(actor.expiresAt)
        || actor.expiresAt <= time || !Array.isArray(actor.scopes) || !actor.scopes.includes('consent')
        || typeof actor.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(actor.credential)
        || Buffer.from(actor.credential, 'base64url').toString('base64url') !== actor.credential)
        throw new Error('Current authorization required.');
      assertConsentPolicy(intent, { actor, endpoint, now: time });
      return actor;
    };
    try {
      await check();
      const signedIntent = await signIntent(preview.intentJson, 'galaxy-consent+jws');
      if (typeof signedIntent !== 'string' || signedIntent.length > 16384)
        throw new Error('Invalid local signature.');
      const actor = await check();
      // Single dispatch only; timeout/abort may leave an unknown remote result.
      const result = await send(endpoint + preview.path, { bodyJson: JSON.stringify({ signedIntent }),
        credential: actor.credential, signal: controller.signal });
      controller.signal.throwIfAborted();
      let accepted;
      try {
        if (!result || Object.getPrototypeOf(result) !== Object.prototype
          || Object.keys(result).sort().join(',') !== 'consentId,intent,status'
          || result.consentId !== intent.id || result.status !== 'active')
          throw new Error('Invalid acknowledgement.');
        accepted = consentSchema.parse(result.intent);
        if (JSON.stringify(accepted) !== preview.intentJson) throw new Error('Changed intent.');
      } catch { throw new Error('Consent response mismatch; remote outcome requires review.'); }
      await check();
      operation.state = 'completed';
      return { consentId: intent.id, status: 'active', intent: accepted };
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = 'failed';
      throw error;
    }
  }
  return Object.freeze({ prepare, execute, cancel });
}
