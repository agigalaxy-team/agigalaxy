import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createManagementEmailChanges } from '../src/management-email-changes.mjs';

test('management email adapter binds the fixed native protocol and never retries uncertain mail', async () => {
  const issuer = 'https://admin.example.test/realms/galaxy-operations';
  const privateOrigin = 'http://127.0.0.1:18080';
  const writer = { clientId: 'galaxy-management-account-maintenance', clientSecret: 'synthetic-not-a-credential' };
  const principal = { issuer, externalSubject: '585afbea-9ae4-4b9e-9553-3f6837af963c' };
  const op = randomUUID(), calls = []; let authorized = 0, mode = 'submitted';
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const transport = async (url, options) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, method: options.method });
    assert.equal(parsed.origin, privateOrigin); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.host, 'admin.example.test');
    if (parsed.pathname.endsWith('/token')) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'client_credentials'); assert.equal(body.get('client_id'), writer.clientId);
      return reply({ access_token: 'synthetic-native-token', expires_in: 60 });
    }
    assert.equal(options.headers.authorization, 'Bearer synthetic-native-token');
    if (parsed.pathname.endsWith('/email-change-capabilities')) return reply({ version: 1, available: mode !== 'missing',
      mode: 'native-update-email', verificationBeforeChange: true, metadataOnly: true });
    assert.equal(parsed.pathname, '/realms/galaxy-operations/galaxy-management/users/' + principal.externalSubject + '/email-change');
    assert.equal(authorized, 1); assert.deepEqual(JSON.parse(options.body), { operationId: op, newEmail: 'new@example.test' });
    if (mode === 'network') throw Error('SMTP/TOKEN/PRIVATE-URL sentinel must not escape');
    if (mode === 'wrong-op') return reply({ version: 1, operationId: randomUUID(), state: 'submitted', code: null,
      expiresAt: 2000000000, metadataOnly: true, private: 'must not project' }, 202);
    if (mode === 'forbidden') return reply({ code: 'management_identity_write_forbidden', private: 'must not project' }, 403);
    if (mode === 'large') return new Response('x'.repeat(65537), { status: 202 });
    return reply({ version: 1, operationId: op, state: 'submitted', code: null, expiresAt: 2000000000,
      metadataOnly: true, newEmail: 'must not project' }, 202);
  };
  const adapter = createManagementEmailChanges({ issuer, privateOrigin, writer, fetch: transport });
  assert.equal(await adapter.available(), true);
  assert.deepEqual(await adapter.request(principal, 'new@example.test', { operationId: op, authorize: async () => { authorized++; } }),
    { state: 'submitted', code: null });
  const mails = () => calls.filter(v => v.method === 'POST' && v.path.endsWith('/email-change')).length;
  assert.equal(mails(), 1);
  mode = 'network'; authorized = 0;
  assert.deepEqual(await adapter.request(principal, 'new@example.test', { operationId: op, authorize: async () => { authorized++; } }),
    { state: 'unknown', code: 'management_identity_submission_unknown' });
  assert.equal(mails(), 2, 'one POST for this call; no network retry');
  mode = 'wrong-op'; authorized = 0;
  assert.deepEqual(await adapter.request(principal, 'new@example.test', { operationId: op, authorize: async () => { authorized++; } }),
    { state: 'unknown', code: 'management_identity_response_invalid' });
  mode = 'large'; authorized = 0;
  assert.deepEqual(await adapter.request(principal, 'new@example.test', { operationId: op, authorize: async () => { authorized++; } }),
    { state: 'unknown', code: 'management_identity_response_invalid' });
  mode = 'forbidden'; authorized = 0;
  assert.deepEqual(await adapter.request(principal, 'new@example.test', { operationId: op, authorize: async () => { authorized++; } }),
    { state: 'failed', code: 'management_identity_write_forbidden' });
  const count = mails();
  await assert.rejects(adapter.request(principal, 'new@example.test', { operationId: op, authorize: async () => { throw Error('current authority rejected'); } }));
  assert.equal(mails(), count, 'fresh authority refusal never reaches POST');
  await assert.rejects(adapter.request({ ...principal, issuer: issuer.replace('galaxy-operations', 'galaxy') }, 'new@example.test',
    { operationId: op, authorize: async () => {} }), { code: 'invalid_management_accounts_request' });
  await assert.rejects(adapter.request({ ...principal, externalSubject: '../users/other' }, 'new@example.test',
    { operationId: op, authorize: async () => {} }), { code: 'invalid_management_accounts_request' });
  mode = 'missing';
  assert.equal(await adapter.available(), false);
  await assert.rejects(adapter.request(principal, 'new@example.test', { operationId: op, authorize: async () => {} }),
    { code: 'management_email_verification_not_configured' });
  const unconfigured = createManagementEmailChanges({ issuer, privateOrigin, fetch: () => { throw Error('must not call'); } });
  assert.equal(await unconfigured.available(), false);
  assert.throws(() => createManagementEmailChanges({ issuer, privateOrigin: 'http://external.example.test', writer }));
  assert.throws(() => createManagementEmailChanges({ issuer, privateOrigin, writer: { ...writer, clientId: 'other-client' } }));
});
