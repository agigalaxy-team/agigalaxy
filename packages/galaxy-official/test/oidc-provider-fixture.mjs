import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK } from 'jose';
import Provider from 'oidc-provider';

// A real, independent authorization server library, confined to a fresh local
// HTTP fixture. Only its test interaction route chooses a synthetic account.
export async function oidcProviderFixture(redirectUris, { extraClients = [], resources = [], introspectionClientId, emailVerified = false, profileClaims = null, roleClaims = null } = {}) {
  let provider, account = 'synthetic-oidc-subject';
  const failures = [], requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      requests.push({ method: request.method, path });
      if (path.startsWith('/interaction/')) {
        const details = await provider.interactionDetails(request, response);
        if (details.prompt.name === 'login') return provider.interactionFinished(request, response,
          { login: { accountId: account } }, { mergeWithLastSubmission: false });
        if (details.prompt.name === 'consent') {
          const grant = details.grantId ? await provider.Grant.find(details.grantId)
            : new provider.Grant({ accountId: details.session.accountId, clientId: details.params.client_id });
          if (details.prompt.details.missingOIDCScope) grant.addOIDCScope(details.prompt.details.missingOIDCScope.join(' '));
          for (const [resource, scopes] of Object.entries(details.prompt.details.missingResourceScopes ?? {})) grant.addResourceScope(resource, scopes.join(' '));
          const grantId = await grant.save();
          return provider.interactionFinished(request, response, { consent: { grantId } }, { mergeWithLastSubmission: true });
        }
        throw new Error('Unsupported synthetic interaction.');
      }
      return provider.callback()(request, response);
    })().catch(error => { failures.push(error.name); response.statusCode = 500; response.end('synthetic-issuer-failed'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  try {
    const pair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const jwk = { ...await exportJWK(pair.privateKey), kid: 'synthetic-oidc', use: 'sig', alg: 'RS256' };
    provider = new Provider(issuer, { clients: [{ client_id: 'galaxy-fixture', redirect_uris: redirectUris,
      response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }, ...extraClients],
      jwks: { keys: [jwk] }, cookies: { keys: [randomBytes(32).toString('base64url')] },
      features: { devInteractions: { enabled: false },
        ...(introspectionClientId ? { introspection: { enabled: true, allowedPolicy: (_ctx,client) => client.clientId === introspectionClientId } } : {}),
        ...(resources.length ? { resourceIndicators: { enabled: true, getResourceServerInfo: (_ctx,resource) => {
          const selected=resources.find(item=>item.resource===resource);if(!selected)throw new Error('Unknown synthetic resource.');
          return {scope:selected.scope,audience:resource,accessTokenTTL:600,accessTokenFormat:'opaque'};
        } } } : {}),
      }, pkce: { required: () => true },
      interactions: { url: (_context, interaction) => `/interaction/${interaction.uid}` },
      conformIdTokenClaims: false,
      claims: { openid: ['sub'], email: ['email', 'email_verified', ...(profileClaims ? ['name', 'preferred_username'] : []),...(roleClaims?['realm_access','resource_access']:[])] },
      findAccount: async (_context, subject) => ({ accountId: subject, claims: async () => ({ sub: subject,
        email: 'synthetic@example.invalid', email_verified: emailVerified,
        ...(roleClaims?roleClaims:{}),
        ...(profileClaims ? {name: profileClaims.name, preferred_username: profileClaims.preferred_username} : {}) }) }),
    });
  } catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  async function authorize(authorizationUrl) {
    let url = new URL(authorizationUrl); const cookies = new Map();
    for (let i = 0; i < 12; i++) {
      if (url.origin !== issuer) {
        if (!redirectUris.some(value => url.origin + url.pathname === value)) throw new Error('Unexpected fixture redirect');
        return url;
      }
      const response = await fetch(url, { redirect: 'manual', headers: { Cookie: [...cookies.values()].join('; ') }, signal: AbortSignal.timeout(5000) });
      for (const value of response.headers.getSetCookie()) {
        const cookie = value.split(';', 1)[0]; cookies.set(cookie.split('=', 1)[0], cookie);
      }
      await response.arrayBuffer();
      const location = response.headers.get('location');
      if (!location || ![302, 303].includes(response.status)) throw new Error('Synthetic OIDC browser flow did not redirect.');
      url = new URL(location, url);
    }
    throw new Error('Synthetic OIDC redirect limit.');
  }
  return { issuer, authorize, requests, failures, setAccount: value => { account = value; },
    revokeToken:async token=>{const record=await provider.AccessToken.find(token);if(!record)throw new Error('Synthetic token not found.');await record.destroy();},
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
