import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createTaskClientV2 } from '../src/task-client-v2.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { digest } from '../src/shared/digest.mjs';
import { caseTaskLinkPayloadHash, legacyCaseTaskLinkPayloadHash } from '../src/shared/case-operation-hash.mjs';
import { factToolDefinitions } from '../src/adapters/mcp/personal/tools/facts-v2.mjs';

const id = () => randomUUID();
const scopes = ['binding', 'consent', 'case-teaser', 'assistance'];
function root(f, taskId) {
  const caseId = id();
  return { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0,
    actorId: f.actor.subjectId, ...(taskId ? { taskId } : {}), localRef: id(), title: 'Synthetic receipt test',
    summary: 'Private material must never return through a historical receipt',
    source: { kind: taskId ? 'active-task' : 'local', reference: taskId ?? id() }, synthetic: true };
}
const grant = (f, e) => f.authorize(e, 'case.teaser.publish', { objectId: e.eventId });

async function transport(f) {
  const api = createApi({ ...f, rateLimit: 1000 });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  let lostPath, writes = 0;
  const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
  sessions.adopt({ endpoint: f.access.endpoint, subjectId: f.actor.subjectId, bindingId: f.actor.bindingId,
    scopes, expiresAt: f.now + 500, bindingExpiresAt: f.now + 900, takeCredential: () => f.credential });
  const send = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/v2/cases/events' || path.endsWith('/case')) writes++;
    const response = await fetch(origin + path, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${options.credential}` }, body: options.bodyJson });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { code: result.error });
    if (lostPath === path) { lostPath = null; throw new Error('Synthetic lost ACK after real HTTP commit'); }
    return result;
  };
  return { client: createTaskClientV2({ endpoint: f.access.endpoint, sessions, send }),
    lose: path => { lostPath = path; }, writes: () => writes,
    close: async () => { sessions.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); } };
}

test('exact owned Case receipt survives lost ACK, revoked Consent and removed text without restoring access', async () => {
  const f = await serviceFixture(scopes), other = await serviceFixture(scopes, f.db, { migrateDatabase: false });
  const restricted = await serviceFixture(['binding'], f.db, { migrateDatabase: false }), http = await transport(f);
  try {
    const event = root(f), request = await grant(f, event), query = { caseId: event.caseId, eventId: event.eventId, payloadHash: digest(request.payloadJson) };
    http.lose('/v2/cases/events');
    await assert.rejects(http.client.submitCaseFact(request), /lost ACK/);
    await f.consents.revoke(f.actor, request.consentId);
    await assert.rejects(f.cases.submitV2(f.actor, request), error => error.code === 'consent_required');
    const receipt = await http.client.caseReceipt(query);
    assert.equal(receipt.state, 'acknowledged'); assert.equal(receipt.caseVersion, 1);
    assert.equal(receipt.currentAccessGranted, false); assert.equal(receipt.verification, 'not-provided');
    assert.equal(http.writes(), 1, 'receipt must not resubmit the original fact');
    assert.equal((await f.cases.getV2(f.actor, event.caseId)).coverage.complete, false);
    await f.db.query("UPDATE case_events SET payload='{}'::jsonb,payload_text='' WHERE id=$1", [event.eventId]);
    assert.deepEqual(await f.cases.receipt(f.actor, query), receipt);
    assert.equal(JSON.stringify(receipt).includes(event.summary), false);
    assert.equal(Object.hasOwn(receipt, 'objectRef'), false);
    assert.equal((await f.cases.receipt(f.actor, { ...query, payloadHash: '0'.repeat(64) })).state, 'conflict');
    assert.equal((await f.cases.receipt(f.actor, { ...query, caseId: id() })).state, 'conflict');
    assert.equal((await f.cases.receipt(other.actor, query)).state, 'absent');
    assert.equal((await f.cases.receipt(other.actor, { ...query, payloadHash: '0'.repeat(64) })).state, 'absent');
    await assert.rejects(f.cases.receipt(restricted.actor, query), error => error.code === 'access_denied');
    assert.throws(() => f.cases.receipt(f.actor, { ...query, payloadHash: 'invalid' }), error => error.code === 'invalid_case_receipt');
    const tool = factToolDefinitions(f, f.actor).galaxy_case_v2_receipt;
    assert.equal(tool.write, false); assert.equal((await tool.run(query)).state, 'acknowledged');
  } finally { await http.close(); await f.db.close(); }
});

test('atomic Task/Case link original receipt, legacy hash and rollback remain exact after permission withdrawal', async () => {
  const f = await serviceFixture(scopes), other = await serviceFixture(scopes, f.db, { migrateDatabase: false }), http = await transport(f);
  try {
    async function task() {
      const value = { operationId: id(), taskId: id(), caseId: null, intent: 'proactive-review', title: 'Synthetic proactive work', summary: 'No past failure',
        workContext: { goal: 'Review', currentSituation: 'Planning', attemptRefs: [] }, visibility: 'Private', collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 10000 };
      await f.assistance.createTask(f.actor, await f.authorize(value, 'assistance.publish', { objectId: value.operationId }));
      return value;
    }
    async function command(t, actorId = f.actor.subjectId) {
      const r = root(f, t.taskId), first = { schemaVersion: 2, kind: 'intervention', eventId: id(), caseId: r.caseId,
        taskId: t.taskId, actorId, expectedVersion: 1, types: ['scope-clarification'], affectsAttemptIds: [],
        description: 'First actual work', sourceRefs: [], observedEffect: 'Scope clarified' };
      return { operationId: id(), taskId: t.taskId, expectedTaskVersion: 1, case: await grant(f, r), initialFact: await grant(f, first) };
    }
    const t = await task(), input = await command(t), hash = caseTaskLinkPayloadHash(input);
    assert.equal(caseTaskLinkPayloadHash({ ...input, case: { ...input.case, consentId: id() }, initialFact: { ...input.initialFact, consentId: id() } }), hash,
      'authorization renewal does not change exact business fact bytes');
    http.lose(`/v2/tasks/${t.taskId}/case`);
    await assert.rejects(http.client.createTaskCaseLink(input), /lost ACK/);
    const query = { taskId: t.taskId, operationId: input.operationId, payloadHash: hash };
    await f.consents.revoke(f.actor, input.case.consentId);
    await f.consents.revoke(f.actor, input.initialFact.consentId);
    await assert.rejects(f.cases.createAndLinkTask(f.actor, input), error => error.code === 'consent_required');
    const receipt = await http.client.taskCaseLinkReceipt(query);
    assert.equal(receipt.state, 'acknowledged'); assert.equal(receipt.caseVersion, 2); assert.equal(receipt.taskVersion, 1); assert.equal(receipt.taskCaseLinkVersion, 1);
    assert.equal(receipt.currentAccessGranted, false); assert.equal(http.writes(), 1);
    assert.equal(Object.hasOwn(receipt, 'initialFact'), false); assert.equal(Object.hasOwn(receipt, 'payload'), false);
    assert.equal((await f.cases.taskLinkReceipt(other.actor, query)).state, 'absent');
    assert.equal((await f.cases.taskLinkReceipt(f.actor, { ...query, taskId: id() })).state, 'conflict');
    const legacyHash = legacyCaseTaskLinkPayloadHash(input);
    await f.db.query('UPDATE case_task_links SET payload_hash=$2 WHERE operation_id=$1', [input.operationId, legacyHash]);
    assert.equal((await http.client.taskCaseLinkReceipt({ ...query, payloadHash: legacyHash })).state, 'acknowledged');
    assert.equal((await http.client.taskCaseLinkReceipt(query)).state, 'conflict', 'old stored hash is never silently rewritten');
    const t2 = await task(), invalid = await command(t2, other.actor.subjectId);
    await assert.rejects(http.client.createTaskCaseLink(invalid), /actor_mismatch/);
    assert.equal((await f.cases.taskLinkReceipt(f.actor, { taskId: t2.taskId, operationId: invalid.operationId, payloadHash: caseTaskLinkPayloadHash(invalid) })).state, 'absent');
    assert.equal((await f.assistance.getTask(f.actor, t2.taskId)).caseId, null);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM cases WHERE id=$1', [JSON.parse(invalid.case.payloadJson).caseId])).rows[0].n, 0,
      'invalid initial work rolls back root, link and operation receipt together');
    const t3 = await task(), recoverable = await command(t3), stableHash = caseTaskLinkPayloadHash(recoverable);
    await f.consents.revoke(f.actor, recoverable.initialFact.consentId);
    await assert.rejects(http.client.createTaskCaseLink(recoverable), /consent_required/);
    const absent = { taskId: t3.taskId, operationId: recoverable.operationId, payloadHash: stableHash };
    assert.equal((await http.client.taskCaseLinkReceipt(absent)).state, 'absent');
    assert.equal((await f.assistance.getTask(f.actor, t3.taskId)).caseId, null);
    const renewed = { ...recoverable, initialFact: await grant(f, JSON.parse(recoverable.initialFact.payloadJson)) };
    assert.equal(caseTaskLinkPayloadHash(renewed), stableHash);
    assert.equal((await http.client.createTaskCaseLink(renewed)).operationId, recoverable.operationId);
    assert.equal((await http.client.taskCaseLinkReceipt(absent)).state, 'acknowledged');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM case_task_links WHERE operation_id=$1', [recoverable.operationId])).rows[0].n, 1);
  } finally { await http.close(); await f.db.close(); }
});
