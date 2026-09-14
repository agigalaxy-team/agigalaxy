import { body, authenticate } from './request.mjs';

export async function dispatchOutcomeMaterials({ materials, access, request, requestId, url, send }) {
  const match = /^\/v2\/outcome-materials\/(request|approve|control|read|query|source|inspect)$/.exec(url.pathname);
  if (!materials || request.method !== 'POST' || !match) return false;
  const method = match[1];
  const actor = { ...await authenticate(request, access, 'evidence'), httpRequestId: requestId };
  const input = await body(request, null);
  const result = await materials[method](actor, input);
  send(200, result);
  return true;
}
