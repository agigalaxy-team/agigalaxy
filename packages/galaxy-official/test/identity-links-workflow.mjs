import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../src/oidc-login.mjs';
import { IdentityLinkService } from '../src/identity-links.mjs';
import { createApi } from '../src/http.mjs';
import { CommunityAccountRegistry } from '../src/community-accounts.mjs';
import { PublicWriteService } from '../src/public-writes.mjs';

export async function verifyIdentityLinks(database = null, options = {}) {
  const endpoint = 'https://official.example.org', now = Math.floor(Date.now() / 1000);
  const issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'],{emailVerified:true});
  let f, api;
  try {
    const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Synthetic OIDC', issuer: issuer.issuer,
      clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true,now:()=>now });
    f = await serviceFixture(['binding', 'data-export'], database, { ...options, now });
    const accountRegistry=new CommunityAccountRegistry(f.access,[provider]);
    const identity = new IdentityLinkService(f.access, [provider],{accountRegistry});
    const publicWrites=new PublicWriteService(f.access,accountRegistry);
    const failures = [];
    api = createApi({ ...f, identity, rateLimit: 200, failureAudit: async event => { failures.push(event); return 'stored'; } });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${api.address().port}`;
    const post = async (method, body, token = f.credential) => {
      const response = await fetch(origin + '/v1/identity/' + method, { method: 'POST', headers: {
        'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, value: await response.json() };
    };
    const login = async (token = f.credential) => {
      const result = await post('begin', { providerId: 'fixture' }, token); assert.equal(result.status, 200);
      const callback = await issuer.authorize(result.value.authorizationUrl);
      const response = await fetch(origin + callback.pathname + callback.search);
      assert.equal(response.status, 200); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const completed = await response.json(); assert.equal(completed.state, 'awaiting-local-signature');
      assert.ok(!JSON.stringify(completed).includes('synthetic-oidc-subject'));
      return result.value;
    };
    assert.equal((await post('providers', {}, null)).status, 401);
    assert.equal((await post('providers', {})).value.providers[0].pkce, 'S256');
    const started = await login(), id = started.loginId;
    assert.equal((await f.db.query('SELECT * FROM external_identity_links')).rows.length, 0, 'external login alone never associates an account');
    const pending = (await post('status', { id })).value;
    assert.equal(pending.intent.subjectId, f.actor.subjectId); assert.equal(pending.intent.externalSubject, 'synthetic-oidc-subject');
    const foreign = await serviceFixture(['binding', 'data-export'], f.db, { ...options, now, migrateDatabase: false });
    assert.equal((await post('status', { id }, foreign.credential)).status, 409);
    const input = { id, signed: await f.signForTest(pending.payloadJson, 'galaxy-identity-link+jws') };
    assert.equal((await post('confirm', { id, signed: await foreign.signForTest(pending.payloadJson, 'galaxy-identity-link+jws') })).status, 401);
    assert.equal((await post('confirm', { id, signed: await f.signForTest(pending.payloadJson + ' ', 'galaxy-identity-link+jws') })).status, 409);
    const confirmed = await post('confirm', input); assert.equal(confirmed.status, 200); assert.equal(confirmed.value.state, 'linked');
    assert.deepEqual((await post('confirm', input)).value, confirmed.value, 'exact retry resolves unknown acknowledgement');
    assert.equal((await post('status', { id })).value.state, 'linked', 'pending login reports the committed association accurately');
    assert.equal((await f.db.query('SELECT * FROM consents')).rows.length, 0);
    const stored = (await f.db.query('SELECT * FROM external_identity_links WHERE id=$1', [id])).rows[0];
    assert.equal(stored.payload_text, pending.payloadJson); assert.equal(stored.signature, input.signed);
    for (const field of ['access_token', 'refresh_token', 'id_token', 'code_verifier', 'cookie']) assert.ok(!JSON.stringify(stored).includes(field));
    const restarted = new IdentityLinkService(f.access, [provider]);
    assert.equal((await restarted.query(f.actor)).items[0].state, 'linked');
    assert.deepEqual(await restarted.confirm(f.actor, input), confirmed.value, 'durable acknowledgement survives service restart');
    await assert.rejects(restarted.status(f.actor, { id }), /unavailable/);
    assert.equal((await restarted.query(foreign.actor)).items.length, 0);
    const ticket = await f.dataExport.create(f.actor, { id: randomUUID(), datasets: ['external-identity-links'] });
    const exported = await f.dataExport.page(f.actor, { id: ticket.id, dataset: 'external-identity-links' });
    assert.equal(exported.items.length, 1); assert.equal(exported.items[0].external_subject, 'synthetic-oidc-subject');

    const competing = await login(foreign.credential), otherPending = (await post('status', { id: competing.loginId }, foreign.credential)).value;
    const otherInput = { id: competing.loginId, signed: await foreign.signForTest(otherPending.payloadJson, 'galaxy-identity-link+jws') };
    assert.equal((await post('confirm', otherInput, foreign.credential)).status, 200, 'separately controlled Galaxy IDs may link the same verified account');
    const ownQuota=await publicWrites.status(f.actor),otherQuota=await publicWrites.status(foreign.actor);
    assert.equal(ownQuota.accountId,otherQuota.accountId,'multiple signed Galaxy identities share one account quota group');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM community_accounts')).rows[0].n,1);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM community_account_links')).rows[0].n,2);
    assert.equal((await post('revoke', { id }, foreign.credential)).status, 404);
    assert.equal((await post('revoke', { id })).value.state, 'revoked');
    assert.equal((await post('status', { id })).value.state, 'revoked');
    assert.equal((await post('confirm', input)).value.state, 'revoked', 'replay never revives a revoked association');
    assert.equal((await post('confirm', otherInput, foreign.credential)).status, 200, 'unlinking the first identity does not undo the separately signed association');
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM external_identity_links')).rows[0].count, 2);
    assert.equal((await restarted.query(f.actor)).items[0].state, 'revoked');
    await foreign.bindings.revoke(foreign.actor.bindingId, foreign.actor.subjectId, randomUUID(), null, foreign.actor);
    assert.equal((await post('confirm', otherInput, foreign.credential)).status, 401, 'old Galaxy binding revocation wins immediately');

    const abandoned = (await post('begin', { providerId: 'fixture' })).value;
    const returned = await issuer.authorize(abandoned.authorizationUrl);
    assert.equal((await post('cancel', { id: abandoned.loginId })).value.state, 'canceled');
    assert.equal((await fetch(origin + returned.pathname + returned.search)).status, 409);
    const events = (await f.db.query("SELECT * FROM audit_events WHERE action IN ('identity.link','identity.unlink') ORDER BY sequence")).rows;
    assert.equal(events.length, 3);
    assert.ok(events.every(event => event.context_version === 1 && event.scope === 'binding' && event.consent_id === null && event.caller_binding_id));
    assert.ok(failures.some(event => event.route === 'GET /v1/identity/callback/:provider'));
    assert.ok(!JSON.stringify(failures).includes('code='));
    assert.deepEqual(issuer.failures, []);
    return { schema: 40, associations: 2, auditEvents: 3, oidcCodeFlow: true, localSignatureRequired: true,
      independentIssuer: true, httpRoutes: true, restart: true, ownerExport: true, sharedAccountQuota: true, noAutomaticGalaxyGrant: true };
  } finally {
    if (api) await new Promise(resolve => api.close(resolve));
    if (f && !database) await f.db.close();
    await issuer.close();
  }
}
