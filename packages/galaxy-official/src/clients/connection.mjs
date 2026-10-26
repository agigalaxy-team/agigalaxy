import { randomBytes, createHash } from 'node:crypto';
import { verifyGalaxyGenesis } from "../../../galaxy-core/src/galaxy-guid.mjs";
import { validatePublicUrl, postConnectionJson } from "../infrastructure/public-fetch.mjs";
import { verifyBindingChallenge, verifyBindingReceipt, verifySessionChallenge,
  verifySessionActivation } from "../verification/connection.mjs";

const digest = value => createHash('sha256').update(value).digest('hex');
const scopes = new Set(['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'history', 'assistance', 'context', 'notifications', 'moderation', 'capsules', 'builders', 'audit', 'audit-review', 'data-export', 'data-delete']);

export function createConnectionClient({ endpoint, trustedKeys, sign, assertCurrent,
  send = postConnectionJson, now = () => Math.floor(Date.now() / 1000) }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !(trustedKeys instanceof Map)
    || typeof sign !== 'function' || typeof assertCurrent !== 'function') throw new Error('Invalid connection client.');
  const pending = new WeakMap();
  function prepare(input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).sort().join(',') !== (input.control?'control,genesisProof,installationId,scopes,subjectId':'genesisProof,installationId,scopes,subjectId')
      || (input.control&&(!input.control||Object.keys(input.control).sort().join(',')!=='deviceId,epoch,keyId'
        ||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.control.deviceId)
        ||!/^[a-f0-9]{64}$/.test(input.control.keyId)||!Number.isSafeInteger(input.control.epoch)||input.control.epoch<1))
      || !verifyGalaxyGenesis(input.subjectId, input.genesisProof)
      || typeof input.installationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.installationId)
      || !Array.isArray(input.scopes) || !input.scopes.includes('binding')
      || input.scopes.length > scopes.size || new Set(input.scopes).size !== input.scopes.length
      || input.scopes.some(scope => !scopes.has(scope))) throw new Error('Invalid local connection request.');
    const requestJson = JSON.stringify(input);
    if (Buffer.byteLength(requestJson) > 4096) throw new Error('Connection request too large.');
    const issuedAt = now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error('Invalid local clock.');
    const expiresAt = issuedAt + 300;
    const preview = Object.freeze({ endpoint, requestJson, expiresAt,
      maximumBindingSeconds: 86400, maximumSessionSeconds: 600,
      confirmation: `CONFIRM CONNECTION ${digest(JSON.stringify({ endpoint, requestJson, expiresAt }))}` });
    pending.set(preview, { state: 'prepared', controller: new AbortController(), issuedAt });
    return preview;
  }
  function cancel(preview) {
    const operation = pending.get(preview);
    if (!operation) throw new Error('Unknown connection preview.');
    operation.state = 'canceled'; operation.controller.abort();
    operation.discardCredential?.();
  }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact connection confirmation required.');
    operation.state = 'executing';
    const signal = operation.controller.signal;
    const request = JSON.parse(preview.requestJson);
    const check = async () => {
      signal.throwIfAborted();
      const validTime = () => {
        const time = now();
        return Number.isSafeInteger(time) && time >= operation.issuedAt && time < preview.expiresAt;
      };
      if (!validTime() || await assertCurrent(preview) !== true || !validTime())
        throw new Error('Connection approval is no longer current.');
      signal.throwIfAborted();
    };
    const post = async (path, body) => {
      await check();
      const result = await send(endpoint + path, { bodyJson: JSON.stringify(body), signal });
      await check();
      return result;
    };
    const context = () => ({ endpoint, trustedKeys, now: now() });
    const localSign = async (payload, type) => {
      await check();
      const signed = await sign(payload, type);
      await check();
      if (typeof signed !== 'string' || signed.length > 24000) throw new Error('Invalid local response signature.');
      return signed;
    };
    try {
      const response = await post(request.control?'/v2/binding-challenges':'/v1/binding-challenges', request);
      const challenge = await verifyBindingChallenge(response, { ...context(), request });
      const signature = await localSign(challenge.challenge, 'galaxy-binding-response+jws');
      // Recheck expiry and pin revocation after an asynchronous signer returns.
      await verifyBindingChallenge(response, { ...context(), request });
      const bound = await post('/v1/bindings', { challenge: challenge.challenge,
        clientSession: challenge.clientSession, signature });
      const binding = await verifyBindingReceipt(bound, { ...context(), challenge });
      const credential = randomBytes(32).toString('base64url');
      const credentialHash = digest(credential);
      const sessionResponse = await post('/v1/session-challenges', { bindingId: bound.bindingId, credentialHash });
      const session = await verifySessionChallenge(sessionResponse, { ...context(), binding, credentialHash });
      const sessionSignature = await localSign(session.challenge, 'galaxy-session-response+jws');
      await verifySessionChallenge(sessionResponse, { ...context(), binding, credentialHash });
      const activation = await post('/v1/sessions', { challenge: session.challenge, signature: sessionSignature });
      const active = verifySessionActivation(activation, { challenge: session, now: now() });
      await verifyBindingReceipt(bound, { ...context(), challenge });
      await check();
      operation.state = 'completed';
      // Secrets stay in a closure; ordinary JSON serialization contains no token.
      // The trusted host must explicitly obtain and securely store it, if desired.
      let available = credential;
      operation.discardCredential = () => { available = null; };
      return Object.freeze({ endpoint, subjectId: request.subjectId, bindingId: active.bindingId,
        ...(request.control?{control:Object.freeze({...request.control})}:{}),
        scopes: Object.freeze(active.scopes), expiresAt: active.expiresAt, bindingExpiresAt: binding.expiresAt, receipt: bound.receipt,
        takeCredential() {
          const time = now();
          const value = operation.state === 'completed' && Number.isSafeInteger(time)
            && time >= operation.issuedAt && time < active.expiresAt ? available : null;
          available = null; return value;
        } });
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = 'failed';
      // A remote binding may already exist. No auto-retry, rollback or persistence.
      throw error;
    }
  }
  return Object.freeze({ prepare, execute, cancel });
}
