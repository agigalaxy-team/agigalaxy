const authenticatedRequests = new WeakMap();
const requestQuotas = new WeakMap();
const measuredBodyBytes = new WeakMap();
export const beginBodyMeasurement = request => measuredBodyBytes.set(request, 0);
export const consumedBodyBytes = request => measuredBodyBytes.get(request) ?? 0;
export const recordBodyBytes = (request,bytes) => measuredBodyBytes.set(request,(measuredBodyBytes.get(request)??0)+bytes);
export const bindRequestQuota = (request,quota) => requestQuotas.set(request,quota);
export const authenticatedRequestActor = request => authenticatedRequests.get(request) ?? null;

import { ServiceError } from '../../shared/service-error.mjs';
import { failureActor } from '../../shared/http-failure-context.mjs';

export async function body(request, keys, {maxBytes=32768}={}) {
  if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'])
    throw new ServiceError('unsupported_media_type', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (measuredBodyBytes.has(request)) measuredBodyBytes.set(request, size);
    if (size > maxBytes) throw new ServiceError('request_too_large', 413);
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ServiceError('invalid_json'); }
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || (keys && Object.keys(input).sort().join(',') !== [...keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join(','))) throw new ServiceError('invalid_request');
  return input;
}

export async function authenticate(request, access, scope = 'binding', optional = false) {
  const auth = request.headers.authorization;
  if (optional && auth === undefined) return null;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) throw new ServiceError('access_denied', 401);
  const actor = await access.authenticate(auth.slice(7), scope);
  await captureAuthenticatedRequest(request,actor,auth.slice(7));
  return actor;
}

// Shared HTTP accounting after the selected authentication adapter has verified
// its own credential format. This function never chooses or validates a token.
export async function captureAuthenticatedRequest(request,actor,token) {
  if (typeof actor?.subjectId === 'string' && /^GUID[0-9A-Z]{28}$/.test(actor.subjectId) && /^[0-9a-f-]{36}$/.test(actor.bindingId ?? ''))
    authenticatedRequests.set(request, Object.freeze(failureActor(actor)));
  const quota=requestQuotas.get(request);
  if(quota){requestQuotas.delete(request);await quota({subjectId:actor.subjectId,credential:token});}
}
