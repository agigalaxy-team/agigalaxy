import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { CaseService } from '../src/cases.mjs';
import { createApi } from '../src/http.mjs';

test('authorized Case preserves ordered failures and corrections without asserting verification', async () => {
  const f = await serviceFixture();
  const cases = new CaseService(f.access, f.consents);
  const api = createApi({ ...f, cases });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${api.address().port}`;
    const initial = { kind: 'case', id: randomUUID(), localRef: 'synthetic-case-1', title: 'Synthetic regression',
      summary: 'Test fixture, not a real user case.', source: { kind: 'local', reference: 'synthetic-case-1' },
      participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    const request = await f.authorize(initial);
    const response = await fetch(origin + '/v1/cases', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${f.credential}` }, body: JSON.stringify(request) });
    assert.equal(response.status, 200);
    assert.equal((await cases.submit(f.actor, request)).version, 1);
    const audit = (await f.db.query("SELECT * FROM audit_events WHERE action='case.case' AND object_id=$1", [initial.id])).rows;
    assert.equal(audit.length, 1, 'idempotent resubmit does not duplicate audit');
    assert.equal(audit[0].context_version, 1);
    assert.match(audit[0].client_id, /^[0-9a-f-]{36}$/);
    assert.equal(audit[0].audience, f.bindings.endpoint);
    assert.equal(audit[0].scope, 'case-teaser');
    assert.deepEqual(audit[0].binding_scopes, f.actor.scopes);
    assert.deepEqual(audit[0].credential_scopes, f.actor.scopes);
    assert.equal(audit[0].consent_id, request.consentId);
    assert.equal(audit[0].binding_id, f.actor.bindingId);
    assert.equal(audit[0].http_request_id, response.headers.get('x-request-id'));
    assert.equal(audit[0].idempotency_key, initial.id);
    assert.ok(!JSON.stringify(audit).includes(f.credential));
    const duplicate = await f.authorize({ ...initial, id: randomUUID() });
    await assert.rejects(cases.submit(f.actor, duplicate), /conflict/);
    await assert.rejects(cases.submit(f.actor, await f.authorize({ ...initial, id: randomUUID(), localRef: 'bridge-alias',
      source: { ...initial.source, kind: 'bridge' } })), /conflict/);
    const attempt = { kind: 'attempt', id: randomUUID(), caseId: initial.id, expectedVersion: 1, sequence: 1,
      approach: 'Attempt with fixture config', configuration: { environment: 'isolated', version: '1', tools: ['test'] } };
    await cases.submit(f.actor, await f.authorize(attempt));
    await assert.rejects(cases.submit(f.actor, await f.authorize({ ...attempt, id: randomUUID() })), /version_conflict/);
    const result = { kind: 'result', id: randomUUID(), caseId: initial.id, expectedVersion: 2, attemptId: attempt.id,
      outcome: 'failed', summary: 'Regression persisted', failureReason: 'Fixture assertion failed', limitations: ['Synthetic only'] };
    await cases.submit(f.actor, await f.authorize(result));
    const revision = { kind: 'revision', id: randomUUID(), caseId: initial.id, expectedVersion: 3,
      correctsEventId: result.id, reason: 'Clarify failure', summary: 'Original failed result retained' };
    await cases.submit(f.actor, await f.authorize(revision));
    const read = await cases.get(f.actor, initial.id);
    assert.equal(read.verification, 'unverified');
    assert.equal(read.state, 'open');
    assert.deepEqual(read.events.map(event => event.kind), ['case', 'attempt', 'result', 'revision']);
    assert.equal(read.events[2].failureReason, result.failureReason);
    await assert.rejects(cases.get({ ...f.actor, subjectId: 'foreign' }, initial.id), /access_denied/);
    await assert.rejects(cases.submit(f.actor, { ...request, payloadJson: JSON.stringify({ ...initial, rawContext: 'forbidden' }) }), /invalid_case_payload/);
    await f.consents.revoke(f.actor, request.consentId);
    await assert.rejects(cases.get(f.actor, initial.id), /consent_required/);
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close(); }
});
