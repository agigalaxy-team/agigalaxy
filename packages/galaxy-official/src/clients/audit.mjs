import { randomUUID, createHash } from 'node:crypto';
import { auditGrantSchema, auditQuerySchema, auditGrantIdSchema } from "../shared/audit-schema.mjs";
import { postPublicJson, validatePublicUrl } from "../infrastructure/public-fetch.mjs";
const sha = value => createHash('sha256').update(value).digest('hex');

export function createAuditClient({ endpoint, sessions, send = postPublicJson, signApproval, now = () => Math.floor(Date.now() / 1000) }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid audit client configuration.');
  const pending = new WeakMap(); let signingPayload = null;
  async function authorization(scope, signal) {
    signal?.throwIfAborted(); const actor = await sessions.readAuthorization(endpoint);
    if (!actor?.scopes.includes(scope)) throw new Error('Audit authorization required.');
    return actor;
  }
  async function current(actor, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(actor) || !sessions.matchesAuthorization(actor)) throw new Error('Audit authorization changed.');
    signal?.throwIfAborted();
  }
  async function request(path, input, scope = 'audit', { signal, actor: supplied } = {}) {
    const actor = supplied ?? await authorization(scope, signal);
    try {
      await current(actor, signal);
      const result = await send(endpoint + path, { bodyJson: JSON.stringify(input), credential: actor.credential, signal, maxBytes: 1048576 });
      await current(actor, signal); return result;
    } catch (error) { if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(actor, 'remote-rejected'); throw error; }
  }
  async function query(input = {}, options = {}, action = 'query') {
    const selection = auditQuerySchema.parse(input), result = await request(`/v1/audit/${action}`, selection, 'audit', options);
    const { sha256, filename: _filename, mediaType: _mediaType, ...snapshot } = result ?? {};
    if (snapshot.version !== 1 || snapshot.endpoint !== endpoint || snapshot.action !== action || snapshot.metadataOnly !== true
      || !Array.isArray(snapshot.items) || snapshot.items.length > selection.limit || sha(JSON.stringify(snapshot)) !== sha256
      || (selection.subjectId && snapshot.subjectId !== selection.subjectId)) throw new Error('Audit snapshot mismatch.');
    return result;
  }
  async function prepare(input) {
    if (typeof signApproval !== 'function') throw new Error('Audit approval signer unavailable.');
    const actor = await authorization('audit-review'), issuedAt = now();
    const { lifetimeSeconds = 1800, ...selected } = input;
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 3600) throw new Error('Invalid audit approval lifetime.');
    const grant = auditGrantSchema.parse({ ...selected, version: 1, id: randomUUID(), endpoint,
      reviewerId: actor.subjectId, reviewerBindingId: actor.bindingId, issuedAt,
      expiresAt: Math.min(issuedAt + lifetimeSeconds, actor.bindingExpiresAt) });
    const payloadJson = JSON.stringify(grant), preview = Object.freeze({ endpoint, id: grant.id, payloadJson,
      confirmation: `CONFIRM AUDIT APPROVAL ${grant.id} ${sha(payloadJson)}` });
    pending.set(preview, { actor, payloadJson, state: 'prepared', controller: new AbortController() });
    return preview;
  }
  function cancel(preview) { const operation = pending.get(preview); if (!operation) throw new Error('Unknown audit approval.'); operation.state = 'canceled'; operation.controller.abort(); }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact audit approval confirmation required.');
    operation.state = 'executing'; const { actor, controller, payloadJson } = operation;
    try {
      await current(actor, controller.signal);
      if (signingPayload !== null) throw new Error('Audit approval signing already active.');
      signingPayload = payloadJson;
      let signed;
      try { signed = await signApproval(payloadJson, 'galaxy-audit-approval+jws'); } finally { signingPayload = null; }
      await current(actor, controller.signal);
      const result = await request('/v1/audit/grants/approve', { signed }, 'audit-review', { actor, signal: controller.signal });
      if (result?.id !== preview.id || result.approved !== true) throw new Error('Audit approval acknowledgement mismatch.');
      operation.state = 'completed'; return result;
    } catch (error) { if (operation.state !== 'canceled') operation.state = 'failed'; throw error; }
  }
  return Object.freeze({ query, export: (input, options) => query(input, options, 'export'), prepare, execute, cancel,
    isSigningApproval: payload => signingPayload !== null && payload === signingPayload,
    config: (_input, options) => request('/v1/audit/config', {}, 'audit', options),
    grants: (_input, options) => request('/v1/audit/grants', {}, 'audit', options),
    revoke: (input, options) => request('/v1/audit/grants/revoke', auditGrantIdSchema.parse(input), 'audit-review', options) });
}
