import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from '../src/http.mjs';

test('HTTP route contract preserves dispatch, scopes, exact payload and public Proof reads', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const calls = [];
  const authentication = [];
  const actor = { subjectId: 'synthetic-subject' };
  const service = (name, methods) => Object.fromEntries(methods.map(method => [method, async (...args) => {
    calls.push({ name: `${name}.${method}`, args }); return { fixture: `${name}.${method}` };
  }]));
  const bindings = { ...service('bindings', ['challenge', 'bind', 'get', 'revoke']), endpoint: 'http://127.0.0.1' };
  const access = { ...service('access', ['challenge', 'activate']), authenticate: async (token, scope) => {
    authentication.push({ token, scope }); return actor;
  } };
  const server = createApi({ bindings, access, rateLimit: 500,
    consents: service('consents', ['list', 'create', 'revoke']), cases: service('cases', ['get', 'submit']),
    evidence: service('evidence', ['get', 'submit']), proofs: service('proofs', ['get', 'preview', 'publish', 'revoke']) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  bindings.endpoint = `http://127.0.0.1:${server.address().port}`;
  const exact = '{ "kind" : "case", "note" : "signed bytes stay unchanged" }';
  const publication = { consentId: id, payloadJson: exact };
  // These expected API paths/statuses are the external contract, independent of
  // route discovery. A missing branch or scope change must fail the matrix.
  /** @type {Array<[string, string, Record<string, unknown> | null, number, string, string?]>} */
  const rows = [
    ['POST', '/v1/binding-challenges', { subjectId: 's', genesisProof: {}, installationId: id, scopes: [] }, 201, 'bindings.challenge'],
    ['POST', '/v1/bindings', { challenge: 'c', signature: 's', clientSession: 'session' }, 200, 'bindings.bind'],
    ['POST', '/v1/session-challenges', { bindingId: id, credentialHash: 'hash' }, 201, 'access.challenge'],
    ['POST', '/v1/sessions', { challenge: 'c', signature: 's' }, 200, 'access.activate'],
    ['GET', `/v1/bindings/${id}`, null, 200, 'bindings.get', 'binding'],
    ['POST', `/v1/bindings/${id}/revoke`, {}, 200, 'bindings.revoke', 'binding'],
    ['GET', '/v1/consents?after=cursor', null, 200, 'consents.list', 'consent'],
    ['POST', '/v1/consents', { signedIntent: 'signed' }, 200, 'consents.create', 'consent'],
    ['POST', `/v1/consents/${id}/revoke`, {}, 200, 'consents.revoke', 'consent'],
    ['POST', '/v1/cases', publication, 200, 'cases.submit', 'case-teaser'],
    ['POST', '/v1/case-events', { ...publication, payloadJson: '{"kind":"attempt"}' }, 200, 'cases.submit', 'case-teaser'],
    ['GET', `/v1/cases/${id}`, null, 200, 'cases.get', 'case-teaser'],
    ['POST', '/v1/evidence-submissions', publication, 202, 'evidence.submit', 'evidence'],
    ['GET', `/v1/verifications/${id}`, null, 200, 'evidence.get', 'evidence'],
    ['POST', '/v1/proof-previews', { id, evidenceId: id }, 200, 'proofs.preview', 'proof'],
    ['POST', '/v1/proofs', publication, 200, 'proofs.publish', 'proof'],
    ['POST', `/v1/proofs/${id}/revoke`, {}, 200, 'proofs.revoke', 'proof'],
    ['GET', `/v1/proofs/${id}`, null, 200, 'proofs.get'],
    ['GET', `/v1/proofs/${id}/status`, null, 200, 'proofs.get'],
  ];
  const send = (method, path, body, scope) => fetch(bindings.endpoint + path, { method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(scope ? { Authorization: 'Bearer synthetic' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    for (const [method, path, body, status, expected, scope] of rows) {
      calls.length = 0; authentication.length = 0;
      const response = await send(method, path, body, scope);
      assert.equal(response.status, status, `${method} ${path}`);
      assert.deepEqual(await response.json(), { fixture: expected });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, expected);
      assert.deepEqual(authentication, scope ? [{ token: 'synthetic', scope }] : []);
      if (body?.payloadJson) assert.equal(calls[0].args[1].payloadJson, body.payloadJson);
      if (expected === 'proofs.get') assert.deepEqual(calls[0].args, [null, id, path.endsWith('/status')]);
      if (expected === 'consents.list') assert.deepEqual(calls[0].args, [actor, 'cursor']);
      if (expected === 'bindings.revoke') {
        assert.equal(calls[0].args[1], actor.subjectId);
        assert.equal(calls[0].args[4], actor);
        assert.equal(calls[0].args[2], response.headers.get('x-request-id'));
      }
      if (scope) {
        calls.length = 0;
        const denied = await send(method, path, body);
        assert.equal(denied.status, 401, `missing credential ${path}`);
        assert.equal(calls.length, 0);
        await denied.arrayBuffer();
      }
    }
    for (const path of ['/v1/cases', '/v1/proofs', `/v1/proofs/${id}/status`]) {
      const response = await send('DELETE', path, null, 'fixture');
      assert.equal(response.status, 404); await response.arrayBuffer();
    }
    const mismatch = await send('POST', '/v1/case-events', publication, 'fixture');
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error, 'invalid_case_route');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
