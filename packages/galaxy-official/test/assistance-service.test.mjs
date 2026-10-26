import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createAssistanceFlow } from "../src/clients/flows/assistance.mjs";
import { createAssistanceClient } from "../src/clients/assistance.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";
import { createApi } from '../src/http.mjs';

test('assistance API persists multi-party consent, hides competing offers and validates delivery references', async () => {
  const scopes = ['binding', 'consent', 'case-teaser', 'assistance'];
  const f = await serviceFixture(scopes), p = await serviceFixture(scopes, f.db), other = await serviceFixture(scopes, f.db);
  const api = createApi(f); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const memories = [];
  try {
    const root = { kind: 'case', id: randomUUID(), localRef: randomUUID(), title: 'Assistance fixture', summary: 'Private root',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    await f.cases.submit(f.actor, await f.authorize(root));
    const attempt = { kind: 'attempt', id: randomUUID(), caseId: root.id, expectedVersion: 1, sequence: 1,
      approach: 'Diagnose', configuration: { environment: 'test', version: '1', tools: [] } };
    await f.cases.submit(f.actor, await f.authorize(attempt));
    const request = { id: randomUUID(), caseId: root.id, title: 'Need compiler help', problem: 'Selected public description',
      attemptedApproaches: ['Checked config'], scope: 'Suggest a patch', visibility: 'Public', collaboration: 'open-assistance',
      enrollmentExpiresAt: f.now + 1000 };
    const grant = await f.authorize(request, 'assistance.publish', { visibility: 'Public', purpose: 'public-profile' });
    const origin = `http://127.0.0.1:${api.address().port}`;
    const response = await fetch(origin + '/v1/assistance', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${f.credential}` }, body: JSON.stringify(grant) });
    assert.equal(response.status, 200); await response.arrayBuffer();
    assert.equal((await f.assistance.create(f.actor, grant)).version, 1);
    const host = who => {
      const endpoint = f.bindings.endpoint;
      const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
      memories.push(sessions);
      sessions.adopt({ endpoint, subjectId: who.actor.subjectId, bindingId: who.actor.bindingId, scopes: who.actor.scopes,
        expiresAt: f.now + 500, bindingExpiresAt: f.now + 1000, takeCredential: () => who.credential });
      const transport = async (url, options, method) => {
        const response = await fetch(origin + new URL(url).pathname, { method,
          headers: { Authorization: `Bearer ${options.credential}`, 'Content-Type': 'application/json' },
          ...(method === 'POST' ? { body: options.bodyJson } : {}), signal: options.signal });
        const data = await response.json();
        assert.equal(response.status, 200, JSON.stringify(data)); return data;
      };
      const assistanceClient = createAssistanceClient({ endpoint, sessions,
        send: (url, options) => transport(url, options, 'POST'), read: (url, options) => transport(url, options, 'GET') });
      const assistanceFlow = createAssistanceFlow({ endpoint, sessions, now: () => f.now, signIntent: who.signForTest,
        consentSend: (url, options) => transport(url, options, 'POST'),
        assistanceSend: (url, options) => transport(url, options, 'POST'), assistanceRead: (url, options) => transport(url, options, 'GET') });
      return createHostConnectionController({ endpoint, sessions, assistanceClient, assistanceFlow });
    };
    const hosts = new Map([f, p, other].map(who => [who, host(who)]));
    const replay = await hosts.get(f).prepareAssistance(grant);
    await assert.rejects(hosts.get(f).executeAssistance(replay, 'wrong'), /confirmation/);
    const repeat = await hosts.get(f).prepareAssistance(grant);
    assert.equal((await hosts.get(f).executeAssistance(repeat, repeat.confirmation)).version, 1);
    const hidden = { ...request, id: randomUUID(), visibility: 'Private', title: 'Hidden request' };
    await f.assistance.create(f.actor, await f.authorize(hidden, 'assistance.publish'));
    const another = { ...request, id: randomUUID(), title: 'Another public request' };
    await f.assistance.create(f.actor, await f.authorize(another, 'assistance.publish', { visibility: 'Public', purpose: 'public-profile' }));
    const page = await hosts.get(p).queryAssistance({ view: 'open', limit: 1 });
    assert.equal(page.items.length, 1); assert.ok(page.nextAfter);
    const next = await hosts.get(p).queryAssistance({ view: 'open', limit: 1, after: page.nextAfter });
    assert.equal(next.items.length, 1); assert.equal(next.nextAfter, null);
    assert.notEqual(page.items[0].assistanceId, next.items[0].assistanceId);
    assert.equal((await hosts.get(p).queryAssistance({ query: 'Hidden' })).items.length, 0);
    assert.equal((await hosts.get(f).queryAssistance({ view: 'requested' })).items.length, 3);
    let version = 1;
    const submit = async (who, kind, fields, viewers) => {
      const controller = hosts.get(who);
      const preview = await controller.prepareCollaboration({ assistanceId: request.id, event: { kind, ...fields } });
      const event = JSON.parse(preview.payloadJson).event;
      const intent = JSON.parse(preview.intentJson);
      for (const subjectId of viewers ?? []) assert.ok(subjectId === who.actor.subjectId || intent.viewers.includes(subjectId));
      const receipt = await controller.executeCollaboration(preview, preview.confirmation);
      version = receipt.version; return { event };
    };
    const offer = await submit(p, 'offer', { proposal: 'Provider proposal', scope: 'Inspect compiler logs' }, [f.actor.subjectId]);
    await submit(other, 'offer', { proposal: 'Competitor private proposal', scope: 'Alternative approach' }, [f.actor.subjectId]);
    const applicant = await hosts.get(p).getAssistance(request.id);
    assert.equal(applicant.version, version);
    assert.equal(applicant.offers.length, 1); assert.equal(applicant.events, undefined);
    assert.ok(!JSON.stringify(applicant).includes('Competitor'));
    const rejected = { id: randomUUID(), expectedVersion: version, kind: 'select', offerId: offer.event.id };
    await assert.rejects(f.assistance.submit(f.actor, request.id, await f.authorize({ assistanceId: request.id, event: rejected },
      'assistance.publish', { objectId: rejected.id })), /participant_consent_required/);
    await submit(f, 'select', { offerId: offer.event.id }, [p.actor.subjectId]);
    assert.equal((await f.assistance.get(p.actor, request.id)).state, 'awaiting-confirmation');
    await submit(p, 'confirm', {}, [f.actor.subjectId]);
    const selected = await f.assistance.get(p.actor, request.id);
    assert.equal(selected.state, 'active'); assert.equal(selected.offers.length, 1);
    assert.ok(!JSON.stringify(selected).includes('Competitor'));
    const invalid = { id: randomUUID(), expectedVersion: version, kind: 'deliver', attemptId: randomUUID(), summary: 'Invalid', evidenceIds: [] };
    await assert.rejects(f.assistance.submit(p.actor, request.id, await p.authorize({ assistanceId: request.id, event: invalid },
      'assistance.publish', { objectId: invalid.id, viewers: [f.actor.subjectId] })), /attempt_required/);
    const delivered = await submit(p, 'deliver', { attemptId: attempt.id, summary: 'Patch delivered', evidenceIds: [] }, [f.actor.subjectId]);
    await submit(f, 'accept', { deliveryId: delivered.event.id, summary: 'Requester accepted' }, [p.actor.subjectId]);
    const finished = await hosts.get(f).getAssistance(request.id);
    assert.equal(finished.state, 'accepted'); assert.equal(finished.paymentExecuted, false); assert.equal(finished.contextAccessGranted, false);
    const audit = (await f.db.query("SELECT * FROM audit_events WHERE action='assistance.event' AND object_id IN (SELECT id::text FROM assistance_events WHERE assistance_id=$1) ORDER BY sequence", [request.id])).rows;
    assert.equal(audit.length, 7); assert.ok(audit.every(row => row.context_version === 1 && row.scope === 'assistance'));
    const read = await fetch(origin + '/v1/assistance/' + request.id, { headers: { Authorization: `Bearer ${p.credential}` } });
    assert.equal(read.status, 200); assert.equal((await read.json()).view, 'selected-provider');
    assert.equal((await hosts.get(p).queryAssistance({ view: 'participating' })).items.length, 1);
    await f.consents.revoke(f.actor, grant.consentId);
    await assert.rejects(f.assistance.get(p.actor, request.id), /consent_required/);
    assert.equal((await hosts.get(p).queryAssistance({ view: 'participating' })).items.length, 0);
  } finally { memories.forEach(session => session.close()); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close(); }
});
