import { ServiceError } from './shared/service-error.mjs';

const writerId = 'galaxy-management-account-maintenance';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const subject = value => typeof value === 'string' && !['.', '..'].includes(value) && /^[A-Za-z0-9._:@-]{1,255}$/.test(value);
const fail = (code, status = 503) => { throw new ServiceError(code, status); };
const allowedCodes = new Set([
  'management_identity_client_unavailable', 'management_identity_write_forbidden',
  'management_identity_not_found', 'management_identity_target_changed',
  'management_identity_write_failed', 'management_identity_submission_unknown',
  'management_email_verification_not_configured',
]);

/** Internal management realm only; configuration is injected from protected process memory. */
export function createManagementEmailChanges({ issuer, privateOrigin, writer = null,
  fetch: transport = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) }) {
  let authority, origin;
  try { authority = new URL(issuer); origin = new URL(privateOrigin); }
  catch { throw new Error('Invalid management email change configuration.'); }
  const realm = /^(.*)\/realms\/galaxy-operations$/.exec(authority.pathname);
  const clean = url => !url.username && !url.password && !url.search && !url.hash;
  if (!realm || authority.protocol !== 'https:' || !clean(authority) || !clean(origin)
    || !['/', ''].includes(origin.pathname) || origin.origin !== privateOrigin
    || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname))
    || writer !== null && (writer.clientId !== writerId || typeof writer.clientSecret !== 'string'
      || !writer.clientSecret || writer.clientSecret.length > 16384)) {
    throw new Error('Invalid management email change configuration.');
  }
  const nativeBase = origin.origin + authority.pathname + '/galaxy-management/';
  const tokenUrl = origin.origin + authority.pathname + '/protocol/openid-connect/token';
  const host = authority.host;
  let cachedToken;
  async function json(response) {
    const chunks = []; let size = 0;
    const stream = response.body?.getReader();
    if (!stream) fail('management_identity_response_invalid');
    try {
      for (;;) {
        const item = await stream.read(); if (item.done) break;
        size += item.value.byteLength;
        if (size > 65536) { await stream.cancel(); fail('management_identity_response_invalid'); }
        chunks.push(item.value);
      }
    } finally { stream.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('management_identity_response_invalid'); }
  }
  async function token() {
    if (!writer) fail('management_writer_not_configured');
    if (cachedToken?.expiresAt > now()) return cachedToken.value;
    let response;
    try {
      response = await transport(tokenUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { host, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: writer.clientId,
          client_secret: writer.clientSecret }).toString(),
      });
    } catch { fail('management_identity_client_unavailable'); }
    if (!response.ok) fail('management_identity_client_unavailable');
    const data = await json(response);
    if (typeof data?.access_token !== 'string' || !data.access_token || data.access_token.length > 32768
      || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 5) fail('management_identity_response_invalid');
    cachedToken = { value: data.access_token, expiresAt: now() + Math.min(data.expires_in - 5, 300) };
    return cachedToken.value;
  }
  async function available() {
    if (!writer) return false;
    try {
      const response = await transport(nativeBase + 'email-change-capabilities', {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { host, authorization: 'Bearer ' + await token(), accept: 'application/json' },
      });
      if (response.status === 401) cachedToken = null;
      if (!response.ok) return false;
      const data = await json(response);
      return data?.version === 1 && data.available === true && data.mode === 'native-update-email'
        && data.verificationBeforeChange === true && data.metadataOnly === true;
    } catch { return false; }
  }
  return Object.freeze({
    available,
    async request(principal, newEmail, { operationId, authorize } = {}) {
      if (principal?.issuer !== issuer || !subject(principal.externalSubject) || !uuid.test(operationId ?? '')
        || typeof newEmail !== 'string' || newEmail.length > 320 || !newEmail || newEmail.trim() !== newEmail
        || /[\u0000-\u001f\u007f]/.test(newEmail)) fail('invalid_management_accounts_request', 400);
      if (typeof authorize !== 'function') fail('operations_authorization_unavailable');
      if (!await available()) fail('management_email_verification_not_configured');
      const bearer = await token();
      await authorize(); // Fresh current human/target gate immediately before the one native POST.
      let response;
      try {
        response = await transport(nativeBase + 'users/' + encodeURIComponent(principal.externalSubject) + '/email-change', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { host, authorization: 'Bearer ' + bearer, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ operationId, newEmail }),
        });
      } catch { return { state: 'unknown', code: 'management_identity_submission_unknown' }; }
      if (response.status === 401) cachedToken = null;
      let data;
      try { data = await json(response); }
      catch { return { state: 'unknown', code: 'management_identity_response_invalid' }; }
      if (response.status === 202 && data?.version === 1 && data.operationId === operationId
        && data.metadataOnly === true && Number.isSafeInteger(data.expiresAt) && data.expiresAt > 0) {
        if (data.state === 'submitted' && data.code === null) return { state: 'submitted', code: null };
        if (data.state === 'unknown' && data.code === 'management_identity_submission_unknown')
          return { state: 'unknown', code: data.code };
      }
      if (response.status >= 500) return { state: 'unknown', code: 'management_identity_submission_unknown' };
      if ([400, 401, 403, 404, 409].includes(response.status)) return {
        state: 'failed', code: allowedCodes.has(data?.code) ? data.code
          : response.status === 403 ? 'management_identity_write_forbidden'
            : response.status === 401 ? 'management_identity_client_unavailable'
              : response.status === 404 ? 'management_identity_not_found' : 'management_identity_write_failed',
      };
      return { state: 'unknown', code: 'management_identity_response_invalid' };
    },
  });
}
