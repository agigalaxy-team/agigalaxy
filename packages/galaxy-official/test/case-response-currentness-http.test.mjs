import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { factToolDefinitions } from '../src/adapters/mcp/personal/tools/facts-v2.mjs';
import { digest } from '../src/shared/digest.mjs';

// Synthetic work only. The actual authenticated HTTP API, signed Consent,
// Task/Participation, Case, History and ordinary MCP consumer execute.
const scopes = ['binding', 'consent', 'case-teaser', 'assistance', 'history'];
async function fixture() {
  const owner = await serviceFixture(scopes);
  let api;
  try {
    const participants = [];
    for (let i = 0; i < 2; i++) participants.push(await serviceFixture(scopes, owner.db, { migrateDatabase: false }));
    api = createApi({ ...owner, rateLimit: 1000 });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${api.address().port}`, saved = [];
    const request = async (who, path, body) => {
      const response = await fetch(origin + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${who.credential}` }, body: JSON.stringify(body) });
      return { status: response.status, value: await response.json() };
    };
    const post = async (who, path, body) => {
      const result = await request(who, path, body);
      assert.equal(result.status, 200, JSON.stringify(result.value));
      return result.value;
    };
    const signed = (who, event, action, viewers) => who.authorize(event, action,
      { objectId: event.eventId ?? event.operationId, viewers });
    const publish = async (who, event, viewers = []) => {
      const grant = await signed(who, event, 'case.teaser.publish', viewers);
      await post(who, '/v2/cases/events', grant);
      saved.push({ event, grant });
      return grant;
    };
    const task = { operationId: randomUUID(), taskId: randomUUID(), caseId: null, intent: 'diagnosis',
      title: 'FICTIONAL current responses', summary: 'Isolated fixture only',
      workContext: { goal: 'Review current opinion scope', currentSituation: 'Synthetic work', attemptRefs: [] },
      visibility: 'Private', collaboration: 'open-assistance', enrollmentExpiresAt: owner.now + 1000 };
    const audience = participants.map(p => p.actor.subjectId);
    await post(owner, '/v2/tasks', await signed(owner, task, 'assistance.publish', audience));
    const caseId = randomUUID(), root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId,
      expectedVersion: 0, actorId: owner.actor.subjectId, taskId: task.taskId, localRef: randomUUID(),
      title: 'FICTIONAL response history', summary: 'No human acceptance or real work asserted',
      source: { kind: 'active-task', reference: task.taskId }, synthetic: true };
    const event = (who, kind, expectedVersion, extra) => ({ schemaVersion: 2, kind, eventId: randomUUID(),
      caseId, expectedVersion, actorId: who.actor.subjectId, taskId: task.taskId, ...extra });
    const first = event(owner, 'intervention', 1, { types: ['diagnosis'], affectsAttemptIds: [],
      description: 'FICTIONAL diagnosis', sourceRefs: [], observedEffect: 'Self-declaration only' });
    const rootGrant = await signed(owner, root, 'case.teaser.publish', audience);
    const firstGrant = await signed(owner, first, 'case.teaser.publish', audience);
    await post(owner, `/v2/tasks/${task.taskId}/case`, { operationId: randomUUID(), expectedTaskVersion: 1,
      case: rootGrant, initialFact: firstGrant });
    saved.push({ event: root, grant: rootGrant }, { event: first, grant: firstGrant });
    const participationIds = new Map(), proposalConsents = new Map();
    for (const p of participants) {
      const taskRow = (await owner.db.query('SELECT version FROM task_requests WHERE id=$1', [task.taskId])).rows[0];
      const proposal = { eventId: randomUUID(), expectedTaskVersion: taskRow.version, kind: 'propose',
        participationId: randomUUID(), subjectId: p.actor.subjectId, role: 'review', scopeVersion: 1,
        agreedScope: 'FICTIONAL bounded opinion' };
      const proposalGrant = await signed(owner, proposal, 'assistance.publish', [p.actor.subjectId]);
      await post(owner, `/v2/tasks/${task.taskId}/participations`, proposalGrant);
      const confirm = { eventId: randomUUID(), expectedParticipationVersion: 1, kind: 'confirm', scopeVersion: 1 };
      await post(p, `/v2/participations/${proposal.participationId}/events`, await signed(p, confirm, 'assistance.publish', [owner.actor.subjectId]));
      participationIds.set(p.actor.subjectId, proposal.participationId);
      proposalConsents.set(p.actor.subjectId, proposalGrant.consentId);
    }
    const nextEvent = async (who, kind, extra) => {
      const row = (await owner.db.query('SELECT version FROM cases WHERE id=$1', [caseId])).rows[0];
      return event(who, kind, row.version, extra);
    };
    const response = async (who, state, ref = { id: first.eventId, version: 1 }, viewers = [owner.actor.subjectId]) => {
      const e = await nextEvent(who, 'intervention-response', { interventionRef: ref, state,
        summary: `FICTIONAL ${state} ${randomUUID()}`,
        ...(who !== owner ? { participationId: participationIds.get(who.actor.subjectId) } : {}) });
      return { event: e, grant: await publish(who, e, viewers) };
    };
    const views = async () => {
      const viaHttp = await post(owner, `/v2/cases/${caseId}/read`, { taskId: task.taskId });
      const viaMcp = await factToolDefinitions(owner, owner.actor).galaxy_case_v2_read.run({ caseId, taskId: task.taskId });
      const history = await post(owner, '/v2/history/query', { subjectId: owner.actor.subjectId });
      const viaHistory = history.items.find(item => item.kind === 'case-history' && item.caseId === caseId);
      assert.ok(viaHistory);
      return [viaHttp, viaMcp, viaHistory];
    };
    const erase = e => owner.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1", [e.eventId]);
    const assertBytes = async (erased = []) => {
      for (const { event: e, grant } of saved) {
        const row = (await owner.db.query('SELECT payload_text,payload_hash FROM case_events WHERE id=$1', [e.eventId])).rows[0];
        assert.equal(row.payload_hash, digest(grant.payloadJson));
        assert.equal(row.payload_text, erased.includes(e.eventId) ? '' : grant.payloadJson);
      }
    };
    return { owner, participants, first, task, caseId, participationIds, proposalConsents, nextEvent, response, publish, signed,
      request, post, views, erase, assertBytes,
      close: async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await owner.db.close(); } };
  } catch (error) {
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await owner.db.close(); throw error;
  }
}
const intervention = (view, id, version = 1) => view.interventions.find(i => i.id === id && i.version === version);
async function assertCurrent(f, { id = f.first.eventId, version = 1, confirmation, actors, complete, hidden = [] }) {
  const before = (await f.owner.db.query('SELECT version FROM cases WHERE id=$1', [f.caseId])).rows[0].version;
  for (const view of await f.views()) {
    const current = intervention(view, id, version);
    assert.equal(current.confirmation, confirmation);
    assert.deepEqual(current.responses.map(r => r.actorId).sort(), actors.toSorted());
    assert.equal(current.responseCoverage?.complete, complete);
    for (const e of hidden) for (const privateValue of [e.eventId, e.summary]) assert.equal(JSON.stringify(view).includes(privateValue), false);
    assert.equal(current.capabilityVerified, false);
  }
  assert.equal((await f.owner.db.query('SELECT version FROM cases WHERE id=$1', [f.caseId])).rows[0].version, before,
    'read projections create no Case facts');
}

test('actual HTTP/MCP/History never revive earlier acceptance after private, revoked or body-erased latest response; explicit new opinion recovers', async () => {
  const f = await fixture(), p = f.participants[0];
  try {
    const earlier = await f.response(p, 'accepted');
    const newer = await f.response(p, 'disputed', undefined, []);
    await assertCurrent(f, { confirmation: 'unconfirmed', actors: [], complete: false, hidden: [newer.event] });
    for (const view of await f.views()) {
      assert.ok(view.responses.some(r => r.id === earlier.event.eventId && r.state === 'accepted'), 'authorized old opinion remains historical');
      assert.ok(view.events.some(e => (e.payload ?? e).eventId === earlier.event.eventId));
    }
    const author = await f.post(p, `/v2/cases/${f.caseId}/read`, { taskId: f.task.taskId });
    assert.equal(intervention(author, f.first.eventId).confirmation, 'disputed');
    await f.post(p, `/v1/consents/${newer.grant.consentId}/revoke`, {});
    await assertCurrent(f, { confirmation: 'unconfirmed', actors: [], complete: false, hidden: [newer.event] });
    await f.erase(newer.event);
    await assertCurrent(f, { confirmation: 'unconfirmed', actors: [], complete: false, hidden: [newer.event] });
    const latest = await f.response(p, 'partial');
    await assertCurrent(f, { confirmation: 'partially-confirmed', actors: [p.actor.subjectId], complete: true, hidden: [newer.event] });
    for (const view of await f.views()) assert.equal(intervention(view, f.first.eventId).responses[0].id, latest.event.eventId);
    await f.assertBytes([newer.event.eventId]);
  } finally { await f.close(); }
});

test('each participant and exact Intervention target stays independent; erased unknown target blocks only earlier opinions by that subject', async () => {
  const f = await fixture(), [p, q] = f.participants, ref = { id: f.first.eventId, version: 1 };
  try {
    await f.response(p, 'accepted');
    await f.response(q, 'partial');
    const second = await f.nextEvent(f.owner, 'intervention', { types: ['review'], affectsAttemptIds: [],
      description: 'FICTIONAL separate contribution', sourceRefs: [], observedEffect: 'Separate target' });
    await f.publish(f.owner, second, f.participants.map(who => who.actor.subjectId));
    const secondRef = { id: second.eventId, version: 1 };
    await f.response(p, 'accepted', secondRef);
    const hidden = await f.response(p, 'disputed', ref, []);
    await assertCurrent(f, { confirmation: 'partially-confirmed', actors: [q.actor.subjectId], complete: false, hidden: [hidden.event] });
    await assertCurrent(f, { id: second.eventId, confirmation: 'confirmed', actors: [p.actor.subjectId], complete: true });
    await f.erase(hidden.event);
    await assertCurrent(f, { confirmation: 'partially-confirmed', actors: [q.actor.subjectId], complete: false, hidden: [hidden.event] });
    await assertCurrent(f, { id: second.eventId, confirmation: 'unconfirmed', actors: [], complete: false, hidden: [hidden.event] });
    await f.response(q, 'accepted');
    await assertCurrent(f, { confirmation: 'confirmed', actors: [q.actor.subjectId], complete: false, hidden: [hidden.event] });
    await f.response(p, 'accepted', secondRef);
    await assertCurrent(f, { id: second.eventId, confirmation: 'confirmed', actors: [p.actor.subjectId], complete: true });
    await f.assertBytes([hidden.event.eventId]);
  } finally { await f.close(); }
});

test('same timestamp uses original Case order, self never confirms, and correction never inherits old-version opinions', async () => {
  const f = await fixture(), [p, q] = f.participants;
  try {
    await f.response(f.owner, 'accepted');
    await f.response(p, 'accepted');
    await f.response(p, 'disputed');
    await f.owner.db.query('UPDATE case_events SET created_at=$2 WHERE case_id=$1', [f.caseId, new Date(f.owner.now * 1000).toISOString()]);
    assert.equal((await f.owner.db.query('SELECT count(DISTINCT created_at)::int n FROM case_events WHERE case_id=$1', [f.caseId])).rows[0].n, 1);
    await assertCurrent(f, { confirmation: 'disputed', actors: [f.owner.actor.subjectId, p.actor.subjectId], complete: true });
    const privateLatest = await f.response(p, 'accepted', undefined, []);
    await assertCurrent(f, { confirmation: 'unconfirmed', actors: [f.owner.actor.subjectId], complete: false, hidden: [privateLatest.event] });
    const correction = await f.nextEvent(f.owner, 'intervention', { types: ['diagnosis'], affectsAttemptIds: [],
      description: 'FICTIONAL corrected scope', sourceRefs: [], observedEffect: 'New exact version',
      supersedes: { id: f.first.eventId, version: 1 } });
    await f.publish(f.owner, correction, f.participants.map(who => who.actor.subjectId));
    await assertCurrent(f, { version: 2, confirmation: 'unconfirmed', actors: [], complete: true, hidden: [privateLatest.event] });
    await f.response(f.owner, 'accepted', { id: f.first.eventId, version: 2 });
    await assertCurrent(f, { version: 2, confirmation: 'unconfirmed', actors: [f.owner.actor.subjectId], complete: true });
    await f.response(q, 'accepted', { id: f.first.eventId, version: 2 });
    await assertCurrent(f, { version: 2, confirmation: 'confirmed', actors: [f.owner.actor.subjectId, q.actor.subjectId], complete: true });
    await f.assertBytes();
  } finally { await f.close(); }
});

test('an actor only erased response keeps existing target coverage unknown, but never contaminates a later target and exact new response restores coverage', async () => {
  const f = await fixture(), [p, q] = f.participants;
  try {
    await f.response(q, 'partial');
    const only = await f.response(p, 'disputed', undefined, []);
    await assertCurrent(f, { confirmation: 'partially-confirmed', actors: [q.actor.subjectId], complete: false, hidden: [only.event] });
    await f.erase(only.event);
    await assertCurrent(f, { confirmation: 'partially-confirmed', actors: [q.actor.subjectId], complete: false, hidden: [only.event] });
    const later = await f.nextEvent(f.owner, 'intervention', { types: ['review'], affectsAttemptIds: [],
      description: 'FICTIONAL target created after unknown response', sourceRefs: [], observedEffect: 'Different exact target' });
    await f.publish(f.owner, later, f.participants.map(who => who.actor.subjectId));
    await f.owner.db.query('UPDATE case_events SET created_at=$2 WHERE case_id=$1', [f.caseId, new Date(f.owner.now * 1000).toISOString()]);
    await assertCurrent(f, { id: later.eventId, confirmation: 'unconfirmed', actors: [], complete: true, hidden: [only.event] });
    await f.response(p, 'accepted', { id: later.eventId, version: 1 });
    await assertCurrent(f, { id: later.eventId, confirmation: 'confirmed', actors: [p.actor.subjectId], complete: true, hidden: [only.event] });
    await assertCurrent(f, { confirmation: 'partially-confirmed', actors: [q.actor.subjectId], complete: false, hidden: [only.event] });
    await f.response(p, 'accepted');
    await assertCurrent(f, { confirmation: 'partially-confirmed', actors: [p.actor.subjectId, q.actor.subjectId], complete: true, hidden: [only.event] });
    await f.assertBytes([only.event.eventId]);
  } finally { await f.close(); }
});

test('withdrawn or revoked Participation blocks a new response without reviving older acceptance or deleting its lawful history', async () => {
  const f = await fixture(), p = f.participants[0];
  try {
    const earlier = await f.response(p, 'accepted');
    const hidden = await f.response(p, 'disputed', undefined, []);
    const candidate = await f.nextEvent(p, 'intervention-response', { participationId: f.participationIds.get(p.actor.subjectId),
      interventionRef: { id: f.first.eventId, version: 1 }, state: 'accepted', summary: 'FICTIONAL prepared before withdrawal' });
    const candidateGrant = await f.signed(p, candidate, 'case.teaser.publish', [f.owner.actor.subjectId]);
    const participationId = f.participationIds.get(p.actor.subjectId);
    const withdrawn = { eventId: randomUUID(), expectedParticipationVersion: 2, kind: 'withdraw', reason: 'FICTIONAL explicit exit' };
    await f.post(p, `/v2/participations/${participationId}/events`, await f.signed(p, withdrawn, 'assistance.publish', [f.owner.actor.subjectId]));
    const rejected = await f.request(p, '/v2/cases/events', candidateGrant);
    assert.equal(rejected.status, 403); assert.equal(rejected.value.error, 'participation_required');
    await assertCurrent(f, { confirmation: 'unconfirmed', actors: [], complete: false, hidden: [hidden.event] });
    const absent = await f.post(p, '/v2/cases/events/receipt', { caseId: f.caseId, eventId: candidate.eventId, payloadHash: digest(candidateGrant.payloadJson) });
    assert.equal(absent.state, 'absent');
    await f.post(f.owner, `/v1/consents/${f.proposalConsents.get(p.actor.subjectId)}/revoke`, {});
    const revoked = await f.request(p, '/v2/cases/events', candidateGrant);
    assert.equal(revoked.status, 403); assert.equal(revoked.value.error, 'consent_required');
    for (const view of await f.views()) assert.ok(view.responses.some(r => r.id === earlier.event.eventId));
    await assertCurrent(f, { confirmation: 'unconfirmed', actors: [], complete: false, hidden: [hidden.event] });
    await f.assertBytes();
  } finally { await f.close(); }
});
