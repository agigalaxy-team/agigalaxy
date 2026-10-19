import { z } from 'zod';
import { postPublicJson, validatePublicUrl } from './public-fetch.mjs';
import { identityProviderSchema, identityIntentSchema, identityPageSchema } from './shared/identity-link-schema.mjs';
import { digest } from './shared/digest.mjs';

export function createIdentityLinkClient({ endpoint, sessions, sign, send = postPublicJson, now = () => Math.floor(Date.now()/1000) }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid identity client configuration.');
  const pending = new WeakMap(); let signingPayload = null;
  async function check(actor, signal) {
    signal?.throwIfAborted();
    if (!actor?.scopes.includes('binding') || !await sessions.isAuthorizationCurrent(actor) || !sessions.matchesAuthorization(actor)) throw new Error('Current Galaxy binding required.');
    signal?.throwIfAborted();
  }
  async function call(actor, method, input, signal) {
    await check(actor, signal);
    try {
      const result = await send(endpoint + '/v1/identity/' + method, { bodyJson: JSON.stringify(input), credential: actor.credential, signal });
      await check(actor, signal); return result;
    } catch (error) { if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(actor, 'remote-rejected'); throw error; }
  }
  function page(actor, result) {
    const value = identityPageSchema.parse(result);
    if (value.endpoint !== endpoint || value.subjectId !== actor.subjectId || value.items.some(item => item.subjectId !== actor.subjectId || item.endpoint !== endpoint))
      throw new Error('Identity list mismatch.');
    return value;
  }
  async function read(method, input = {}, { signal } = {}) {
    if (!['providers','begin','status','cancel','query'].includes(method)) throw new Error('Unsupported identity action.');
    const actor = await sessions.readAuthorization(endpoint);
    const result = await call(actor, method, input, signal);
    if (method === 'providers') {
      const value = z.strictObject({ endpoint: z.literal(endpoint), providers: z.array(identityProviderSchema).max(8), galaxyAuthorization: z.literal(false) }).parse(result);
      if (value.providers.some(provider => provider.redirectUri !== `${endpoint}/v1/identity/callback/${provider.id}`)) throw new Error('Identity callback mismatch.');
      return value;
    }
    if (method === 'begin') {
      const value = identityProviderSchema.extend({ loginId: z.uuid(), authorizationUrl: z.url(), expiresAt: z.number().int(),
        subjectId: z.literal(actor.subjectId), bindingId: z.literal(actor.bindingId), endpoint: z.literal(endpoint), galaxyAuthorization: z.literal(false) }).parse(result);
      const target = new URL(value.authorizationUrl);
      if (value.id !== input.providerId || value.redirectUri !== `${endpoint}/v1/identity/callback/${value.id}`
        || target.protocol !== 'https:' || target.username || target.password || target.hash || value.expiresAt <= now() || value.expiresAt > now() + 300
        || target.searchParams.get('redirect_uri') !== value.redirectUri || target.searchParams.get('client_id') !== value.clientId
        || !['openid','openid email'].includes(target.searchParams.get('scope')) || target.searchParams.get('response_type') !== 'code'
        || target.searchParams.get('code_challenge_method') !== 'S256' || !target.searchParams.get('state') || !target.searchParams.get('nonce'))
        throw new Error('OIDC login preview mismatch.');
      return value;
    }
    if (method === 'query') return page(actor, result);
    if (result?.id !== input.id || !['preparing','awaiting-login','exchanging','awaiting-local-signature','linked','revoked','failed','canceled'].includes(result.state))
      throw new Error('Identity login status mismatch.');
    return result;
  }
  async function prepare(action, input, { signal } = {}) {
    if (!['link','unlink'].includes(action)) throw new Error('Unsupported identity change.');
    const id = z.uuid().parse(input.id), actor = await sessions.readAuthorization(endpoint);
    let payloadJson, target;
    if (action === 'link') {
      const status = await call(actor, 'status', { id }, signal);
      if (status?.id !== id || !['awaiting-local-signature','linked'].includes(status.state) || typeof status.payloadJson !== 'string') throw new Error('Complete the external login first.');
      const intent = identityIntentSchema.parse(JSON.parse(status.payloadJson));
      if (JSON.stringify(status.intent) !== JSON.stringify(intent) || intent.id !== id || intent.subjectId !== actor.subjectId
        || intent.bindingId !== actor.bindingId || intent.endpoint !== endpoint || intent.expiresAt <= now() || intent.issuedAt > now())
        throw new Error('Identity association preview mismatch.');
      payloadJson = status.payloadJson; target = intent;
    } else {
      const result = page(actor, await call(actor, 'query', { id, limit: 1 }, signal));
      target = result.items[0]; if (!target || target.id !== id || target.state === 'revoked') throw new Error('Identity association unavailable.');
    }
    const previewJson = JSON.stringify({ action, endpoint, subjectId: actor.subjectId, target, galaxyAuthorization: false }, null, 2);
    const preview = Object.freeze({ id, action, previewJson, confirmation: `${action === 'link' ? 'LINK' : 'UNLINK'} ACCOUNT ${digest(previewJson)}` });
    pending.set(preview, { actor, payloadJson, target, state: 'prepared', controller: new AbortController() }); return preview;
  }
  function cancel(preview) { const operation = pending.get(preview); if (operation) { operation.state = 'canceled'; if (signingPayload === operation.payloadJson) signingPayload = null; operation.controller.abort(); } }
  async function execute(preview, confirmation) {
    const operation = pending.get(preview);
    if (!operation || operation.state !== 'prepared' || confirmation !== preview.confirmation) throw new Error('Exact identity association confirmation required.');
    operation.state = 'executing'; const { actor, controller, payloadJson } = operation;
    try {
      await check(actor, controller.signal);
      let signed;
      if (preview.action === 'link') {
        if (operation.target.expiresAt <= now() || typeof sign !== 'function') throw new Error('Identity signature unavailable or expired.');
        signingPayload = payloadJson;
        try { signed = await sign(payloadJson, 'galaxy-identity-link+jws'); } finally { signingPayload = null; }
      }
      const result = await call(actor, preview.action === 'link' ? 'confirm' : 'revoke', { id: preview.id, ...(signed ? { signed } : {}) }, controller.signal);
      if (result?.id !== preview.id || result.galaxyAuthorization !== false || result.state !== (preview.action === 'link' ? 'linked' : 'revoked'))
        throw new Error('Identity association outcome requires refresh.');
      operation.state = 'completed'; return result;
    } catch (error) { if (operation.state !== 'canceled') operation.state = 'failed'; throw error; }
  }
  return Object.freeze({ read, prepare, execute, cancel, isSigningPayload: payload => signingPayload !== null && payload === signingPayload });
}
