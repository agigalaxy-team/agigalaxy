import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import { moderationReportSchema, moderationEventSchema, moderationReceiptSchema, moderationReceiptResultSchema } from "../shared/moderation-schema.mjs";
import { postPublicJson, validatePublicUrl } from "../infrastructure/public-fetch.mjs";

// The host supplies an existing exact-payload Consent; this client never grants it.
export function createModerationClient({ endpoint, sessions, send = postPublicJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Moderation client configuration.');
  const pending = new WeakMap(), originals = new Map();
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
  function prepare({ consentId, payloadJson }, { subjectId = null, restoring = false, authorization = null } = {}) {
    z.uuid().parse(consentId);
    if (subjectId!==null) z.string().regex(/^GUID[0-9A-Z]{28}$/).parse(subjectId);
    if (restoring&&subjectId===null) throw new Error('Original Moderation owner required.');
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
    const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
    const previous = originals.get(event.id);
    if (previous) {
      const original = pending.get(previous);
      if (previous.payloadHash!==payloadHash || original.subjectId!==null&&subjectId!==null&&original.subjectId!==subjectId)
        throw new Error('Moderation operation conflicts with its original payload or owner.');
      if (['executing','unknown','conflict'].includes(original.state)) throw new Error('Reconcile the original Moderation operation before preparing again.');
      if (previous.consentId===consentId) return previous;
      if (original.state==='completed') throw new Error('Moderation operation already acknowledged.');
    }
    const preview = Object.freeze({ endpoint, path, consentId, payloadJson, reportId, eventId: event.id, payloadHash, expectedVersion,
      confirmation: `CONFIRM MODERATION ${event.id} ${hash}` });
    pending.set(preview, { event, reportId, expectedVersion, bodyJson, subjectId, authorization,dispatched:false,
      state: restoring?'unknown':'prepared', controller: new AbortController() });
    originals.set(event.id,preview);
    return preview;
  }
  function cancel(preview) {
    const operation = pending.get(preview);
    if (!operation) throw new Error('Unknown Moderation preview.');
    operation.state = operation.dispatched?'unknown':'canceled'; operation.controller.abort();
  }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || originals.get(preview.eventId)!==preview || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact Moderation confirmation required.');
    operation.state = 'executing';
    const { event, reportId, expectedVersion, controller } = operation;
    let authorization;
    try {
      authorization = operation.authorization??await authorize(controller.signal);
      if (operation.subjectId!==null&&operation.subjectId!==authorization.subjectId) throw new Error('Original Moderation owner required.');
      if(!authorization.scopes?.includes('moderation'))throw new Error('Moderation authorization required.');
      operation.subjectId=authorization.subjectId;
      await check(authorization, controller.signal);
      operation.dispatched=true;
      const result = await send(endpoint + preview.path, { bodyJson: operation.bodyJson,
        credential: authorization.credential, signal: controller.signal });
      await check(authorization, controller.signal);
      if (!result || result.reportId !== reportId || result.eventId !== event.id || result.version !== expectedVersion)
        throw new Error('Moderation acknowledgement mismatch; check remote outcome.');
      operation.state = 'completed';
      return { reportId, eventId: result.eventId, version: result.version };
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = operation.dispatched?'unknown':'prepared';
      if (authorization) reject(authorization, error);
      throw error;
    }
  }
  async function request(path, input = {}, { signal, subjectId } = {}) {
    const authorization = await authorize(signal);
    try { await check(authorization, signal);
      if (subjectId!==undefined&&authorization.subjectId!==subjectId) throw new Error('Original Moderation owner required.');
      const result = await send(endpoint + path, { bodyJson: JSON.stringify(input), credential: authorization.credential, signal, maxBytes: 1048576 });
      await check(authorization, signal); return result;
    } catch (error) { reject(authorization, error); }
  }
  async function get(id, options) {
    z.uuid().parse(id); const result = await request(`/v1/moderation/reports/${id}/read`, {}, options);
    if (result?.reportId !== id || !Number.isInteger(result.version) || !Array.isArray(result.events)) throw new Error('Invalid moderation response.');
    return result;
  }
  async function receipt(input,options) {
    const query=moderationReceiptSchema.parse(input);
    const result=moderationReceiptResultSchema.parse(await request(`/v1/moderation/reports/${query.reportId}/receipt`,
      {eventId:query.eventId,payloadHash:query.payloadHash},options));
    if (result.reportId!==query.reportId||result.eventId!==query.eventId||result.payloadHash!==query.payloadHash)
      throw new Error('Moderation receipt does not match the original operation.');
    return result;
  }
  function recoveryReference(preview) {
    const operation=pending.get(preview);if(!operation) throw new Error('Unknown Moderation preview.');
    if (!operation.subjectId) throw new Error('Original Moderation owner required.');
    return Object.freeze({endpoint,subjectId:operation.subjectId,reportId:preview.reportId,eventId:preview.eventId,
      payloadHash:preview.payloadHash,expectedVersion:preview.expectedVersion});
  }
  async function recover(reference,options={}) {
    const ref=z.strictObject({...moderationReceiptSchema.shape,endpoint:z.literal(endpoint),
      subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/),expectedVersion:z.number().int().positive().max(100)}).parse(reference);
    const result=await receipt({reportId:ref.reportId,eventId:ref.eventId,payloadHash:ref.payloadHash},{...options,subjectId:ref.subjectId});
    if(result.state==='acknowledged'&&result.receipt.version!==ref.expectedVersion) throw new Error('Moderation receipt version conflicts with the original operation.');
    const preview=originals.get(ref.eventId),operation=preview&&pending.get(preview);
    if(operation&&preview.reportId===ref.reportId&&preview.payloadHash===ref.payloadHash&&operation.subjectId===ref.subjectId&&operation.state!=='executing'){
      if(result.state==='acknowledged') operation.state='completed';
      else if(result.state==='conflict') operation.state='conflict';
      else if(operation.state==='unknown') {operation.state='prepared';operation.dispatched=false;operation.controller=new AbortController();}
    }
    return result;
  }
  async function reconcile(preview,options) {
    const operation=pending.get(preview);if(!operation) throw new Error('Unknown Moderation preview.');
    if(operation.state==='executing') throw new Error('Moderation operation is still executing.');
    const result=await recover(recoveryReference(preview),options);
    if(result.state==='acknowledged') operation.state='completed';
    else if(result.state==='conflict') operation.state='conflict';
    else if(operation.state==='unknown') {operation.state='prepared';operation.dispatched=false;operation.controller=new AbortController();}
    return result;
  }
  return Object.freeze({ prepare, restore:input=>prepare(input,{subjectId:input.subjectId,restoring:true}), execute, cancel, get, receipt,reconcile,recover,recoveryReference,
    config: (input, options) => request('/v1/moderation/config', input, options),
    query: (input, options) => request('/v1/moderation/reports/query', input, options) });
}
