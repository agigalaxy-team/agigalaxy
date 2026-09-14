import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import { moderationReportSchema, moderationEventSchema } from './shared/moderation-schema.mjs';
import { postPublicJson, validatePublicUrl } from './public-fetch.mjs';

// The host supplies an existing exact-payload Consent; this client never grants it.
export function createModerationClient({ endpoint, sessions, send = postPublicJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Moderation client configuration.');
  const pending = new WeakMap();
  async function authorize(signal) {
    signal?.throwIfAborted();
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization?.scopes.includes('moderation')) throw new Error('Moderation authorization required.');
    return authorization;
  }
  async function check(authorization, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(authorization) || !sessions.matchesAuthorization(authorization))
      throw new Error('Moderation authorization changed.');
    signal?.throwIfAborted();
  }
  function reject(authorization, error) {
    if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(authorization, 'remote-rejected');
    throw error;
  }
  function prepare({ consentId, payloadJson }) {
    z.uuid().parse(consentId);
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 16000) throw new Error('Invalid Moderation payload.');
    const payload = JSON.parse(payloadJson);
    const isEvent = Object.hasOwn(payload, 'reportId');
    const data = (isEvent ? moderationEventSchema : moderationReportSchema).parse(payload);
    const event = data;
    const reportId = isEvent ? data.reportId : data.id;
    const expectedVersion = isEvent ? event.expectedVersion + 1 : 1;
    const path = isEvent ? `/v1/moderation/reports/${reportId}/events` : '/v1/moderation/reports';
    const bodyJson = JSON.stringify({ consentId, payloadJson });
    const hash = createHash('sha256').update(bodyJson).digest('hex');
    const preview = Object.freeze({ endpoint, path, consentId, payloadJson, reportId, eventId: event.id,
      confirmation: `CONFIRM MODERATION ${event.id} ${hash}` });
    pending.set(preview, { event, reportId, expectedVersion, bodyJson, state: 'prepared', controller: new AbortController() });
    return preview;
  }
  function cancel(preview) {
    const operation = pending.get(preview);
    if (!operation) throw new Error('Unknown Moderation preview.');
    operation.state = 'canceled'; operation.controller.abort();
  }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact Moderation confirmation required.');
    operation.state = 'executing';
    const { event, reportId, expectedVersion, controller } = operation;
    let authorization;
    try {
      authorization = await authorize(controller.signal);
      await check(authorization, controller.signal);
      const result = await send(endpoint + preview.path, { bodyJson: operation.bodyJson,
        credential: authorization.credential, signal: controller.signal });
      await check(authorization, controller.signal);
      if (!result || result.reportId !== reportId || result.eventId !== event.id || result.version !== expectedVersion)
        throw new Error('Moderation acknowledgement mismatch; check remote outcome.');
      operation.state = 'completed';
      return { reportId, eventId: result.eventId, version: result.version };
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = 'failed';
      if (authorization) reject(authorization, error);
      throw error;
    }
  }
  async function request(path, input = {}, { signal } = {}) {
    const authorization = await authorize(signal);
    try { await check(authorization, signal);
      const result = await send(endpoint + path, { bodyJson: JSON.stringify(input), credential: authorization.credential, signal, maxBytes: 1048576 });
      await check(authorization, signal); return result;
    } catch (error) { reject(authorization, error); }
  }
  async function get(id, options) {
    z.uuid().parse(id); const result = await request(`/v1/moderation/reports/${id}/read`, {}, options);
    if (result?.reportId !== id || !Number.isInteger(result.version) || !Array.isArray(result.events)) throw new Error('Invalid moderation response.');
    return result;
  }
  return Object.freeze({ prepare, execute, cancel, get,
    config: (input, options) => request('/v1/moderation/config', input, options),
    query: (input, options) => request('/v1/moderation/reports/query', input, options) });
}
