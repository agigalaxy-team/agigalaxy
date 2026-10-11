import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHelpRuntimeV2 } from '../src/help-runtime-v2.mjs';

test('signed private Project participant declarations survive actual HTTP Discovery and local Help without granting control or creating success', { timeout: 90000 }, async t => {
  const now = Math.floor(Date.now() / 1000), scopes = ['binding', 'consent', 'case-teaser', 'history', 'assistance', 'notifications'];
  const viewer = await serviceFixture(scopes, null, { now });
  let api = null, sessions = null, directory = null;
  t.after(async () => {
    sessions?.close();
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await viewer.db.close();
    if (directory) {
      const withinTemp = relative(resolve(tmpdir()), resolve(directory));
      assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp), 'delete only this isolated test directory');
      await rm(directory, { recursive: true, force: true });
    }
  });
  const owner = await serviceFixture(scopes, viewer.db, { now, migrateDatabase: false });
  directory = await mkdtemp(join(tmpdir(), 'galaxy-project-participant-kinds-'));
  await writeFile(join(directory, 'galaxy-id.json'), JSON.stringify(viewer.genesis), { mode: 0o600 });
  api = createApi({ ...viewer, rateLimit: 1000 });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, endpoint = viewer.access.endpoint;
  const request = async (who, path, input, status = 200) => {
    const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.credential}` },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  };
  const write = async (who, event, status = 200) => {
    // Private declarations shared with an exact viewer use the normal signed
    // source grant. No public Account adapter or real entity is simulated.
    const grant = await who.authorize(event, 'project.write', { objectId: event.operationId, viewers: [viewer.actor.subjectId] });
    const result = await request(who, '/v2/projects', grant, status);
    return { event, grant, result };
  };
  const projects = [];
  for (const kind of ['organization', 'service', 'human', null]) {
    const document = { kind: 'module', title: `Synthetic ${kind ?? 'undeclared'} diagnostic source`,
      summary: 'Current source declaration; no asserted verified accomplishment', functions: ['document parsing'],
      technologies: ['Rust'], discoverable: true, ...(kind ? { participantKind: kind } : {}) };
    const published = await write(owner, { operationId: randomUUID(), projectId: randomUUID(), expectedRevision: 0, kind: 'create', document });
    const view = await request(viewer, `/v2/projects/${published.event.projectId}`);
    assert.equal(view.document.participantKind, kind ?? 'unknown'); assert.equal(view.classification, 'self-declared');
    assert.equal(view.capabilityVerified, false); assert.equal(view.legalOwnershipVerified, false);
    assert.equal(view.permissions.edit, false); assert.equal(view.permissions.represent, false);
    assert.equal(view.permissions.agentControl, false); assert.equal(view.permissions.privateFiles, false);
    const ownerView = await request(owner, `/v2/projects/${published.event.projectId}`);
    assert.equal(ownerView.ownerId, owner.actor.subjectId); assert.equal(ownerView.permissions.agentControl, false);
    assert.equal((await request(owner, '/v2/projects', published.grant)).replayed, true);
    assert.equal((await viewer.db.query('SELECT payload_text FROM project_events_v2 WHERE operation_id=$1', [published.event.operationId])).rows[0].payload_text, published.grant.payloadJson);
    projects.push({ ...published, kind: kind ?? 'unknown' });
  }
  // The owner can revise the declaration. This does not replace the source ID,
  // silently promote the viewer, or make participantKind a permission switch.
  const organization = projects[0];
  for (const [expectedRevision, participantKind] of [[1, 'service'], [2, 'organization']]) {
    await write(owner, { operationId: randomUUID(), projectId: organization.event.projectId, expectedRevision, kind: 'revise', patch: { participantKind } });
    assert.equal((await request(viewer, `/v2/projects/${organization.event.projectId}`)).document.participantKind, participantKind);
  }
  const invalid = { operationId: randomUUID(), projectId: organization.event.projectId, expectedRevision: 3,
    kind: 'revise', patch: { participantKind: 'administrator' } };
  await write(owner, invalid, 400);
  assert.equal((await viewer.db.query('SELECT operation_id FROM project_events_v2 WHERE operation_id=$1', [invalid.operationId])).rows.length, 0);
  const human = projects[2];
  await write(owner, { operationId: randomUUID(), projectId: human.event.projectId, expectedRevision: 1,
    kind: 'grant-role', subjectId: viewer.actor.subjectId, role: 'editor' });
  assert.equal((await request(viewer, `/v2/projects/${human.event.projectId}`)).permissions.edit, true);
  const forbiddenTypeChange = await write(viewer, { operationId: randomUUID(), projectId: human.event.projectId,
    expectedRevision: 2, kind: 'revise', patch: { participantKind: 'organization' } }, 403);
  assert.equal(forbiddenTypeChange.result.error, 'project_owner_setting_required');
  await write(owner, { operationId: randomUUID(), projectId: human.event.projectId, expectedRevision: 2,
    kind: 'revoke-role', subjectId: viewer.actor.subjectId, role: 'editor' });
  assert.equal((await request(viewer, `/v2/projects/${human.event.projectId}`)).permissions.edit, false);
  for (const who of [viewer, owner]) {
    const prefs = await who.discovery.preferences(who.actor);
    await who.discovery.save(who.actor, { expectedRevision: prefs.revision, preferences: { enabled: true } });
  }
  const query = { context: { kind: 'ephemeral', title: 'Current diagnosis', functions: ['document parsing'], technologies: ['Python'] }, purposes: ['conversation'] };
  const discovered = await request(viewer, '/v2/discovery/query', query);
  for (const project of projects) {
    const item = discovered.items.find(item => item.projectId === project.event.projectId);
    assert.ok(item); assert.equal(item.participant.kind, project.kind);
    assert.equal(item.participant.kindSource, 'self-declared-project-document');
    assert.equal(item.capabilityVerified, false); assert.equal(item.invitationSent, false);
  }
  sessions = createSessionMemory({ now: () => now, isCurrent: async () => true });
  sessions.adopt({ endpoint, subjectId: viewer.actor.subjectId, bindingId: viewer.actor.bindingId, scopes,
    expiresAt: now + 500, bindingExpiresAt: now + 900, takeCredential: () => viewer.credential });
  const send = async (url, options, method = 'POST') => {
    const response = await fetch(origin + new URL(url).pathname, { method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.credential}` },
      ...(method === 'POST' ? { body: options.bodyJson } : {}), signal: options.signal });
    const body = await response.json(); if (response.status !== 200) throw Object.assign(new Error(body.error), { code: body.error }); return body;
  };
  const flow = () => createHelpRuntimeV2({ dataDirectory: directory, endpoint, subjectId: viewer.actor.subjectId, sessions,
    send, read: (url, options) => send(url, options, 'GET'), now: () => now });
  const caseId = randomUUID(), root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0,
    actorId: viewer.actor.subjectId, localRef: randomUUID(), title: 'Original ongoing work', summary: 'Synthetic ongoing work without a failure claim',
    synthetic: true, source: { kind: 'local', reference: randomUUID() } };
  await viewer.cases.submitV2(viewer.actor, await viewer.authorize(root, 'case.teaser.publish', { objectId: root.eventId }));
  let session = await flow().start({ localTaskRef: 'original-conversation:project-kind-review', caseId });
  const helpRequest = { requestId: randomUUID(), kind: 'discovery-v2', input: query };
  const found = await flow().query(session.id, { requests: [helpRequest] }); session = found.session;
  assert.equal(found.results[0].state, 'ready');
  const offers = projects.map(project => {
    const item = found.results[0].data.items.find(item => item.projectId === project.event.projectId);
    const basis = found.results[0].basis.find(basis => basis.id === item.id);
    // Project's established declaration spelling is human; Help's established
    // user-agent explanation spelling is person. Preserve both source vocabularies.
    const helpKind = item.participant.kind === 'human' ? 'person' : item.participant.kind;
    return { id: randomUUID(), path: 'open-assistance', helpDescription: '讨论当前声明的文档诊断范围',
      userFacingReason: helpKind === 'unknown' ? '来源没有说明主体类型，保持未知' : '依据当前自报类型解释参与主体，不代表身份或能力认证',
      participants: [{ id: item.participant.subjectId, kind: helpKind, basisKey: basis.key }], basisKeys: [basis.key],
      interventionKinds: ['diagnosis'], environmentDifferences: ['Rust 与 Python 环境需要实际对照'], conditions: ['主体是否参与需要单独回应'] };
  });
  session = await flow().compose(session.id, { expectedRevision: session.revision, offers });
  session = await flow().select(session.id, { expectedRevision: session.revision, offerIds: offers.map(offer => offer.id) });
  const stored = await flow().get(session.id);
  assert.deepEqual(stored.offers.map(offer => offer.participants[0].kind), ['organization', 'service', 'person', 'unknown']);
  assert.deepEqual(stored.actionOperations, []); assert.deepEqual(stored.linkedOperations, []);
  assert.ok((await flow().review(session.id)).offers.every(offer => offer.state === 'current'));
  const returned = await flow().returnToTask(session.id, { expectedRevision: session.revision });
  assert.equal(returned.handoff.localTaskRef, 'original-conversation:project-kind-review');
  assert.equal(returned.handoff.caseId, caseId); assert.equal(returned.handoff.taskId, null);
  assert.equal(returned.successFactsCreated, false); assert.equal(returned.handoff.hostCallbackVerified, false);
  const facts = await viewer.cases.getV2(viewer.actor, caseId);
  assert.deepEqual(facts.attempts, []); assert.deepEqual(facts.results, []);
  assert.equal((await viewer.db.query('SELECT count(*)::int AS n FROM task_requests')).rows[0].n, 0);
  assert.equal((await viewer.db.query('SELECT count(*)::int AS n FROM capsule_uses_v2')).rows[0].n, 0);
  await owner.consents.revoke(owner.actor, projects[1].grant.consentId);
  const denied = await request(viewer, `/v2/projects/${projects[1].event.projectId}`, undefined, 403);
  assert.equal(denied.error, 'consent_required');
  const revoked = await flow().review(session.id);
  const withheld = revoked.offers.find(offer => offer.id === offers[1].id);
  assert.equal(withheld.state, 'unavailable'); assert.equal(Object.hasOwn(withheld, 'offer'), false);
  assert.ok(revoked.offers.filter(offer => offer.id !== offers[1].id).every(offer => offer.state === 'current'));
  const refreshed = await flow().query(session.id, { requests: [helpRequest] });
  await assert.rejects(flow().select(session.id, { expectedRevision: refreshed.session.revision, offerIds: [offers[1].id] }), /help_selection_refresh_required/);
});
