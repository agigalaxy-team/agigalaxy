import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ServiceError } from '../../shared/service-error.mjs';

export function validateBrowserOrigins(origins = []) {
  if (!Array.isArray(origins) || origins.length > 16) throw new Error('Invalid browser origin policy.');
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Exact HTTPS browser origins required.');
  }
  return Object.freeze([...new Set(origins)]);
}
export async function loadBrowserPolicy(path) {
  if (!path) return { version: 1, origins: [] };
  if (!isAbsolute(path)) throw new Error('Absolute browser policy path required.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('Invalid browser policy file.');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'origins,version') throw new Error('Invalid browser policy.');
  return { version: 1, origins: validateBrowserOrigins(value.origins) };
}
export function applyBrowserPolicy(request, response, origins) {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  if (!origins.includes(origin)) throw new ServiceError('browser_origin_not_enabled', 403);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Origin', origin);
  const accountSession = /^\/v1\/account\/(session|logout)(?:\?|$)/.test(request.url);
  if (accountSession) response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Request-Id, X-Galaxy-Content-Sha256');
  // Galaxy operations retain explicit Bearer transport. Only the independent
  // official account session routes accept scoped ambient account cookies.
  if (request.method !== 'OPTIONS') return false;
  const method = request.headers['access-control-request-method'];
  const headers = (request.headers['access-control-request-headers'] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const upload=method==='PUT'&&/^\/v2\/chat\/attachments\/[0-9a-f-]{36}\/upload$/.test(request.url);
  if (!['GET', 'POST'].includes(method) && !upload || headers.some(header => !['authorization', 'content-type', 'accept', ...(accountSession ? ['x-galaxy-account-csrf'] : [])].includes(header)))
    throw new ServiceError('browser_preflight_denied', 403);
  response.setHeader('Access-Control-Allow-Methods', upload?'GET, POST, PUT':'GET, POST');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept' + (accountSession ? ', X-Galaxy-Account-CSRF' : ''));
  response.setHeader('Access-Control-Max-Age', '300');
  response.statusCode = 204; response.end(); return true;
}
