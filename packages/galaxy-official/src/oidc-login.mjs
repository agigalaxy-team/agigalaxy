import * as oidc from 'openid-client';
import { randomUUID } from 'node:crypto';

const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
function accountDisplayName(claims) {
  if (text(claims.name, 200) && claims.name.trim()) return claims.name;
  const username = text(claims.preferred_username, 200) ? claims.preferred_username : null;
  if (!username?.trim()) return null;
  const candidate = username.normalize('NFKC').trim();
  const email = typeof claims.email === 'string' ? claims.email.normalize('NFKC').trim() : '';
  // Email-as-username is a login identifier, not a public nickname. Leave the
  // profile unnamed rather than publishing an address as its default name.
  if (candidate.toLowerCase() === email.toLowerCase() || /[^\s@<>]+@[^\s@<>]+/u.test(candidate)) return null;
  return username;
}
function endpoint(value, allowLoopbackHttp) {
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || url.protocol !== 'https:' && !(allowLoopbackHttp && loopback))
    throw new Error('OIDC endpoint must use HTTPS.');
  return url;
}

// This is a relying-party login client. Token issuance, PKCE/code processing,
// discovery and ID Token verification belong to openid-client/the selected AS.
// The returned identity is not an API credential or a Galaxy authorization.
export async function createOidcLoginProvider({ id, name, issuer, clientId, redirectUri, clientSecret,
  allowedOrigins = [], includeAccountProfile = false, now = () => Math.floor(Date.now() / 1000), allowLoopbackHttp = false, fetch: transport = globalThis.fetch }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id ?? '') || !text(name, 100) || !text(clientId, 200)
    || clientSecret !== undefined && !text(clientSecret, 4096) || !Array.isArray(allowedOrigins) || allowedOrigins.length > 8)
    throw new Error('Invalid OIDC provider configuration.');
  const authority = endpoint(issuer, allowLoopbackHttp), callback = endpoint(redirectUri, allowLoopbackHttp);
  const origins = new Set([authority.origin, ...allowedOrigins.map(value => {
    const url = endpoint(value, allowLoopbackHttp);
    if (url.origin !== value) throw new Error('Exact OIDC transport origin required.');
    return value;
  })]);
  const checkedFetch = async (input, options) => {
    const target = new URL(input);
    if (target.username || target.password || target.hash || !origins.has(target.origin)) throw new Error('OIDC transport origin is not configured.');
    const response = await transport(input, { ...options, redirect: 'error',
      signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    const chunks = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 262144) { await reader.cancel(); throw new Error('OIDC response exceeds limit.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    return new Response(chunks.length ? Buffer.concat(chunks) : null, { status: response.status, headers: response.headers });
  };
  let configuration;
  try {
    configuration = await oidc.discovery(authority, clientId, { redirect_uris: [callback.href],
      response_types: ['code'], token_endpoint_auth_method: clientSecret === undefined ? 'none' : 'client_secret_basic' },
    clientSecret === undefined ? oidc.None() : oidc.ClientSecretBasic(clientSecret), {
      timeout: 5, [oidc.customFetch]: checkedFetch,
      // eslint-disable-next-line typescript/no-deprecated -- Explicit literal-loopback OIDC fixtures only; endpoint() rejects production HTTP.
      execute: [oidc.enableNonRepudiationChecks, ...(allowLoopbackHttp ? [oidc.allowInsecureRequests] : [])],
    });
    const metadata = configuration.serverMetadata();
    if (!metadata.code_challenge_methods_supported?.includes('S256') || !metadata.jwks_uri) throw new Error();
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      const url = endpoint(metadata[field], allowLoopbackHttp);
      if (!origins.has(url.origin)) throw new Error();
    }
  } catch { throw new Error('OIDC provider discovery failed.'); }
  const pending = new WeakMap();
  const description = Object.freeze({ id, name, issuer: configuration.serverMetadata().issuer, clientId,
    redirectUri: callback.href, protocol: 'openid-connect', grant: 'authorization_code', pkce: 'S256', loginLifetimeSeconds: 300 });
  async function begin() {
    const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
    const authorization = oidc.buildAuthorizationUrl(configuration, { redirect_uri: callback.href, scope: 'openid email',
      response_type: 'code', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
    const preview = Object.freeze({ ...description, loginId: randomUUID(), authorizationUrl: authorization.href, expiresAt: now() + 300 });
    pending.set(preview, { verifier, state, nonce });
    return preview;
  }
  async function complete(preview, returnedUrl) {
    const record = pending.get(preview);
    if (!record || preview.expiresAt <= now()) { pending.delete(preview); throw new Error('OIDC login is expired, canceled or consumed.'); }
    let returned;
    try {
      returned = new URL(returnedUrl);
      if (returned.origin !== callback.origin || returned.pathname !== callback.pathname || returned.hash || returned.username || returned.password
        || returned.searchParams.getAll('state').length !== 1 || returned.searchParams.get('state') !== record.state) throw new Error();
    } catch { throw new Error('OIDC callback does not match this login.'); }
    // Once a matching callback reaches code exchange, a failed/unknown exchange
    // requires a fresh login. Never retry a possibly consumed code implicitly.
    pending.delete(preview);
    try {
      const tokens = await oidc.authorizationCodeGrant(configuration, returned, { pkceCodeVerifier: record.verifier,
        expectedState: record.state, expectedNonce: record.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims || claims.iss !== description.issuer || !text(claims.sub, 255)
        || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= now()) throw new Error();
      return Object.freeze({ version: 1, providerId: id, issuer: claims.iss, externalSubject: claims.sub, clientId,
        accountVerification: Object.freeze({ method: 'email', verified: claims.email_verified === true }),
        ...(includeAccountProfile ? {accountProfile: Object.freeze({
          email: text(claims.email, 320) ? claims.email : null,
          displayName: accountDisplayName(claims),
        })} : {}),
        verifiedAt: now(), issuedAt: claims.iat, expiresAt: Math.min(claims.exp, preview.expiresAt),
        authentication: 'oidc-authorization-code-pkce-s256-id-token-signature', galaxyAuthorization: false });
    } catch { throw new Error('OIDC login verification failed.'); }
  }
  return Object.freeze({ describe: () => description, begin, complete, cancel: preview => pending.delete(preview) });
}
