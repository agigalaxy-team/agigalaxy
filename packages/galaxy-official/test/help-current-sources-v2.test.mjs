import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHelpRuntimeV2 } from '../src/help-runtime-v2.mjs';

test('native help consumes current Capsule, facts, Task and project HTTP sources; keeps exact references and invalidates withdrawn basis', { timeout: 90000 }, async () => {
  const scopes = ['binding', 'consent', 'case-teaser', 'history', 'capsules', 'assistance', 'notifications'];
  const f = await serviceFixture(scopes, null, { now: Math.floor(Date.now() / 1000) }), newcomer = await serviceFixture(scopes, f.db, { migrateDatabase: false, now: f.now });
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-help-current-v2-'));
  await writeFile(join(directory, 'galaxy-id.json'), JSON.stringify(f.genesis));
  const api = createApi({ ...f, rateLimit: 1000 }); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, endpoint = f.access.endpoint, paths = [];
  const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
  sessions.adopt({ endpoint, subjectId: f.actor.subjectId, bindingId: f.actor.bindingId, scopes, expiresAt: f.now + 500,
    bindingExpiresAt: f.now + 900, takeCredential: () => f.credential });
  let failDiscovery = false, corruptSource = false;
  const send = async (url, options, method = 'POST') => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === '/v2/discovery/query' && failDiscovery) throw new Error('synthetic-source-offline');
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.credential}` },
      ...(method === 'POST' ? { body: options.bodyJson } : {}), signal: options.signal });
    const result = await response.json(); if (response.status !== 200) throw Object.assign(new Error(result.error), { code: result.error });
    if (corruptSource && path === '/v2/search/query' && result.items[0]) result.items[0].ref.version = 'unverified-version';
    return result;
  };
  const runtime = () => createHelpRuntimeV2({ dataDirectory: directory, endpoint, subjectId: f.actor.subjectId, sessions,
    send, read: (url, options) => send(url, options, 'GET'), now: () => f.now });
  try {
    const caseId = randomUUID(), root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0,
      actorId: f.actor.subjectId, localRef: randomUUID(), title: 'Current native help case', summary: 'Synthetic private facts only', synthetic: true,
      source: { kind: 'local', reference: randomUUID() } };
    const attempt = { schemaVersion: 2, kind: 'attempt-start', eventId: randomUUID(), caseId, expectedVersion: 1, actorId: f.actor.subjectId,
      role: 'implementation', strategy: 'Check selected synthetic conditions', inputScopeSummary: 'Fixture', permissionScope: ['selected-context'], environment: { name: 'Node', version: '24' } };
    const result = { schemaVersion: 2, kind: 'result-recorded', eventId: randomUUID(), caseId, expectedVersion: 2, actorId: f.actor.subjectId,
      scopeVersion: 1, origin: { kind: 'attempt', id: attempt.eventId, version: 1 }, deliverableRefs: [], reportedOutcome: 'succeeded', summary: 'Synthetic observation', limitations: 'No real user acceptance' };
    for (const event of [root, attempt, result]) await f.cases.submitV2(f.actor, await f.authorize(event, 'case.teaser.publish', { objectId: event.eventId }));
    const capsule = { schemaVersion: 2, kind: 'version', id: randomUUID(), capsuleId: randomUUID(), expectedRevision: 0, version: 1,
      publicationClass: 'formal-source-success', synthetic: true, title: 'Current native help method', problemPattern: 'Synthetic environment mismatch',
      environment: { name: 'Node', version: '24' }, solutionStrategy: 'Review the selected dependency boundary', tools: [], skills: [], mcpRefs: [],
      verificationMethod: 'Own synthetic observation', limitations: ['No independent certification'], capabilityId: 'software-debugging', applicableScope: 'Selected dependency',
      license: 'MIT', contributors: [], sourceResolution: { caseId, resultId: result.eventId, resultVersion: 1, proofIds: [], verificationRefs: [] },
      sourceRefs: [], permissionRefs: [], attributionRefs: [], externalReferences: [], redactionConfirmed: true };
    const signedCapsule = await f.authorize(capsule, 'capsule.publish', { visibility: 'Public', purpose: 'public-profile' });
    await f.capsules.publishV2(f.actor, signedCapsule);
    const project = { operationId: randomUUID(), projectId: randomUUID(), expectedRevision: 0, kind: 'create', document: {
      kind: 'module', title: 'New participant parser', summary: 'Can discuss parser boundaries; no claimed prior success', functions: ['document parsing'],
      technologies: ['Rust'], discoverable: true, participantKind: 'human' } };
    // Explicit private project shared with this viewer; no simulated public Account verification.
    await newcomer.projects.submit(newcomer.actor, await newcomer.authorize(project, 'project.write', { objectId: project.operationId, viewers: [f.actor.subjectId] }));
    for (const who of [f, newcomer]) await who.discovery.save(who.actor, { expectedRevision: (await who.discovery.preferences(who.actor)).revision, preferences: { enabled: true } });
    const flow = runtime(); let session = await flow.start({ localTaskRef: 'original-conversation:current-parser', caseId });
    const request = (kind, input) => ({ requestId: randomUUID(), kind, input });
    const context = { kind: 'ephemeral', title: 'Parser boundary', functions: ['document parsing'], technologies: ['Python'] };
    const capsuleQuery = request('search-v2', { type: 'capsule', query: { query: 'Current native help' } });
    const discoveryQuery = request('discovery-v2', { context, purposes: ['conversation'] });
    const queries = [capsuleQuery, discoveryQuery, request('search-v2', { type: 'history', query: { query: 'Current native help' } }),
      request('search-v2', { type: 'opportunity', query: { context, purposes: ['conversation'] } }), request('search-v2', { type: 'task', query: {} })];
    const found = await flow.query(session.id, { requests: queries }); session = found.session;
    assert.deepEqual(found.results.map(r => r.state), ['ready', 'ready', 'ready', 'ready', 'empty']);
    const cap = found.results[0].basis[0], expert = found.results[1].basis[0], history = found.results[2].basis[0];
    assert.equal(cap.locator.versionId, capsule.id); assert.equal(cap.sourceRevision, found.results[0].data.items[0].ref.version);
    assert.ok(cap.participantIds.includes(f.actor.subjectId)); assert.ok(history.participantIds.includes(f.actor.subjectId));
    assert.equal(expert.locator.documentEventId, project.operationId); assert.deepEqual(expert.participantIds, [newcomer.actor.subjectId]);
    assert.equal(expert.classification, 'self-declared'); assert.equal(expert.availability, 'unknown');
    assert.equal(found.results[1].data.items[0].experience.status, 'not-loaded');
    assert.equal(found.results[3].basis[0].kind, 'opportunity');
    const legacy = await flow.query(session.id, { requests: [request('search', capsuleQuery.input)] });
    assert.equal(legacy.results[0].state, 'empty', 'legacy v1 never represented this v2 Capsule'); session = legacy.session;
    const offer = (path, basis, participant) => ({ id: randomUUID(), path, helpDescription: 'Review the exact selected method or ask its relevant participant',
      userFacingReason: 'Relevant boundary; actual availability and environment remain unknown', basisKeys: [basis.key],
      participants: [{ id: participant, kind: 'person', basisKey: basis.key }], interventionKinds: ['diagnosis'],
      environmentDifferences: ['Node vs Rust implementation'], conditions: ['Recipient must choose whether to help'] });
    const offers = [offer('capsule-or-history', cap, f.actor.subjectId), offer('open-assistance', expert, newcomer.actor.subjectId)];
    session = await flow.compose(session.id, { expectedRevision: session.revision, offers });
    session = await flow.select(session.id, { expectedRevision: session.revision, offerIds: offers.map(o => o.id) });
    const reviewed = await runtime().review(session.id);
    assert.ok(reviewed.offers.every(row => row.state === 'current' && row.offer));
    assert.equal(Object.hasOwn(reviewed.session, 'offers'), false);
    const returned = await runtime().returnToTask(session.id, { expectedRevision: session.revision });
    assert.equal(returned.handoff.localTaskRef, 'original-conversation:current-parser'); assert.equal(returned.successFactsCreated, false);
    assert.equal((await f.capsules.usesV2(f.actor, { capsuleId: capsule.capsuleId })).counts.applications, 0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM task_requests')).rows[0].n, 0);
    failDiscovery = true; const partial = await flow.query(session.id, { requests: [capsuleQuery, discoveryQuery] });
    assert.deepEqual(partial.results.map(r => r.state), ['ready', 'failed']);
    assert.equal(partial.session.offers.find(o => o.id === offers[1].id).sourceStatus, 'refresh-required');
    await f.consents.revoke(f.actor, signedCapsule.consentId);
    const withdrawn = await flow.query(session.id, { requests: [capsuleQuery] }); assert.equal(withdrawn.results[0].state, 'empty');
    const withdrawnReview = await flow.review(session.id);
    assert.equal(withdrawnReview.offers.find(row => row.id === offers[0].id).state, 'unavailable');
    assert.equal(Object.hasOwn(withdrawnReview.offers.find(row => row.id === offers[0].id), 'offer'), false);
    await assert.rejects(flow.select(session.id, { expectedRevision: withdrawn.session.revision, offerIds: [offers[0].id] }), /refresh_required/);
    corruptSource = true; const malformed = await flow.query(session.id, { requests: [queries[2]] }); assert.equal(malformed.results[0].state, 'failed');
    const stored = JSON.stringify(await flow.get(session.id));
    assert.ok(!stored.includes(capsule.solutionStrategy)); assert.ok(!stored.includes(project.document.summary)); assert.ok(!stored.includes(f.credential));
    assert.ok(paths.includes('/v2/search/query')); assert.ok(paths.includes('/v2/discovery/query')); assert.ok(paths.includes('/v1/search/query'));
  } finally {
    sessions.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
