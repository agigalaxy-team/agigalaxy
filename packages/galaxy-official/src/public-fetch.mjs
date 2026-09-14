import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  try { return isIP(address) !== 0 && ipaddr.parse(address).range() === 'unicast'; }
  catch { return false; }
}

export function validatePublicUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
    || (url.port && url.port !== '443') || host.endsWith('.') || host === 'localhost'
    || host.endsWith('.localhost') || host.endsWith('.local')
    || (isIP(host) && !isPublicAddress(host))) throw new Error('Unsafe endpoint.');
  return url;
}

// Both read and confirmed-write clients use this single public-network gate.
export function fetchPublicJson(value, options = {}) {
  return publicJson(value, { ...options, credential: undefined, method: 'GET', status: 200 });
}

// Read-only, signed direct peering has a fixed route and no ambient credential.
export function postHubPeeringJson(value, { bodyJson, signal, timeoutMs = 5000, maxBytes = 65536 }) {
  if (validatePublicUrl(value).pathname !== '/v2/hubs/peering/exchange'
    || typeof bodyJson !== 'string' || Buffer.byteLength(bodyJson) > 32768)
    return Promise.reject(new Error('Invalid peering query.'));
  return publicJson(value, { method: 'POST', bodyJson, signal, timeoutMs, maxBytes });
}

// Explicit authenticated read: never reused for discovery or arbitrary paths.
export function fetchBindingJson(value, { credential, signal, timeoutMs = 5000, maxBytes = 65536 }) {
  const path = validatePublicUrl(value).pathname;
  if (!/^\/v1\/bindings\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(path)
    || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)
    || Buffer.from(credential, 'base64url').toString('base64url') !== credential)
    return Promise.reject(new Error('Invalid binding status request.'));
  return publicJson(value, { method: 'GET', credential, signal, timeoutMs, maxBytes });
}

export function postDeletionStatusJson(value, { bodyJson, signal, timeoutMs = 5000, maxBytes = 65536 }) {
  if(validatePublicUrl(value).pathname!=='/v1/deletion-requests/status'||typeof bodyJson!=='string'||Buffer.byteLength(bodyJson)>16384)
    return Promise.reject(new Error('Invalid deletion status request.'));
  return publicJson(value,{method:'POST',bodyJson,signal,timeoutMs,maxBytes});
}

export function postPublicJson(value, { bodyJson, credential, signal, timeoutMs = 5000, maxBytes = 65536 }) {
  if (typeof bodyJson !== 'string' || Buffer.byteLength(bodyJson) > 32768
    || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)
    || Buffer.from(credential, 'base64url').toString('base64url') !== credential)
    return Promise.reject(new Error('Invalid confirmed request.'));
  return publicJson(value, { method: 'POST', bodyJson, credential, signal, timeoutMs, maxBytes });
}

// External A2A credentials are supplied by the host for this exact peer only.
// They are not Galaxy session credentials and never accompany card discovery.
export function postA2aJson(value, { bodyJson, credential, signal, timeoutMs = 30000, maxBytes = 1048576 }) {
  if (typeof bodyJson !== 'string' || Buffer.byteLength(bodyJson) > 32768
    || (credential !== undefined && (typeof credential !== 'string' || !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(credential))))
    return Promise.reject(new Error('Invalid A2A request.'));
  return publicJson(value, { method: 'POST', bodyJson, credential, signal, timeoutMs, maxBytes, a2aVersion: '1.0' });
}

export function fetchCaseJson(value, { credential, signal, timeoutMs = 5000, maxBytes = 1048576 }) {
  if (!/^\/v1\/cases\/[0-9a-f-]{36}$/.test(validatePublicUrl(value).pathname)
    || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)
    || Buffer.from(credential, 'base64url').toString('base64url') !== credential)
    return Promise.reject(new Error('Invalid Case read request.'));
  return publicJson(value, { method: 'GET', credential, signal, timeoutMs, maxBytes });
}

export function fetchAssistanceJson(value, { credential, signal, timeoutMs = 5000, maxBytes = 1048576 }) {
  if (!/^\/v1\/assistance\/[0-9a-f-]{36}$/.test(validatePublicUrl(value).pathname)
    || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)
    || Buffer.from(credential, 'base64url').toString('base64url') !== credential)
    return Promise.reject(new Error('Invalid Assistance read request.'));
  return publicJson(value, { method: 'GET', credential, signal, timeoutMs, maxBytes });
}

export function fetchContextJson(value, { credential, signal, timeoutMs = 5000, maxBytes = 1048576 }) {
  if (!/^\/v1\/context-grants\/[0-9a-f-]{36}$/.test(validatePublicUrl(value).pathname)
    || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)
    || Buffer.from(credential, 'base64url').toString('base64url') !== credential)
    return Promise.reject(new Error('Invalid Context read request.'));
  return publicJson(value, { method: 'GET', credential, signal, timeoutMs, maxBytes });
}

// Only the four fixed handshake routes may POST without an existing credential.
export function postConnectionJson(value, { bodyJson, signal, timeoutMs = 5000, maxBytes = 65536 }) {
  const path = validatePublicUrl(value).pathname;
  const statuses = { '/v1/binding-challenges': 201, '/v1/bindings': 200,
    '/v1/session-challenges': 201, '/v1/sessions': 200 };
  if (!Object.hasOwn(statuses, path) || typeof bodyJson !== 'string' || Buffer.byteLength(bodyJson) > 32768)
    return Promise.reject(new Error('Invalid connection request.'));
  return publicJson(value, { method: 'POST', bodyJson, signal, timeoutMs, maxBytes, status: statuses[path] });
}

// Resolve once, reject every nonpublic answer, then pin socket lookup. TLS still
// verifies the original hostname. No redirects, cookies, proxy env or retries.
async function publicJson(value, { method, bodyJson, credential, signal, timeoutMs = 5000, maxBytes = 65536, status = 200, a2aVersion }) {
  const url = validatePublicUrl(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576)
    throw new Error('Invalid request limits.');
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    let req;
    let ended = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = error => {
      if (ended) return;
      ended = true; cleanup(); req?.destroy(); reject(error);
    };
    const abort = () => fail(new Error('Request canceled.'));
    const timer = setTimeout(() => fail(new Error('Endpoint timeout; outcome may be unknown.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const start = async () => {
      try {
        const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
          : await lookup(hostname, { all: true, order: 'verbatim' });
        if (ended || signal?.aborted) { abort(); return; }
        if (!answers.length || answers.some(a => !isPublicAddress(a.address))) throw new Error('Unsafe DNS result.');
        const headers = { Accept: 'application/json', 'User-Agent': 'Galaxy-Official/0.1',
          ...(url.hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}) };
        if (method === 'POST') Object.assign(headers, { 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyJson) });
        if (credential) headers.Authorization = `Bearer ${credential}`;
        if (a2aVersion) headers['A2A-Version'] = a2aVersion;
        req = request(url, { method, agent: false, headers,
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, answers);
            else callback(null, answers[0].address, answers[0].family);
          } }, response => {
          if (response.statusCode !== status || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')
            || response.headers['content-encoding']) {
            const error = new Error('Invalid endpoint response.');
            if ([401, 403].includes(response.statusCode)) error.code = 'GALAXY_REMOTE_REJECTED';
            if (response.statusCode === 429) {
              error.code = 'GALAXY_RATE_LIMITED';
              const seconds = Number(response.headers['retry-after']);
              error.retryAfterSeconds = Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : 1;
            }
            response.destroy(); fail(error); return;
          }
          let size = 0; const chunks = [];
          response.on('data', chunk => {
            if (ended) return;
            size += chunk.length;
            if (size > maxBytes) { response.destroy(); fail(new Error('Endpoint response too large.')); }
            else chunks.push(chunk);
          });
          response.on('error', () => fail(new Error('Endpoint response interrupted.')));
          response.on('aborted', () => fail(new Error('Endpoint response interrupted.')));
          response.on('end', () => {
            if (ended) return;
            try {
              const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
              ended = true; cleanup(); resolve(result);
            } catch { fail(new Error('Invalid endpoint JSON.')); }
          });
        });
        req.on('error', () => fail(new Error('Endpoint request failed; outcome may be unknown.')));
        req.end(method === 'POST' ? bodyJson : undefined);
      } catch { fail(new Error('Public request rejected.')); }
    };
    void start();
  });
}
