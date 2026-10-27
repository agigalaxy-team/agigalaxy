import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ServiceError } from '../../shared/service-error.mjs';
import {isAccountChatJsonPath,isAccountBinaryPath,isAccountUploadPath} from '../../shared/account-resource-routes.mjs';
import {accountFollowMethod} from '../../shared/account-follows-schema.mjs';

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
  const pathname=new URL(request.url,'https://galaxy.invalid').pathname;
  const operationsSession=pathname.startsWith('/v1/operations/');
  const discoverySession=/^\/v1\/discovery\/(?:config|events|recommendations|search)$/.test(pathname);
  const accountDataMethod=request.method==='OPTIONS'?request.headers['access-control-request-method']:request.method;
  const accountDataId='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const accountFeedbackData=accountDataMethod==='POST'&&/^\/v1\/account\/data\/feedback\/(?:export|delete)$/.test(pathname)
    ||accountDataMethod==='GET'&&new RegExp('^/v1/account/data/feedback/(?:operations|exports)/'+accountDataId+'$','i').test(pathname)
    ||accountDataMethod==='POST'&&new RegExp('^/v1/account/data/feedback/exports/'+accountDataId+'/attachments/'+accountDataId+'/content$','i').test(pathname);
  const accountSession = pathname==='/v1/web-events'||/^\/v1\/account\/(session|logout|settings|type-change|archives|work|external-credentials|bookmarks|chat-reports)(?:\/|\?|$)/.test(request.url)
    ||accountFeedbackData
    ||accountDataMethod==='POST'&&!!accountFollowMethod(pathname)
    || pathname==='/v1/account/feedback'
    || /^\/v1\/account\/feedback\/attachments\/(?:config|prepare|read|revoke)$/.test(pathname)
    || /^\/v1\/account\/notifications\/notices(?:\/[0-9a-f-]{36}\/read)?$/.test(pathname)
    || request.url.startsWith('/v2/community/')||isAccountChatJsonPath(pathname)||isAccountBinaryPath(pathname);
  if (accountSession||operationsSession||discoverySession) response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Request-Id, X-Galaxy-Content-Sha256, X-Galaxy-Event-Cursor');
  // Subject operations keep Bearer transport. Account cookies are accepted only
  // by their explicit account-capable routes, with exact actor/CSRF checks.
  if (request.method !== 'OPTIONS') return false;
  const method = request.headers['access-control-request-method'];
  const headers = (request.headers['access-control-request-headers'] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const accountHeader=accountSession||discoverySession||/^\/v2\/account-(?:archives|work|bookmarks)\//.test(request.url);
  const credentialDelete=method==='DELETE'&&/^\/v1\/account\/external-credentials\/[0-9a-f-]{36}$/.test(request.url);
  const upload=method==='PUT'&&isAccountUploadPath(pathname);
  if (!['GET', 'POST'].includes(method) && !upload && !credentialDelete || headers.some(header => !['authorization', 'content-type', 'accept', 'last-event-id', 'x-galaxy-user-activity', ...(accountHeader ? ['x-galaxy-account-id'] : []),...(accountSession||discoverySession ? ['x-galaxy-account-csrf'] : []),...(operationsSession?['x-galaxy-operator-csrf']:[]),...(discoverySession?['x-galaxy-discovery-csrf']:[])].includes(header)))
    throw new ServiceError('browser_preflight_denied', 403);
  response.setHeader('Access-Control-Allow-Methods', upload?'GET, POST, PUT':credentialDelete?'GET, POST, DELETE':'GET, POST');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Last-Event-ID, X-Galaxy-User-Activity' + (accountHeader ? ', X-Galaxy-Account-ID' : '')+(accountSession||discoverySession ? ', X-Galaxy-Account-CSRF' : '')+(operationsSession?', X-Galaxy-Operator-CSRF':'')+(discoverySession?', X-Galaxy-Discovery-CSRF':''));
  response.setHeader('Access-Control-Max-Age', '300');
  response.statusCode = 204; response.end(); return true;
}
