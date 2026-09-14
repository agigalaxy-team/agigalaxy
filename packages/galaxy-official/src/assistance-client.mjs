import { qualificationQuerySchema } from './shared/qualification-schema.mjs';
import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import { assistanceRequestSchema, assistanceEnvelopeSchema, assistanceQuerySchema, assistanceReceiptSchema, requesterHistorySchema, requesterHistoryFactsSchema } from './shared/assistance-schema.mjs';
import { postPublicJson, fetchAssistanceJson, validatePublicUrl } from './public-fetch.mjs';

// The host supplies an existing exact-payload Consent; this client never grants it.
export function createAssistanceClient({ endpoint, sessions, send = postPublicJson, read = fetchAssistanceJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Assistance client configuration.');
  const pending = new WeakMap();
  async function authorize(signal) {
    signal?.throwIfAborted();
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization?.scopes.includes('assistance')) throw new Error('Assistance authorization required.');
    return authorization;
  }
  async function check(authorization, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(authorization) || !sessions.matchesAuthorization(authorization))
      throw new Error('Assistance authorization changed.');
    signal?.throwIfAborted();
  }
  function reject(authorization, error) {
    if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(authorization, 'remote-rejected');
    throw error;
  }
  function prepare({ consentId, payloadJson }) {
    z.uuid().parse(consentId);
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 16000) throw new Error('Invalid Assistance payload.');
    const payload = JSON.parse(payloadJson);
    const isEvent = Object.hasOwn(payload, 'assistanceId');
    const data = (isEvent ? assistanceEnvelopeSchema : assistanceRequestSchema).parse(payload);
    const event = isEvent ? data.event : data;
    const assistanceId = isEvent ? data.assistanceId : data.id;
    const expectedVersion = isEvent ? event.expectedVersion + 1 : 1;
    const path = isEvent ? `/v1/assistance/${assistanceId}/events` : '/v1/assistance';
    const bodyJson = JSON.stringify({ consentId, payloadJson });
    const hash = createHash('sha256').update(bodyJson).digest('hex');
    const preview = Object.freeze({ endpoint, path, consentId, payloadJson, assistanceId, eventId: event.id,
      confirmation: `CONFIRM ASSISTANCE ${event.id} ${hash}` });
    pending.set(preview, { event, assistanceId, expectedVersion, bodyJson, state: 'prepared', controller: new AbortController() });
    return preview;
  }
  function cancel(preview) {
    const operation = pending.get(preview);
    if (!operation) throw new Error('Unknown Assistance preview.');
    operation.state = 'canceled'; operation.controller.abort();
  }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact Assistance confirmation required.');
    operation.state = 'executing';
    const { event, assistanceId, expectedVersion, controller } = operation;
    let authorization;
    try {
      authorization = await authorize(controller.signal);
      await check(authorization, controller.signal);
      const result = await send(endpoint + preview.path, { bodyJson: operation.bodyJson,
        credential: authorization.credential, signal: controller.signal });
      await check(authorization, controller.signal);
      if (!result || result.assistanceId !== assistanceId || result.eventId !== event.id || result.version !== expectedVersion)
        throw new Error('Assistance acknowledgement mismatch; check remote outcome.');
      operation.state = 'completed';
      return { assistanceId, eventId: result.eventId, version: result.version };
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = 'failed';
      if (authorization) reject(authorization, error);
      throw error;
    }
  }
  async function get(assistanceId, { signal } = {}) {
    z.uuid().parse(assistanceId);
    const authorization = await authorize(signal);
    try {
      await check(authorization, signal);
      const result = await read(`${endpoint}/v1/assistance/${assistanceId}`, { credential: authorization.credential, signal, maxBytes: 1048576 });
      await check(authorization, signal);
      if (!result || result.request?.id !== assistanceId || !Number.isInteger(result.version) || result.version < 1
        || !['requester', 'applicant', 'selected-provider'].includes(result.view) || !Array.isArray(result.offers)
        || result.contextAccessGranted !== false || result.paymentExecuted !== false || result.capabilityVerified !== false)
        throw new Error('Invalid Assistance response.');
      return { ...result, endpoint, source: 'endpoint-reported' };
    } catch (error) { reject(authorization, error); }
  }
  async function query(input = {}, { signal } = {}) {
    const options = assistanceQuerySchema.parse(input), authorization = await authorize(signal);
    try {
      await check(authorization, signal);
      const result = await send(`${endpoint}/v1/assistance/query`, { bodyJson: JSON.stringify(options),
        credential: authorization.credential, signal, maxBytes: 1048576 });
      await check(authorization, signal);
      if (!result || !Array.isArray(result.items) || result.items.length > options.limit
        || !(result.nextAfter === null || z.uuid().safeParse(result.nextAfter).success)
        || result.items.some(item => !z.uuid().safeParse(item.assistanceId).success || item.request?.id !== item.assistanceId
          || !Number.isInteger(item.version) || item.version < 1 || item.capabilityVerified !== false))
        throw new Error('Invalid Assistance query response.');
      return { ...result, endpoint, source: 'endpoint-reported' };
    } catch (error) { reject(authorization, error); }
  }
  async function receipt(input, { signal } = {}) {
    const query = assistanceReceiptSchema.parse(input), authorization = await authorize(signal);
    try {
      await check(authorization, signal);
      const result = await send(`${endpoint}/v1/assistance/events/receipt`, { bodyJson: JSON.stringify(query), credential: authorization.credential, signal, maxBytes: 4096 });
      await check(authorization, signal);
      if (!result || result.assistanceId !== query.assistanceId || result.eventId !== query.eventId || result.payloadHash !== query.payloadHash
        || !['absent', 'conflict', 'acknowledged'].includes(result.state)
        || result.state === 'acknowledged' && (!Number.isInteger(result.version) || result.version < 1 || !z.uuid().safeParse(result.consentId).success))
        throw new Error('Invalid Assistance receipt.');
      return result;
    } catch (error) { reject(authorization, error); }
  }
  async function requesterHistory(input = {}, { signal } = {}) {
    const options = requesterHistorySchema.parse(input), authorization = await authorize(signal);
    try {
      await check(authorization, signal);
      const result = await send(`${endpoint}/v1/requester-history/query`, { bodyJson: JSON.stringify(options), credential: authorization.credential, signal, maxBytes: 1048576 });
      await check(authorization, signal);
      if (!result || !Array.isArray(result.items) || result.items.length > options.limit || result.summaryScope !== 'visible-page-only'
        || !(result.nextAfter === null || z.uuid().safeParse(result.nextAfter).success)
        || result.subjectId !== (options.subjectId ?? authorization.subjectId)
        || result.items.some(item => !z.uuid().safeParse(item.assistanceId).success || !Array.isArray(item.facts)
          || item.capabilityVerified !== false || item.independentQualityRating !== false
          || item.factsSupported === 1 && (item.facts.length > 8 || !Number.isInteger(item.visibleFactCount) || item.visibleFactCount < item.facts.length
            || !(item.nextFactsAfter === null || item.facts.at(-1)?.eventId === item.nextFactsAfter)))) throw new Error('Invalid requester history response.');
      return { ...result, endpoint, source: 'endpoint-reported' };
    } catch (error) { reject(authorization, error); }
  }
  async function requesterHistoryFacts(input, { signal } = {}) {
    const options = requesterHistoryFactsSchema.parse(input), authorization = await authorize(signal);
    try {
      await check(authorization, signal);
      const result = await send(`${endpoint}/v1/requester-history/facts`, {bodyJson:JSON.stringify(options),credential:authorization.credential,signal,maxBytes:1048576});
      await check(authorization, signal);
      if (!result || result.assistanceId !== options.assistanceId || result.summaryScope !== 'visible-request-only'
        || !Array.isArray(result.facts) || result.facts.length > options.limit || result.capabilityVerified !== false || result.independentQualityRating !== false
        || !Number.isInteger(result.visibleFactCount) || result.visibleFactCount < result.facts.length
        || result.facts.some(fact => !z.uuid().safeParse(fact.eventId).success || fact.eventId === options.after)
        || !(result.nextAfter === null || result.facts.at(-1)?.eventId === result.nextAfter && z.uuid().safeParse(result.nextAfter).success))
        throw new Error('Invalid requester history facts response.');
      return { ...result, endpoint, source: 'endpoint-reported' };
    } catch (error) { reject(authorization, error); }
  }
  async function qualificationRequest(evaluate, input = {}, { signal } = {}) {
    const authorization = await authorize(signal), value = evaluate ? qualificationQuerySchema.parse(input) : {};
    try { await check(authorization, signal);
      const result = await send(`${endpoint}/v1/qualification/${evaluate ? 'evaluate' : 'policies'}`, { bodyJson: JSON.stringify(value), credential: authorization.credential, signal });
      await check(authorization, signal);
      if (evaluate ? result?.capabilityVerified !== false || typeof result.eligible !== 'boolean' : !Array.isArray(result?.policies)) throw new Error('Invalid qualification response.');
      return result;
    } catch (error) { reject(authorization, error); }
  }
  return Object.freeze({ prepare, execute, cancel, get, query, receipt, requesterHistory, requesterHistoryFacts,
    qualificationPolicies: (input, options) => qualificationRequest(false, input, options), evaluateQualification: (input, options) => qualificationRequest(true, input, options) });
}
