
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

export async function verifyHistoryWorkflow(database=null,options={}) {
  const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'history'],database,options);
  const other = await serviceFixture(['binding', 'history'], f.db,{...options,migrateDatabase:false});
  const api = createApi(f);
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  try {
    const publish = async (event, audience) => {
      const request = await f.authorize(event, 'case.teaser.publish', audience);
      await f.cases.submit(f.actor, request); return request;
    };
    const makeCase = title => ({ kind: 'case', id: randomUUID(), localRef: randomUUID(), title, summary: 'compiler regression',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] });
    assert.deepEqual((await f.history.query(f.actor, { subjectId: f.actor.subjectId })).items, []);
    const publicGrant = { visibility: 'Public', purpose: 'public-profile' };
    const parent = makeCase('Public compiler failure');
    await publish(parent, publicGrant);
    const attempt = { kind: 'attempt', id: randomUUID(), caseId: parent.id, expectedVersion: 1, sequence: 1,
      approach: 'Try patch', configuration: { environment: 'Node', version: '24', tools: ['test'] } };
    await publish(attempt, publicGrant);
    const result = { kind: 'result', id: randomUUID(), caseId: parent.id, expectedVersion: 2, attemptId: attempt.id,
      outcome: 'failed', summary: 'Regression remained', failureReason: 'Mismatch', limitations: ['Synthetic case'] };
    const resultGrant = await publish(result, publicGrant);
    const revision = { kind: 'revision', id: randomUUID(), caseId: parent.id, expectedVersion: 3,
      correctsEventId: result.id, reason: 'Add detail', summary: 'Failure only on one platform' };
    await publish(revision, publicGrant);
    await publish(makeCase('Private hidden needle'));
    const shared = makeCase('Shared compiler report');
    await publish(shared, { visibility: 'Private', viewers: [other.actor.subjectId] });
    const owner = await f.history.query(f.actor, { subjectId: f.actor.subjectId, query: 'compiler' });
    assert.equal(owner.items.length, 3);
    const ownerCase = owner.items.find(item => item.caseId === parent.id);
    assert.equal(ownerCase.results[0].outcome, 'failed');
    assert.equal(ownerCase.results[0].corrected, true);
    assert.equal(ownerCase.corrections[0].correctsEventId, result.id);
    assert.equal(ownerCase.attempts[0].configuration.environment, 'Node');
    assert.equal(ownerCase.capabilityVerified, false);
    assert.equal(ownerCase.rebuild.rule.id,'case-history');
    assert.equal(ownerCase.rebuild.sourceVersion,4);
    assert.deepEqual(ownerCase.rebuild.sources.events.map(event=>event.id),[parent.id,attempt.id,result.id,revision.id]);
    const filtered = await f.history.query(f.actor, { subjectId: f.actor.subjectId,
      sourceKind: 'local', environment: 'node', createdFrom: '2000-01-01T00:00:00Z', createdBefore: '2100-01-01T00:00:00Z' });
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].caseId, parent.id);
    assert.ok(filtered.items[0].registeredAt);
    assert.equal((await f.history.query(f.actor, { subjectId: f.actor.subjectId, environment: 'Python' })).items.length, 0);
    assert.equal((await f.history.query(f.actor, { subjectId: f.actor.subjectId, sourceKind: 'hub' })).items.length, 0);
    assert.equal((await f.history.query(f.actor, { subjectId: f.actor.subjectId, createdBefore: '2000-01-01T00:00:00Z' })).items.length, 0);
    await assert.rejects(f.history.query(other.actor, { subjectId: f.actor.subjectId, environment: 'Node' }), /history_owner_filters_required/);
    await assert.rejects(f.history.query(null, { sourceKind: 'local' }), /history_owner_filters_required/);
    await assert.rejects(f.history.query(f.actor, { createdFrom: '2100-01-01T00:00:00Z', createdBefore: '2000-01-01T00:00:00Z' }), /invalid_history_query/);
    const failed = await f.history.query(null, { query: 'compiler', outcome: 'failed', limit: 1 });
    assert.equal(failed.items.length, 1);
    assert.ok(failed.items[0].matchReasons.includes('reported outcome: failed'));
    assert.equal((await f.history.query(f.actor, { outcome: 'succeeded' })).items.length, 0);
    assert.deepEqual(await f.history.query(f.actor, { subjectId: f.actor.subjectId, query: 'compiler' }), owner, 'replay is deterministic with same clock/source');
    const publicView = await f.history.query(null, { query: 'compiler' });
    assert.equal(publicView.items.length, 1);
    assert.equal(publicView.items[0].caseId, parent.id);
    assert.equal(publicView.items[0].participants, undefined);
    assert.equal(publicView.items[0].attempts[0].configuration, undefined);
    assert.equal(publicView.items[0].rebuild.view,'public');
    assert.ok(!JSON.stringify(publicView.items[0].rebuild).includes('Node'));
    assert.notEqual(publicView.items[0].rebuild.contentHash,ownerCase.rebuild.contentHash);
    assert.equal((await f.history.query(null, { query: 'hidden needle' })).items.length, 0);
    const authorized = await f.history.query(other.actor, { subjectId: f.actor.subjectId });
    assert.equal(authorized.items.length, 2);
    const first = await f.history.query(f.actor, { subjectId: f.actor.subjectId, limit: 1 });
    assert.ok(first.nextCursor);
    const second = await f.history.query(f.actor, { subjectId: f.actor.subjectId, limit: 1, after: first.nextCursor });
    assert.notEqual(first.items[0].caseId, second.items[0].caseId);
    const origin = `http://127.0.0.1:${api.address().port}`;
    const profile = await fetch(`${origin}/v1/profiles/${f.actor.subjectId}`);
    assert.equal(profile.status, 200); assert.equal((await profile.json()).view, 'public');
    const search = await fetch(origin + '/v1/history/query', { method: 'POST', headers: {
      Authorization: `Bearer ${f.credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Public compiler' }) });
    assert.equal(search.status, 200); assert.equal((await search.json()).items.length, 1);
    await f.consents.revoke(f.actor, resultGrant.consentId);
    assert.equal((await f.history.query(null, { query: 'Public compiler' })).items.length, 0);
    assert.equal((await f.history.query(f.actor, { query: 'Public compiler' })).items.length, 0);
    await assert.rejects(f.history.query(f.actor, { limit: 500 }), /invalid_history_query/);
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); if(!database)await f.db.close(); }
}
