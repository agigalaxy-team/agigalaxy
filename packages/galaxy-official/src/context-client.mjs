import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import { contextGrantSchema, contextAcceptanceSchema, contextReceiptSchema } from './shared/context-schema.mjs';
import { postPublicJson, fetchContextJson, validatePublicUrl } from './public-fetch.mjs';
export function createContextClient({ endpoint, sessions, send = postPublicJson, read = fetchContextJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Context configuration.');
  const pending = new WeakMap();
  async function authorization(signal) {
    signal?.throwIfAborted(); const actor = await sessions.readAuthorization(endpoint);
    if (!actor?.scopes.includes('context')) throw new Error('Context authorization required.'); return actor;
  }
  async function check(actor, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(actor) || !sessions.matchesAuthorization(actor)) throw new Error('Context authorization changed.');
    signal?.throwIfAborted();
  }
  function reject(actor, error) {
    if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(actor, 'remote-rejected'); throw error;
  }
  function prepare(input) {
    let path, grantId, eventId, bodyJson, expected;
    if (input.kind === 'revoke') {
      grantId = z.uuid().parse(input.grantId); path = `/v1/context-grants/${grantId}/revoke`; bodyJson = '{}'; expected = 'revoked';
    } else {
      z.uuid().parse(input.consentId);
      if (typeof input.payloadJson !== 'string' || Buffer.byteLength(input.payloadJson) > 16000) throw new Error('Invalid Context payload.');
      const data = JSON.parse(input.payloadJson), accept = Object.hasOwn(data, 'grantId');
      const payload = (accept ? contextAcceptanceSchema : contextGrantSchema).parse(data);
      grantId = accept ? payload.grantId : payload.id; eventId = accept ? payload.id : undefined;
      path = accept ? `/v1/context-grants/${grantId}/accept` : '/v1/context-grants'; expected = accept ? 'accepted' : 'recorded';
      bodyJson = JSON.stringify({ consentId: input.consentId, payloadJson: input.payloadJson });
    }
    const hash = createHash('sha256').update(JSON.stringify([endpoint, path, bodyJson])).digest('hex');
    const preview = Object.freeze({ endpoint, path, grantId, eventId, bodyJson, confirmation: `CONFIRM CONTEXT ${grantId} ${hash}` });
    pending.set(preview, { state: 'prepared', expected, controller: new AbortController() }); return preview;
  }
  function cancel(preview) { const op = pending.get(preview); if (!op) throw new Error('Unknown Context preview.'); op.state = 'canceled'; op.controller.abort(); }
  async function execute(preview, confirmation) {
    const op = pending.get(preview);
    if (!op || op.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact Context confirmation required.');
    op.state = 'executing'; let actor;
    try {
      actor = await authorization(op.controller.signal); await check(actor, op.controller.signal);
      const result = await send(endpoint + preview.path, { bodyJson: preview.bodyJson, credential: actor.credential, signal: op.controller.signal });
      await check(actor, op.controller.signal);
      if (!result || result.grantId !== preview.grantId || result.state !== op.expected || preview.eventId && result.eventId !== preview.eventId)
        throw new Error('Context acknowledgement mismatch; check remote outcome.');
      op.state = 'completed'; return result;
    } catch (error) { if (op.state !== 'canceled') op.state = 'failed'; if (actor) reject(actor, error); throw error; }
  }
  function valid(item) {
    return item && z.uuid().safeParse(item.grantId).success && item.id === item.grantId
      && ['pending', 'accepted'].includes(item.state) && /^[a-f0-9]{64}$/.test(item.materialsHash)
      && Array.isArray(item.materials) && item.materials.length >= 1 && item.materials.length <= 8 && item.capabilityVerified === false;
  }
  async function get(grantId, { signal } = {}) {
    z.uuid().parse(grantId); const actor = await authorization(signal);
    try {
      await check(actor, signal); const result = await read(`${endpoint}/v1/context-grants/${grantId}`, { credential: actor.credential, signal, maxBytes: 65536 });
      await check(actor, signal);
      if (!valid(result) || result.grantId !== grantId) throw new Error('Invalid Context response.');
      if (result.contextAccessGranted) {
        const materials = result.materials.map(({ id, label, mediaType, content }) => ({ id, label, mediaType, content }));
        if (materials.some(item => typeof item.content !== 'string')
          || createHash('sha256').update(JSON.stringify(materials)).digest('hex') !== result.materialsHash) throw new Error('Context material hash mismatch.');
      } else if (result.materials.some(item => Object.hasOwn(item, 'content'))) throw new Error('Unexpected Context body.');
      return { ...result, endpoint, source: 'endpoint-reported' };
    } catch (error) { reject(actor, error); }
  }
  async function query(assistanceId, { signal } = {}) {
    z.uuid().parse(assistanceId); const actor = await authorization(signal);
    try {
      await check(actor, signal); const result = await send(`${endpoint}/v1/context-grants/query`, { bodyJson: JSON.stringify({ assistanceId }), credential: actor.credential, signal, maxBytes: 1048576 });
      await check(actor, signal);
      if (!result || !Array.isArray(result.items) || result.items.length > 64 || result.items.some(item => !valid(item)
        || item.assistanceId !== assistanceId || item.materials.some(material => Object.hasOwn(material, 'content')))) throw new Error('Invalid Context list.');
      return { ...result, endpoint, source: 'endpoint-reported' };
    } catch (error) { reject(actor, error); }
  }
  async function receipt(input,{signal}={}){
    const query=contextReceiptSchema.parse(input),actor=await authorization(signal);
    try{
      await check(actor,signal);
      const result=await send(endpoint+'/v1/context-grants/receipt',{bodyJson:JSON.stringify(query),credential:actor.credential,signal,maxBytes:4096});
      await check(actor,signal);
      if(!result||result.kind!==query.kind||result.grantId!==query.grantId||result.eventId!==query.eventId||result.payloadHash!==query.payloadHash
        ||!['absent','acknowledged','conflict'].includes(result.state)||result.state==='acknowledged'&&!z.uuid().safeParse(result.consentId).success)
        throw new Error('Invalid Context receipt.');
      return result;
    }catch(error){reject(actor,error);}
  }
  return Object.freeze({ prepare, execute, cancel, get, query, receipt });
}
