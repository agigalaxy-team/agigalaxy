import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createOidcTransactionStore} from '../src/oidc-transaction-store.mjs';
import {createOperationsPortal} from '../src/operations-auth.mjs';
import {createKeycloakAdminDirectory} from '../src/keycloak-admin-directory.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {endpoint, adminOrigin, operatorRoles, request, response, acceptCookies, temporaryDirectory} from './operations-management-fixture.mjs';

const callback = adminOrigin + '/v1/operations/callback';
const originated = jar => request(jar, {origin: adminOrigin});
const hasCode = code => error => error.code === code;

async function portal(db, issuer, now, roleDirectory, {namespace = 'operations-auth-fixture', transport = fetch} = {}) {
  const provider = await createOidcLoginProvider({
    id: 'operations-admin', name: 'Synthetic operations login', issuer: issuer.issuer,
    clientId: 'galaxy-fixture', redirectUri: callback, includeOperatorRoles: true, includeAccountProfile: true,
    allowLoopbackHttp: true, now, fetch: transport,
    transactionStore: createOidcTransactionStore({db, namespace, now}),
  });
  return createOperationsPortal({db, endpoint, adminOrigin, provider, now, roleDirectory, roles: operatorRoles});
}

async function begin(instance, jar, returnTo = '/admin') {
  const result = response();
  await instance.login(request(jar), result, new URL(adminOrigin + '/v1/operations/login?returnTo=' + encodeURIComponent(returnTo)));
  acceptCookies(jar, result);
  assert.equal(result.statusCode, 303);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  return result.headers.get('location');
}

async function finish(instance, jar, returned) {
  const result = response();
  await instance.callback(request(jar), result, new URL(returned));
  acceptCookies(jar, result);
  return result;
}

test('a verified operator login and its original target survive PG reopen and different portal instances', {timeout: 60000}, async t => {
  const directory = await temporaryDirectory(t, 'galaxy-operator-session-');
  let db = new PGlite(join(directory, 'postgres'));
  try {
    await migrate(db);
    const issuer = await oidcProviderFixture([callback], {
      emailVerified: true, profileClaims: {name: '维护者', preferred_username: 'operator'},
      roleClaims: {realm_access: {roles: [operatorRoles.administrator]}},
    });
    t.after(issuer.close);
    let clock = Math.floor(Date.now() / 1000), liveRoles = [operatorRoles.administrator];
    const now = () => clock, jar = new Map(), seenPrincipals = [];
    const directoryAuthority = {async getOperatorRoles(principal) {seenPrincipals.push(principal); return [...liveRoles];}};
    const first = await portal(db, issuer, now, directoryAuthority);
    const target = '/admin/collections/site-pages?where%5B_status%5D=published';
    const authorization = await begin(first, jar, target);
    const returned = await issuer.authorize(authorization);
    // The first relying party and private PKCE store no longer serve callback.
    await db.close(); db = new PGlite(join(directory, 'postgres'));
    const second = await portal(db, issuer, now, directoryAuthority);
    const completed = await finish(second, jar, returned);
    assert.equal(completed.headers.get('location'), adminOrigin + target);
    assert.equal(completed.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(completed.headers.get('set-cookie').every(cookie => /; HttpOnly; Secure; SameSite=Lax;/.test(cookie)));
    const session = await second.session(originated(jar));
    assert.equal(session.state, 'signed-in');
    assert.equal(session.operator.role, 'administrator');
    assert.equal(session.operator.displayName, '维护者');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM subjects')).rows[0].n, 0, 'operator login does not create a local Galaxy ID');
    const original = new Map(jar), originalExpiry = session.expiresAt;
    await db.close(); db = new PGlite(join(directory, 'postgres'));
    const third = await portal(db, issuer, now, directoryAuthority);
    const otherInstance = await portal(db, issuer, now, directoryAuthority);
    const resumed = await third.session(request(jar, {'sec-fetch-site': 'same-origin'}));
    assert.equal(resumed.operator.id, session.operator.id);
    assert.equal(resumed.expiresAt, originalExpiry, 'restarting does not prolong a session');
    assert.equal(resumed.csrfToken, session.csrfToken);
    const accountCookie = jar.get('__Host-galaxy-operator').replace('__Host-galaxy-operator=', '__Host-galaxy-account=');
    assert.equal((await third.session(originated(new Map([['__Host-galaxy-account', accountCookie]])))).state, 'signed-out',
      'a public account cookie name is not an operations session');
    const action = request(jar, {origin: adminOrigin, 'x-galaxy-operator-csrf': session.csrfToken}, 'POST');
    const actor = await third.authorizeOperator(action, {requestId: 'synthetic-request'});
    assert.deepEqual(actor, {kind: 'business-operator', operatorId: session.operator.id,
      role: 'administrator', endpoint, httpRequestId: 'synthetic-request'});
    await assert.rejects(third.authorizeOperator(request(jar, {origin: 'https://another.example.invalid',
      'x-galaxy-operator-csrf': session.csrfToken}, 'POST')), hasCode('operations_csrf_invalid'));
    await assert.rejects(third.authorizeOperator(request(jar, {origin: adminOrigin}, 'POST')), hasCode('operations_access_denied'));
    await assert.rejects(third.authorizeOperator(request(jar, {origin: adminOrigin,
      'x-galaxy-operator-csrf': randomBytes(32).toString('base64url')}, 'POST')), hasCode('operations_access_denied'));
    await assert.rejects(third.authorizeOperator({...action, headers: {...action.headers, authorization: 'Bearer synthetic-not-a-session'}}), hasCode('operations_access_denied'));
    liveRoles = [operatorRoles.reader];
    assert.equal((await third.session(originated(jar))).operator.role, 'reader', 'current role replaces the role saved at login');
    await assert.rejects(third.authorizeOperator(action), hasCode('operations_access_denied'));
    liveRoles = [];
    assert.equal((await third.session(originated(jar))).state, 'signed-out');
    liveRoles = [operatorRoles.administrator];
    assert.equal((await third.session(originated(original))).state, 'signed-out', 'restoring a role does not revive the revoked cookie');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_operator_sessions_v1')).rows[0].n, 0);
    assert.ok(seenPrincipals.every(principal => principal.issuer === issuer.issuer && principal.externalSubject === 'synthetic-oidc-subject'));
    await finish(third, jar, await issuer.authorize(await begin(third, jar, '/preview/help/')));
    const fresh = await third.session(originated(jar));
    const beforeLogout = new Map(jar), result = response();
    await third.logout(request(jar, {origin: adminOrigin, 'x-galaxy-operator-csrf': fresh.csrfToken}, 'POST'), result);
    acceptCookies(jar, result);
    assert.equal((await otherInstance.session(originated(beforeLogout))).state, 'signed-out');
    await finish(third, jar, await issuer.authorize(await begin(third, jar)));
    const expiring = await third.session(originated(jar));
    assert.equal(expiring.state, 'signed-in');
    clock = expiring.expiresAt + 1;
    assert.equal((await otherInstance.session(originated(jar))).state, 'signed-out', 'a live session ends at its original deadline');
    assert.deepEqual(issuer.failures, []);
  } finally {await db.close();}
});

test('role headers, unsigned cookies, foreign-client claims and stale callbacks cannot create an operator session', {timeout: 60000}, async t => {
  const db = new PGlite(); t.after(() => db.close()); await migrate(db);
  const claims = {realm_access: {roles: []}, resource_access: {'another-client': {roles: [operatorRoles.administrator]}}};
  const issuer = await oidcProviderFixture([callback], {roleClaims: claims}); t.after(issuer.close);
  const now = () => Math.floor(Date.now() / 1000), jar = new Map();
  let liveRoles = [operatorRoles.administrator];
  const directoryAuthority = {getOperatorRoles: async () => [...liveRoles]};
  const a = await portal(db, issuer, now, directoryAuthority), b = await portal(db, issuer, now, directoryAuthority);
  const deniedClaim = await finish(a, jar, await issuer.authorize(await begin(a, jar)));
  assert.match(deniedClaim.headers.get('location'), /reason=denied/);
  assert.equal((await a.session(originated(jar))).state, 'signed-out');
  claims.realm_access = {roles: [operatorRoles.administrator]};
  liveRoles = [];
  const removedRole = await finish(b, jar, await issuer.authorize(await begin(a, jar)));
  assert.match(removedRole.headers.get('location'), /reason=denied/);
  const forged = new Map([['__Host-galaxy-operator', '__Host-galaxy-operator=' + randomBytes(32).toString('base64url')]]);
  await assert.rejects(a.authorizeOperator(request(forged, {origin: adminOrigin, 'x-galaxy-operator-role': 'administrator'})), hasCode('operations_login_required'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_operator_sessions_v1')).rows[0].n, 0);
  liveRoles = [operatorRoles.reader]; claims.realm_access = {roles: [operatorRoles.reader]};
  const returned = await issuer.authorize(await begin(a, jar, '/admin/collections/site-pages'));
  const wrongState = new URL(returned); wrongState.searchParams.set('state', 'not-the-original-state');
  const stale = await finish(b, jar, wrongState);
  assert.match(stale.headers.get('location'), /reason=stale/);
  assert.equal(stale.headers.has('set-cookie'), false);
  const tokenCount = issuer.requests.filter(item => item.path === '/token').length;
  const results = await Promise.all([finish(a, new Map(jar), returned), finish(b, new Map(jar), returned)]);
  const success = results.find(result => result.headers.has('set-cookie'));
  assert.ok(success, 'one callback consumes the real authorization code');
  assert.equal(results.filter(result => result.headers.has('set-cookie')).length, 1);
  assert.equal(issuer.requests.filter(item => item.path === '/token').length - tokenCount, 1);
  acceptCookies(jar, success);
  const session = await a.session(originated(jar));
  assert.equal(session.operator.role, 'reader');
  await assert.rejects(b.authorizeOperator(request(jar, {origin: adminOrigin,
    'x-galaxy-operator-csrf': session.csrfToken, 'x-galaxy-operator-role': 'administrator'}, 'POST')), hasCode('operations_access_denied'));
  await assert.rejects(a.login(request(), response(), new URL(adminOrigin + '/v1/operations/login?returnTo=//outside.example.invalid/admin')), hasCode('operations_access_denied'));
  assert.deepEqual(issuer.failures, []);
});

test('the read-only Keycloak directory refreshes removed roles and fails closed instead of reusing stale permissions', async () => {
  const issuer = 'https://identity.example.invalid/realms/galaxy-operations';
  let clock = 1000, enabled = true, roles = [operatorRoles.administrator], unavailable = false, tokenCount = 0;
  const reads = [];
  const transport = async (input, options) => {
    const url = new URL(input), method = options.method ?? 'GET';
    if (url.pathname === '/realms/galaxy-operations/protocol/openid-connect/token') {
      assert.equal(method, 'POST');
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials');
      tokenCount++;
      return Response.json({access_token: 'fixture-only-directory-token', expires_in: 300});
    }
    assert.equal(method, 'GET', 'the directory has no user or role mutation calls');
    reads.push(url.pathname);
    assert.equal(options.redirect, 'error');
    if (unavailable) return new Response(null, {status: 503});
    if (url.pathname === '/admin/realms/galaxy-operations/users/operator') return Response.json({id: 'operator', enabled, email: 'synthetic@example.invalid', emailVerified: true});
    if (url.pathname === '/admin/realms/galaxy-operations/users/operator/role-mappings/realm/composite') return Response.json(roles.map(name => ({name})));
    throw Error('Unexpected synthetic directory request');
  };
  const directory = createKeycloakAdminDirectory({issuer, clientId: 'directory-fixture', clientSecret: 'fixture-only-not-a-live-secret', now: () => clock, fetch: transport});
  const principal = {issuer, externalSubject: 'operator'};
  assert.deepEqual(await directory.getOperatorRoles(principal), [operatorRoles.administrator]);
  const before = reads.length;
  assert.deepEqual(await directory.getOperatorRoles(principal), [operatorRoles.administrator]);
  assert.equal(reads.length, before, 'only the bounded current-role cache is reused');
  roles = []; clock += 16;
  assert.deepEqual(await directory.getOperatorRoles(principal), []);
  roles = [operatorRoles.reader]; clock += 16;
  assert.deepEqual(await directory.getOperatorRoles(principal), [operatorRoles.reader]);
  unavailable = true; clock += 16;
  await assert.rejects(directory.getOperatorRoles(principal), hasCode('operations_directory_unavailable'));
  unavailable = false; enabled = false;
  assert.deepEqual(await directory.getOperatorRoles(principal), []);
  assert.deepEqual(await directory.getOperatorRoles({issuer: 'https://another.example.invalid/realms/galaxy', externalSubject: 'operator'}), []);
  assert.equal(tokenCount, 1, 'permission refresh does not require a new service credential exchange each time');
});
