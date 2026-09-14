import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import { caseEventSchema } from './shared/cases-schema.mjs';
import { postPublicJson, fetchCaseJson, validatePublicUrl } from './public-fetch.mjs';

// The host supplies an existing exact-payload Consent; this client never grants it.
export function createCaseClient({ endpoint, sessions, send = postPublicJson, read = fetchCaseJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Case client configuration.');
  const pending = new WeakMap();
  async function authorize(signal) {
    signal?.throwIfAborted();
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization?.scopes.includes('case-teaser')) throw new Error('Case authorization required.');
    return authorization;
  }
  async function check(authorization, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(authorization) || !sessions.matchesAuthorization(authorization))
      throw new Error('Case authorization changed.');
    signal?.throwIfAborted();
  }
  function reject(authorization, error) {
    if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(authorization, 'remote-rejected');
    throw error;
  }
  function prepare({ consentId, payloadJson }) {
    z.uuid().parse(consentId);
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 12000) throw new Error('Invalid Case payload.');
    const event = caseEventSchema.parse(JSON.parse(payloadJson));
    const path = event.kind === 'case' ? '/v1/cases' : '/v1/case-events';
    const bodyJson = JSON.stringify({ consentId, payloadJson });
    const hash = createHash('sha256').update(bodyJson).digest('hex');
    const preview = Object.freeze({ endpoint, path, consentId, payloadJson, eventId: event.id,
      confirmation: `CONFIRM CASE ${event.id} ${hash}` });
    pending.set(preview, { event, bodyJson, state: 'prepared', controller: new AbortController() });
    return preview;
  }
  function cancel(preview) {
    const operation = pending.get(preview);
    if (!operation) throw new Error('Unknown Case preview.');
    operation.state = 'canceled'; operation.controller.abort();
  }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact Case confirmation required.');
    operation.state = 'executing';
    const { event, controller } = operation;
    let authorization;
    try {
      authorization = await authorize(controller.signal);
      await check(authorization, controller.signal);
      const result = await send(endpoint + preview.path, { bodyJson: operation.bodyJson,
        credential: authorization.credential, signal: controller.signal });
      await check(authorization, controller.signal);
      if (!result || result.caseId !== (event.kind === 'case' ? event.id : event.caseId)
        || result.eventId !== event.id || result.version !== (event.kind === 'case' ? 1 : event.expectedVersion + 1)
        || result.verification !== 'unverified') throw new Error('Case acknowledgement mismatch; check remote outcome.');
      operation.state = 'completed';
      return { caseId: result.caseId, eventId: result.eventId, version: result.version, verification: 'unverified' };
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = 'failed';
      if (authorization) reject(authorization, error);
      throw error;
    }
  }
  async function get(caseId, { signal } = {}) {
    z.uuid().parse(caseId);
    const authorization = await authorize(signal);
    try {
      await check(authorization, signal);
      const result = await read(`${endpoint}/v1/cases/${caseId}`, { credential: authorization.credential, signal, maxBytes: 1048576 });
      await check(authorization, signal);
      if (!result || result.caseId !== caseId || !Number.isInteger(result.version) || result.version < 1
        || result.verification !== 'unverified' || !Array.isArray(result.events) || result.events.length > 1000)
        throw new Error('Invalid Case response.');
      return { ...result, endpoint, source: 'endpoint-reported' };
    } catch (error) { reject(authorization, error); }
  }
  return Object.freeze({ prepare, execute, cancel, get });
}
