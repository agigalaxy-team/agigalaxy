import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedFailureAudit, failureRoute } from '../src/adapters/http/failure-audit.mjs';
import { createHttpFailureAudit } from '../src/infrastructure/http-failure-audit.mjs';
import { createApi } from '../src/http.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { connect } from 'node:net';
import { once } from 'node:events';
import { verifyFailureAuthentication } from './failure-authentication-workflow.mjs';

test('HTTP failure authentication survives delayed delivery, scope changes and legacy queue upgrade',()=>verifyFailureAuthentication());

test('failure audit has bounded pending writes, no timeout retries and explicit failure outcomes', async () => {
  let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const record = boundedFailureAudit(() => { calls++; return calls === 1 ? blocked : undefined; }, { timeoutMs: 15, maxPending: 1 });
  const first = record({});
  assert.equal(await record({}), 'capacity');
  assert.equal(await first, 'unconfirmed');
  assert.equal(await record({}), 'capacity');
  assert.equal(calls, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await record({}), 'recorded');
  assert.equal(calls, 2);
  assert.equal(await boundedFailureAudit(() => { throw new Error('private'); })({}), 'failed');
  assert.throws(() => boundedFailureAudit(() => {}, { maxPending: 0 }), /Invalid audit bounds/);
});

test('HTTP failure records only fixed route and verified caller metadata, never request secrets', async () => {
  const f = await serviceFixture();
  const logs = [];
  const api = createApi({ ...f, cases: { submit: async () => { throw new Error('private-backend-detail'); } },
    failureAudit: createHttpFailureAudit(f.db, f.bindings.endpoint), logger: event => logs.push(event) });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${api.address().port}`;
    const post = (token, payload) => fetch(origin + '/v1/cases', { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
    const denied = await post(null, { privateKey: 'private-body-secret' });
    assert.equal(denied.status, 401); await denied.arrayBuffer();
    const failed = await post(f.credential, { consentId: 'fixture', payloadJson: JSON.stringify({ kind: 'case', privateKey: 'private-body-secret' }) });
    assert.equal(failed.status, 500); await failed.arrayBuffer();
    const unknown = await fetch(origin + '/private-path-secret?token=private-query-secret');
    assert.equal(unknown.status, 400); await unknown.arrayBuffer();
    const records = (await f.db.query("SELECT * FROM audit_events WHERE action IN ('http.rejected','http.failed') ORDER BY sequence")).rows;
    assert.equal(records.length, 3);
    assert.equal(records[0].object_id, 'POST /v1/cases');
    assert.equal(records[0].actor, 'http-request');
    assert.equal(records[0].caller_binding_id, null);
    assert.equal(records[1].actor, f.actor.subjectId);
    assert.equal(records[1].caller_binding_id, f.actor.bindingId);
    assert.equal(records[1].outcome, '500');
    assert.equal(records[1].http_request_id, failed.headers.get('x-request-id'));
    assert.equal(records[1].scope,'case-teaser');
    assert.deepEqual(records[1].credential_scopes,f.actor.scopes);
    assert.deepEqual(records[1].caller_binding_scopes,f.actor.scopes);
    assert.equal(records[2].object_id, 'http.request');
    for (const row of records) {
      assert.equal(row.context_version, 0, 'failure context is explicitly partial, not a grant');
      assert.equal(row.consent_id, null);
      assert.equal(row.binding_id, null);
      if(row!==records[1]){assert.equal(row.credential_scopes,null);assert.equal(row.scope,null);}
      assert.equal(row.idempotency_key, row.request_id);
    }
    assert.ok(logs.filter(entry=>entry.event==='http_rejected').every(entry => entry.auditStatus === 'recorded'));
    const serialized = JSON.stringify({ records, logs });
    for (const secret of ['private-body-secret', 'private-backend-detail', 'private-path-secret', 'private-query-secret', f.credential, f.actor.credentialHash])
      assert.ok(!serialized.includes(secret));
    assert.equal(failureRoute('POST', '/v1/proofs/11111111-1111-4111-8111-111111111111/revoke'), 'POST /v1/proofs/:id/revoke');
    assert.equal(failureRoute('DELETE', '/private-path-secret'), 'http.request');
    assert.equal((await f.db.query('SELECT * FROM case_events')).rows.length, 0);
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close(); }
});

test('failure audit storage error preserves denied response and reports recording failure without raw errors', async () => {
  const logs = [];
  const api = createApi({ bindings: { endpoint: 'https://fixture.example' }, failureAudit: boundedFailureAudit(() => {
    throw new Error('private-audit-storage-secret');
  }), logger: entry => logs.push(entry) });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${api.address().port}/unknown`);
    assert.equal(result.status, 404); await result.arrayBuffer();
    assert.equal(logs[0].auditStatus, 'failed');
    assert.ok(!JSON.stringify(logs).includes('private-audit-storage-secret'));
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
});

test('readiness failure, parser rejection and disconnected request have bounded nonsecret audit context', { timeout: 10000 }, async () => {
  const events = [];
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const api = createApi({ bindings: { endpoint: 'https://fixture.example' }, readiness: async () => false,
    failureAudit: async event => { events.push(event); return 'queued'; },
    access: { authenticate: async () => ({ subjectId: 'GUID' + 'A'.repeat(28), bindingId: '11111111-1111-4111-8111-111111111111' }) },
    cases: { submit: async () => { enter(); await held; return {}; } } });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const port = api.address().port;
  try {
    const unavailable = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(unavailable.status, 503); await unavailable.arrayBuffer();
    const broken = connect(port, '127.0.0.1');
    const rejected = once(broken, 'close'); broken.resume();
    await once(broken, 'connect'); broken.write('INVALID PRIVATE-PARSER-TOKEN\r\n\r\n'); await rejected;
    const interrupted = connect(port, '127.0.0.1');
    await once(interrupted, 'connect');
    const body = JSON.stringify({ consentId: 'fixture', payloadJson: JSON.stringify({ kind: 'case' }) });
    interrupted.write(`POST /v1/cases HTTP/1.1\r\nHost: fixture.example\r\nAuthorization: Bearer private-header-token\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await entered; interrupted.destroy();
    for (let i = 0; i < 50 && !events.some(event => event.status === 499); i++) await new Promise(resolve => setTimeout(resolve, 10));
    release();
    assert.deepEqual(events.map(event => [event.status, event.route]), [[503, 'GET /readyz'], [400, 'http.parser'], [499, 'POST /v1/cases']]);
    assert.equal(events[2].actor.subjectId, 'GUID' + 'A'.repeat(28));
    assert.equal(events[1].actor, null);
    assert.ok(!JSON.stringify(events).includes('private-header-token'));
    assert.ok(!JSON.stringify(events).includes('PRIVATE-PARSER-TOKEN'));
  } finally { release(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
});
