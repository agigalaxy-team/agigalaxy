import {runtimeLogEvent} from '../src/operations/runtime-log.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

export async function verifyAdverseRequests(database = null, options = {}) {
  const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'evidence'], database, options), logs = [];
  const api = createApi({ ...f, logger: value => logs.push(value) });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + api.address().port;
  let requests = 0;
  async function post(path, payload, authenticated = false, headers = {}) {
    requests++;
    const response = await fetch(origin + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + f.credential } : {}), ...headers },
      body: typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  const counts = async () => Object.fromEntries(await Promise.all(['cases', 'case_events', 'evidence_submissions', 'verification_attempts', 'proofs', 'jobs'].map(async table =>
    [table, Number((await f.db.query('SELECT count(*) AS count FROM ' + table)).rows[0].count)])));
  try {
    const before = await counts(), marker = 'synthetic-untrusted-body-' + randomUUID();
    const webhook = { action: 'completed', workflow_run: { conclusion: 'success', id: 234, logs: marker } };
    const forged = { 'X-Hub-Signature-256': 'sha256=' + 'a'.repeat(64), 'X-GitHub-Event': 'workflow_run', 'X-GitHub-Delivery': randomUUID() };
    for (const path of ['/webhooks/github', '/v1/webhooks/github']) assert.equal((await post(path, webhook, false, forged)).status, 404);
    assert.equal((await post('/v1/evidence-submissions', webhook, false, forged)).status, 401);
    assert.equal((await post('/v1/evidence-submissions', webhook, true, forged)).status, 400);
    const sources = ['http://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/private', 'file:///private', 'https://public.example.org/redirect'];
    for (const url of sources) {
      const payload = { id: randomUUID(), caseId: randomUUID(), resultId: randomUUID(), source: { provider: 'github-actions', url } };
      assert.equal((await post('/v1/evidence-submissions', { consentId: randomUUID(), payloadJson: JSON.stringify(payload) }, true)).status, 400);
    }
    for (const [payload, headers, expected] of [
      ['{', {}, 400], ['[]', {}, 400], [Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]), {}, 400],
      ['x'.repeat(32769), {}, 413], ['{}', { 'Content-Encoding': 'gzip' }, 415],
      ['{}', { 'Content-Type': 'text/plain' }, 415],
      [{ consentId: randomUUID(), payloadJson: '{}', unexpected: marker }, {}, 400],
    ]) assert.equal((await post('/v1/evidence-submissions', payload, true, headers)).status, expected);
    assert.deepEqual(await counts(), before);
    assert.ok(!JSON.stringify(logs).includes(marker));assert.ok(!JSON.stringify(logs).includes(f.credential));
    assert.ok(logs.length > 0);
    for (const event of logs) {
      assert.ok(['http_rejected','http_completed'].includes(event.event));
      assert.equal(typeof event.requestId,'string');assert.equal(Number.isInteger(event.status),true);
      assert.deepEqual(event,runtimeLogEvent(event),'the production formatter remains a closed, idempotent metadata projection');
      for(const field of ['error','message','body','payload','credential','authorization'])assert.equal(Object.hasOwn(event,field),false);
    }
    // A normal signed request still commits after all rejected payloads.
    const root = { id: randomUUID(), kind: 'case', localRef: randomUUID(), title: 'Valid after rejected input', summary: 'Synthetic',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    assert.equal((await post('/v1/cases', await f.authorize(root), true)).status, 200);
    const after = await counts();assert.equal(after.cases, before.cases + 1);assert.equal(after.case_events, before.case_events + 1);
    for (const table of ['evidence_submissions', 'verification_attempts', 'proofs']) assert.equal(after[table], before[table]);
    return { httpRequests: requests, forgedWebhookRejected: true, arbitraryEvidenceUrlsRejected: true,
      malformedBodiesLeaveNoBusinessRows: true, normalSignedWriteSurvives: true, sanitizedLogs: true, webhookReceiverImplemented: false, syntheticOnly: true };
  } finally { api.closeAllConnections();await new Promise(resolve => api.close(resolve));if (!database) await f.db.close(); }
}
