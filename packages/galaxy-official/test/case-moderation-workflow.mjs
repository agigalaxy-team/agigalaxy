import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createModerationClient } from '../src/moderation-client.mjs';
import { createModerationFlow } from '../src/moderation-flow.mjs';

export async function verifyCaseModerationWorkflow(db = null, options = {}) {
  const scopes = ['binding', 'consent', 'case-teaser', 'moderation', 'assistance', 'data-export'];
  const f = await serviceFixture(scopes, db, options), p = await serviceFixture(scopes, f.db, options),
    m = await serviceFixture(scopes, f.db, options), other = await serviceFixture(scopes, f.db, options);
  f.moderation.moderatorIds = [m.actor.subjectId];
  const api = createApi({ ...f, rateLimit: 600 }), sessions = [];
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, endpoint = f.bindings.endpoint;
  const send = async (url, input) => {
    const response = await fetch(origin+new URL(url).pathname, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.credential}` }, body: input.bodyJson, signal: input.signal });
    const result = await response.json();
    if (response.status !== 200) throw new Error(JSON.stringify(result));
    return result;
  };
  function host(who) {
    const memory = createSessionMemory({ now: () => f.now, isCurrent: async () => true }); sessions.push(memory);
    memory.adopt({ endpoint, subjectId: who.actor.subjectId, bindingId: who.actor.bindingId, scopes,
      expiresAt: f.now+500, bindingExpiresAt: f.now+900, takeCredential: () => who.credential });
    return { read: createModerationClient({ endpoint, sessions: memory, send }),
      flow: createModerationFlow({ endpoint, sessions: memory, signIntent: who.signForTest, consentSend: send, moderationSend: send, now: () => f.now }) };
  }
  const owner = host(f), reporter = host(p), moderator = host(m), stranger = host(other);
  const action = async (who, input) => { const preview = await who.flow.prepare(input);
    return { preview, receipt: await who.flow.execute(preview, preview.confirmation) }; };
  try {
    const root = { kind: 'case', id: randomUUID(), localRef: randomUUID(), title: 'Independent Case review', summary: 'Private source',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }, { subjectId: m.actor.subjectId, role: 'provider' }] };
    const sourceGrant = await f.authorize(root, 'case.teaser.publish', { viewers: [p.actor.subjectId] });
    await f.cases.submit(f.actor, sourceGrant);
    const base = { kind: 'report', caseId: root.id, caseVersion: 1, targetEventId: root.id, category: 'misrepresentation', summary: 'Reader disputes source description' };
    const missing = await stranger.flow.prepare(base);
    await assert.rejects(stranger.flow.execute(missing, missing.confirmation), /not_found/);
    const invalid = await reporter.flow.prepare({ ...base, targetEventId: randomUUID() });
    await assert.rejects(reporter.flow.execute(invalid, invalid.confirmation), /moderation_case_event_mismatch/);
    const report = await action(reporter, base), id = report.receipt.reportId;
    assert.deepEqual((await reporter.read.query({ caseId: root.id })).items.map(item => item.reportId), [id]);
    assert.equal((await stranger.read.query({ caseId: root.id })).items.length, 0);
    await assert.rejects(stranger.read.get(id), /not_found/);
    await assert.rejects(reporter.read.query({ caseId: root.id, assistanceId: randomUUID() }), /invalid_moderation_query/);
    const reviewer = await moderator.read.get(id);
    assert.equal(reviewer.source, null); // A process role never grants private Case access.
    assert.equal(reviewer.canModerate, true); // Owner-asserted participants do not create a verified party.
    assert.equal(reviewer.report.summary, base.summary);
    assert.equal((await reporter.read.get(id)).source.targetEvent.summary, root.summary);
    const ownerView = await owner.read.get(id);
    assert.equal(ownerView.report, null); assert.equal(ownerView.source, null); assert.equal(ownerView.canAppeal, true);
    assert.equal(ownerView.canModerate, false);
    await assert.rejects(owner.flow.prepare({ kind: 'resolve', reportId: id, summary: 'Own verdict', verdict: 'dismissed' }), /role/);
    // Even if assigned moderator, the Case owner cannot adjudicate this Case.
    f.moderation.moderatorIds.push(f.actor.subjectId);
    assert.equal((await owner.read.get(id)).canModerate, false);
    f.moderation.moderatorIds = [m.actor.subjectId];
    const attempt = { kind: 'attempt', id: randomUUID(), caseId: root.id, expectedVersion: 1, sequence: 1,
      approach: 'Reproduce', configuration: { environment: 'fixture', version: '1', tools: [] } };
    await f.cases.submit(f.actor, await f.authorize(attempt, 'case.teaser.publish', { viewers: [p.actor.subjectId] }));
    const stale = await reporter.flow.prepare(base);
    await assert.rejects(reporter.flow.execute(stale, stale.confirmation), /moderation_case_version_conflict/);
    assert.equal((await reporter.read.get(id)).source.currentVersion, 2);
    // Existing exact report replay is idempotent after source evolution.
    assert.equal((await f.moderation.report(p.actor, { consentId: JSON.parse(report.preview.intentJson).id, payloadJson: report.preview.payloadJson })).reportId, id);
    const request = { id: randomUUID(), caseId: root.id, title: 'Linked open request', problem: 'Reproduce', attemptedApproaches: [],
      scope: 'Diagnose', visibility: 'Public', collaboration: 'open-assistance', enrollmentExpiresAt: f.now+800 };
    await f.assistance.create(f.actor, await f.authorize(request, 'assistance.publish', { visibility: 'Public', purpose: 'public-profile' }));
    await action(moderator, { kind: 'pause', reportId: id, summary: 'Hold linked work while investigating' });
    assert.equal((await f.assistance.get(p.actor, request.id)).paused, true);
    assert.equal((await f.assistance.query(p.actor, { view: 'open' })).items.some(item => item.assistanceId === request.id), false);
    const offer = { id: randomUUID(), expectedVersion: 1, kind: 'offer', proposal: 'Inspect', scope: 'Diagnose' };
    const offerGrant = await p.authorize({ assistanceId: request.id, event: offer }, 'assistance.publish', { objectId: offer.id, viewers: [f.actor.subjectId] });
    await assert.rejects(f.assistance.submit(p.actor, request.id, offerGrant), /assistance_paused/);
    const decision = await action(moderator, { kind: 'resolve', reportId: id, summary: 'Evidence supports the concern; bounded process decision', verdict: 'upheld' });
    await action(owner, { kind: 'appeal', reportId: id, summary: 'Owner disputes this decision' });
    assert.equal((await moderator.read.get(id)).state, 'appealed');
    await action(owner, { kind: 'supplement', reportId: id, summary: 'Owner supplemental material', references: [{ kind: 'case', id: root.id }] });
    await action(moderator, { kind: 'resolve', reportId: id, summary: 'Later decision dismisses the claim', verdict: 'dismissed' });
    // Resolution and operational hold are separate explicit records.
    assert.equal((await f.assistance.get(p.actor, request.id)).paused, true);
    await action(moderator, { kind: 'resume', reportId: id, summary: 'Release linked work' });
    assert.equal((await f.assistance.get(p.actor, request.id)).paused, false);
    assert.equal((await f.assistance.query(p.actor, { view: 'open' })).items.some(item => item.assistanceId === request.id), true);
    await f.assistance.submit(p.actor, request.id, offerGrant);
    const final = await moderator.read.get(id);
    assert.deepEqual(final.events.filter(event => event.kind === 'resolve').map(event => event.verdict), ['upheld', 'dismissed']);
    assert.ok(final.events.some(event => event.id === decision.receipt.eventId));
    const ticket = await f.dataExport.create(p.actor, { id: randomUUID(), datasets: ['moderation-reports', 'authorized-views'], views: [{ kind: 'moderation', id }] });
    const exported = await f.dataExport.page(p.actor, { id: ticket.id, dataset: 'moderation-reports' });
    assert.equal(exported.items[0].case_id, root.id);
    assert.equal(exported.items[0].assistance_id, null);
    await f.consents.revoke(f.actor, sourceGrant.consentId);
    assert.equal((await reporter.read.get(id)).source, null);
    assert.equal((await reporter.read.get(id)).report.summary, base.summary);
    await f.consents.revoke(p.actor, JSON.parse(report.preview.intentJson).id);
    const view = (await f.dataExport.page(p.actor, { id: ticket.id, dataset: 'authorized-views' })).items[0].view;
    assert.equal(view.report, null); assert.ok(view.events.some(event => event.kind === 'resolve'));
    assert.equal((await f.db.query('SELECT payload_text FROM case_events WHERE id=$1', [root.id])).rows[0].payload_text, sourceGrant.payloadJson);
    assert.equal((await f.db.query('SELECT payload_text FROM moderation_reports WHERE id=$1', [id])).rows[0].payload_text, report.preview.payloadJson);
  } finally {
    sessions.forEach(memory => memory.close()); api.closeAllConnections();
    await new Promise(resolve => api.close(resolve)); if (!db) await f.db.close();
  }
}
