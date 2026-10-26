import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import { capsuleEventSchema, capsuleUseSchema, capsuleReadSchema, capsuleQuerySchema, capsuleUsesQuerySchema } from "../shared/capsule-schema.mjs";
import { postPublicJson, validatePublicUrl } from "../infrastructure/public-fetch.mjs";

// The host supplies an existing exact-payload Consent; this client never grants it.
export function createCapsuleClient({ endpoint, sessions, send = postPublicJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Capsule client configuration.');
  const pending = new WeakMap();
  async function authorize(signal) {
    signal?.throwIfAborted();
    const authorization = await sessions.readAuthorization(endpoint);
    if (!authorization?.scopes.includes('capsules')) throw new Error('Capsule authorization required.');
    return authorization;
  }
  async function check(authorization, signal) {
    signal?.throwIfAborted();
    if (!await sessions.isAuthorizationCurrent(authorization) || !sessions.matchesAuthorization(authorization))
      throw new Error('Capsule authorization changed.');
    signal?.throwIfAborted();
  }
  function reject(authorization, error) {
    if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(authorization, 'remote-rejected');
    throw error;
  }
  function prepare({ consentId, payloadJson }) {
    z.uuid().parse(consentId);
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 16000) throw new Error('Invalid Capsule payload.');
    const payload = JSON.parse(payloadJson);
    const isUse = ['reference','apply','reverify'].includes(payload.kind);
    const data = (isUse ? capsuleUseSchema : capsuleEventSchema).parse(payload);
    const event = data;
    const capsuleId = data.capsuleId;
    const expectedVersion = isUse ? null : data.expectedRevision + 1;
    const path = isUse ? '/v1/capsules/uses' : '/v1/capsules/events';
    const bodyJson = JSON.stringify({ consentId, payloadJson });
    const hash = createHash('sha256').update(bodyJson).digest('hex');
    const preview = Object.freeze({ endpoint, path, consentId, payloadJson, capsuleId, eventId: event.id,
      confirmation: `CONFIRM CAPSULE ${event.id} ${hash}` });
    pending.set(preview, { event, capsuleId, expectedVersion, isUse, bodyJson, state: 'prepared', controller: new AbortController() });
    return preview;
  }
  function cancel(preview) {
    const operation = pending.get(preview);
    if (!operation) throw new Error('Unknown Capsule preview.');
    operation.state = 'canceled'; operation.controller.abort();
  }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation)
      throw new Error('Exact Capsule confirmation required.');
    operation.state = 'executing';
    const { event, capsuleId, expectedVersion, isUse, controller } = operation;
    let authorization;
    try {
      authorization = await authorize(controller.signal);
      await check(authorization, controller.signal);
      const result = await send(endpoint + preview.path, { bodyJson: operation.bodyJson,
        credential: authorization.credential, signal: controller.signal });
      await check(authorization, controller.signal);
      if (!result || result.capsuleId !== capsuleId || result.eventId !== event.id || (isUse ? result.kind !== event.kind : result.revision !== expectedVersion))
        throw new Error('Capsule acknowledgement mismatch; check remote outcome.');
      operation.state = 'completed';
      return { capsuleId, eventId: result.eventId, ...(isUse ? {kind: result.kind} : {revision: result.revision}) };
    } catch (error) {
      if (operation.state !== 'canceled') operation.state = 'failed';
      if (authorization) reject(authorization, error);
      throw error;
    }
  }
  async function request(path,input,{signal}={}) {const authorization=await authorize(signal);
    try{await check(authorization,signal);const result=await send(endpoint+path,{bodyJson:JSON.stringify(input),credential:authorization.credential,signal,maxBytes:1048576});await check(authorization,signal);return result;}
    catch(error){reject(authorization,error);}
  }
  async function get(input,options){const query=capsuleReadSchema.parse(input),result=await request('/v1/capsules/read',query,options);
    if(result?.capsuleId!==query.capsuleId||query.versionId&&result.versionId!==query.versionId||result.capabilityVerified!==false||!Array.isArray(result.versions))throw new Error('Invalid Capsule response.');return result;}
  async function query(input={},options){const data=capsuleQuerySchema.parse(input),result=await request('/v1/capsules/query',data,options);if(!Array.isArray(result?.items)||result.items.length>data.limit)throw new Error('Invalid Capsule query.');return result;}
  async function uses(input,options){const data=capsuleUsesQuerySchema.parse(input),result=await request('/v1/capsules/uses/query',data,options);if(!Array.isArray(result?.items)||result.readingIsReuse!==false)throw new Error('Invalid Capsule reuse response.');return result;}
  return Object.freeze({prepare,execute,cancel,get,query,uses});
}
