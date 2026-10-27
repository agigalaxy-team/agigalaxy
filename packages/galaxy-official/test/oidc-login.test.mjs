import test from 'node:test';
import assert from 'node:assert/strict';
import { createOidcLoginProvider } from "../src/identity/authentication/oidc-login.mjs";
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';

test('real OIDC issuer discovery, S256 code exchange and signed identity stay independent from Galaxy authorization', { timeout: 45000 }, async t => {
  const redirectUri = 'https://official.example.org/v1/identity/callback/fixture';
  const issuer = await oidcProviderFixture([redirectUri]); t.after(issuer.close);
  let clock = Math.floor(Date.now() / 1000), corruptSignature = false;
  const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Synthetic OIDC', issuer: issuer.issuer,
    clientId: 'galaxy-fixture', redirectUri, allowLoopbackHttp: true, now: () => clock,
    fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (corruptSignature && new URL(url).pathname === '/token' && response.status === 200) {
        const tokens = await response.json(); tokens.id_token = tokens.id_token.slice(0, -12) + 'AAAAAAAAAAAA';
        return new Response(JSON.stringify(tokens), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return response;
    },
  });
  await t.test('exact code flow returns only verified identity metadata and consumes its login once', async () => {
    const login = await provider.begin(), url = new URL(login.authorizationUrl);
    assert.equal(url.searchParams.get('scope'), 'openid email');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('nonce')); assert.ok(url.searchParams.get('state'));
    assert.ok(!JSON.stringify(login).includes('verifier'));
    const returned = await issuer.authorize(login.authorizationUrl);
    const identity = await provider.complete(login, returned);
    assert.equal(identity.externalSubject, 'synthetic-oidc-subject'); assert.equal(identity.issuer, issuer.issuer);
    assert.equal(identity.galaxyAuthorization, false);
    assert.equal(identity.accountVerification.verified, false, 'OIDC login alone does not prove verified email');
    assert.deepEqual(Object.keys(identity).sort(), ['accountVerification','authentication','clientId','expiresAt','externalSubject','galaxyAuthorization','issuedAt','issuer','providerId','verifiedAt','version'].sort());
    await assert.rejects(provider.complete(login, returned), /consumed/);
    assert.ok(issuer.requests.some(item => item.path === '/jwks'), 'SDK verifies ID Token signature using discovered keys');
  });
  await t.test('foreign callback path/state cannot consume another pending login', async () => {
    const first = await provider.begin(), second = await provider.begin();
    const returned = await issuer.authorize(first.authorizationUrl);
    const wrong = new URL(returned); wrong.pathname = '/wrong';
    await assert.rejects(provider.complete(first, wrong), /does not match/);
    await assert.rejects(provider.complete(second, returned), /does not match/);
    assert.equal((await provider.complete(first, returned)).externalSubject, 'synthetic-oidc-subject');
    provider.cancel(second);
  });
  await t.test('nonce mismatch, code challenge mismatch and a modified token signature fail at the SDK boundary', async () => {
    for (const kind of ['nonce', 'pkce', 'signature']) {
      const login = await provider.begin(), url = new URL(login.authorizationUrl);
      if (kind === 'nonce') url.searchParams.set('nonce', 'synthetic-different-nonce');
      if (kind === 'pkce') url.searchParams.set('code_challenge', 'a'.repeat(43));
      const returned = await issuer.authorize(url);
      corruptSignature = kind === 'signature';
      try { await assert.rejects(provider.complete(login, returned), /verification failed/); }
      finally { corruptSignature = false; }
      await assert.rejects(provider.complete(login, returned), /consumed/);
    }
  });
  await t.test('cancel and expiry do not produce an identity or begin another exchange', async () => {
    const canceled = await provider.begin(); provider.cancel(canceled);
    await assert.rejects(provider.complete(canceled, redirectUri), /canceled/);
    const expired = await provider.begin(); clock += 301;
    await assert.rejects(provider.complete(expired, redirectUri), /expired/);
  });
  assert.deepEqual(issuer.failures, []);
});

test('insecure issuer discovery is restricted to explicitly enabled loopback test instances', async () => {
  const options = { id: 'test', name: 'Test', clientId: 'client', redirectUri: 'https://official.example.org/callback' };
  for (const issuer of ['http://127.0.0.1:1', 'http://example.org', 'https://user:password@example.org'])
    await assert.rejects(createOidcLoginProvider({ ...options, issuer }), /HTTPS/);
  await assert.rejects(createOidcLoginProvider({ ...options, issuer: 'http://example.org', allowLoopbackHttp: true }), /HTTPS/);
});

test('signed OIDC profiles never turn an email login identifier into a default display name', {timeout: 45000}, async t => {
  const redirectUri = 'https://official.example.org/v1/account/callback';
  const profileClaims = {};
  const issuer = await oidcProviderFixture([redirectUri], {emailVerified: true, profileClaims});
  t.after(issuer.close);
  const provider = await createOidcLoginProvider({id: 'profile', name: 'Synthetic profile', issuer: issuer.issuer,
    clientId: 'galaxy-fixture', redirectUri, allowLoopbackHttp: true, includeAccountProfile: true});
  for (const item of [
    {name: '林舟', username: 'synthetic@example.invalid', expected: '林舟'},
    {name: undefined, username: 'galaxy-reader', expected: 'galaxy-reader'},
    {name: undefined, username: '@galaxy-reader', expected: '@galaxy-reader'},
    {name: undefined, username: 'synthetic@example.invalid', expected: null},
    {name: '   ', username: '  Synthetic@EXAMPLE.invalid  ', expected: null},
    {name: '', username: 'other@example.invalid', expected: null},
    {name: undefined, username: 'Reader <other@example.invalid>', expected: null},
    {name: undefined, username: 'synthetic＠example.invalid', expected: null},
    {name: undefined, username: undefined, expected: null},
  ]) {
    profileClaims.name = item.name;
    profileClaims.preferred_username = item.username;
    const login = await provider.begin();
    const identity = await provider.complete(login, await issuer.authorize(login.authorizationUrl));
    assert.equal(identity.accountProfile.displayName, item.expected);
    assert.equal(identity.accountProfile.email, 'synthetic@example.invalid');
    assert.equal(identity.externalSubject, 'synthetic-oidc-subject');
    assert.equal(identity.accountVerification.verified, true);
    assert.equal(identity.galaxyAuthorization, false);
  }
  assert.deepEqual(issuer.failures, []);
});

test('explicit management sign-in requests credentials without changing the default website SSO flow',async t=>{
 const redirectUri='https://admin.example/v1/operations/callback',issuer=await oidcProviderFixture([redirectUri]);t.after(issuer.close);
 const options={id:'management',name:'Management',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri,allowLoopbackHttp:true};
 const website=await createOidcLoginProvider(options),management=await createOidcLoginProvider({...options,requireFreshLogin:true});
 assert.equal(new URL((await website.begin()).authorizationUrl).searchParams.get('prompt'),null);
 const attempt=await management.begin();assert.equal(new URL(attempt.authorizationUrl).searchParams.get('prompt'),'login');
 assert.equal(new URL(attempt.authorizationUrl).searchParams.get('code_challenge_method'),'S256');
 const identity=await management.complete(attempt,await issuer.authorize(attempt.authorizationUrl));assert.equal(identity.externalSubject,'synthetic-oidc-subject');
});
