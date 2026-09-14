import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { DiscoveryV2Service } from '../src/discovery-v2.mjs';

export async function verifyDiscoveryV2(database = null, options = {}) {
  const scopes = ['binding', 'consent', 'history', 'notifications', 'assistance', 'case-teaser', 'data-delete'];
  const f = await serviceFixture(scopes, database, options), others = [];
  for (let i = 0; i < 3; i++) others.push(await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false }));
  const api = createApi(f); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  const post = async (fixture, path, input, status = 200) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(fixture ? { Authorization: 'Bearer ' + fixture.credential } : {}) }, body: JSON.stringify(input) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const query = (fixture = null, extra = {}) => post(fixture, '/v2/discovery/query', { ...input, ...extra });
  const detail = (opportunityRef, fixture = null, extra = {}) => post(fixture, '/v2/discovery/detail', { ...input, opportunityRef, ...extra });
  const input = { context: { kind: 'ephemeral', title: '提取文档表格', functions: ['table-extraction'], technologies: ['Python'] }, purposes: ['conversation'] };
  const project = (n, extra = {}) => ({ id: randomUUID(), kind: n % 2 ? 'module' : 'project', title: 'Synthetic document work ' + n,
    summary: 'Explicit test description for discussing table extraction', functions: ['table-extraction'], technologies: ['Rust'], discoverable: true, ...extra });
  const declarations = new Map();
  const publish = async (fixture, projects, visibility = 'Public', viewers = []) => {
    const revision = declarations.get(fixture)?.statement.expectedRevision + 1 || 0;
    const statement = { id: randomUUID(), expectedRevision: revision, selfDeclared: { displayName: 'Synthetic participant', projects } };
    const grant = await fixture.authorize(statement, 'profile.publish', { visibility, viewers, purpose: visibility === 'Public' ? 'public-profile' : 'operational' });
    await post(fixture, '/v1/profiles/statements', grant);
    const value = { grant, statement }; declarations.set(fixture, value); return value;
  };
  const save = async (fixture, preferences) => {
    const existing = await fixture.discovery.preferences(fixture.actor);
    return fixture.discovery.save(fixture.actor, { expectedRevision: existing.revision, preferences });
  };
  const counts = async () => (await f.db.query(`SELECT
    (SELECT count(*) FROM profile_statements) AS profiles, (SELECT count(*) FROM cases) AS cases,
    (SELECT count(*) FROM task_requests) AS tasks, (SELECT count(*) FROM task_events) AS task_events,
    (SELECT count(*) FROM chat_rooms) AS rooms, (SELECT count(*) FROM notification_preferences) AS preferences`)).rows[0];
  try {
    for (const [index, other] of others.entries()) {
      await publish(other, Array.from({ length: 10 }, (_, i) => project(index * 10 + i)));
      await save(other, { enabled: true });
    }
    const before = await counts(), first = await query();
    assert.equal(first.items.length, 20); assert.ok(first.nextAfter); assert.equal(first.sourceContext.persistedContext, false);
    assert.equal(first.coverage.scanWindowLimit, 200); assert.equal(first.capabilityVerified, false);
    assert.deepEqual(first.activeEntries, ['discover', 'publish-task', 'participate-task', 'ordinary-chat']);
    const second = await query(null, { after: first.nextAfter });
    assert.equal(second.items.length, 10); assert.equal(second.nextAfter, null);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 30);
    const one = first.items[0], expert = others.find(other => other.actor.subjectId === one.subjectId);
    assert.equal(one.participant.kind, 'unknown'); assert.equal(one.experience.status, 'not-loaded');
    assert.equal(one.classification, 'self-declared'); assert.equal(one.capabilityVerified, false);
    assert.deepEqual(one.match.differences.sourceOnlyTechnologies, ['python']);
    assert.deepEqual(one.match.differences.candidateOnlyTechnologies, ['rust']);
    assert.equal(one.help.commitment, 'not-contacted'); assert.equal(one.invitationSent, false);
    assert.equal(one.sources[0].revision, 1); assert.equal(one.sources[0].statementId, declarations.get(expert).statement.id);
    const noHistory = await detail(one.opportunityRef);
    assert.equal(noHistory.opportunity.experience.status, 'no-visible-page'); assert.equal(noHistory.experience.items.length, 0);
    assert.equal((await query(f)).items.length, 20, 'explicit query needs no own published project or opt-in preference');
    assert.deepEqual(await counts(), before, 'query/detail do not create project, Case, Task, preferences, or room');
    await post(null, '/v2/discovery/query', { ...input, context: { kind: 'project', projectId: randomUUID() } }, 401);
    await post(null, '/v2/discovery/query', { ...input, limit: 21 }, 400);
    await post(null, '/v2/discovery/query', { ...input, context: { ...input.context, privateWorkspace: 'not-accepted' } }, 400);
    await post(f, '/v2/discovery/query', { ...input, after: first.nextAfter }, 409);
    await post(null, '/v2/discovery/query', { ...input, after: first.nextAfter + 'A' }, 409);

    // A real public Task gives a real, correctly limited historical fact. This
    // suite isolates quotas via the fixture; it proves reads, not account login.
    const task = { operationId: randomUUID(), taskId: randomUUID(), caseId: null, intent: 'proactive-review', title: 'Document pipeline review',
      summary: 'Requesting review without a failed Case', workContext: { goal: 'Review', currentSituation: 'Prepared', attemptRefs: [] },
      visibility: 'Public', collaboration: 'open-assistance', enrollmentExpiresAt: expert.now + 1000 };
    await expert.assistance.createTask(expert.actor, await expert.authorize(task, 'assistance.publish',
      { objectId: task.operationId, visibility: 'Public', purpose: 'public-profile' }));
    const withHistory = await detail(one.opportunityRef);
    assert.equal(withHistory.opportunity.experience.status, 'loaded');
    assert.equal(withHistory.experience.items[0].taskId, task.taskId);
    assert.equal(withHistory.experience.items[0].workPerformedInferred, false);
    assert.equal(withHistory.experience.items[0].taskOutcomeVerified, false);
    assert.match(withHistory.experienceRelation, /user-must-assess-relevance/);

    const ownProject = project(90, { discoverable: false }); await publish(f, [ownProject], 'Private');
    const ownContext = { kind: 'project', projectId: ownProject.id };
    assert.equal((await query(f, { context: ownContext })).items.length, 20);
    await save(f, { enabled: false });
    assert.equal((await query(f)).enabled, false, 'explicit off wins over an active query');
    await save(f, { enabled: true, temporary: { contact: 'paused', until: f.now + 10 } });
    assert.equal((await query(f)).enabled, false);
    f.access.now = () => f.now + 10;
    assert.equal((await query(f)).enabled, true); f.access.now = () => f.now;
    await save(f, { enabled: true });
    const currentFirst = await query();
    await save(expert, { enabled: true, temporary: { contact: 'paused', until: f.now + 10 } });
    assert.equal((await query()).items.some(item => item.subjectId === expert.actor.subjectId), false);
    await post(null, '/v2/discovery/detail', { ...input, opportunityRef: one.opportunityRef }, 404);
    await post(null, '/v2/discovery/query', { ...input, after: currentFirst.nextAfter }, 409);
    f.access.now = () => f.now + 10; assert.ok((await query()).items.some(item => item.subjectId === expert.actor.subjectId)); f.access.now = () => f.now;
    await save(expert, { enabled: true });
    const privateVersion = await publish(expert, declarations.get(expert).statement.selfDeclared.projects, 'Private', [f.actor.subjectId]);
    assert.equal((await query()).items.some(item => item.subjectId === expert.actor.subjectId), false, 'no fallback to older public version');
    assert.ok((await query(f)).items.some(item => item.subjectId === expert.actor.subjectId));
    await expert.consents.revoke(expert.actor, privateVersion.grant.consentId);
    assert.equal((await query(f)).items.some(item => item.subjectId === expert.actor.subjectId), false);
    await publish(expert, declarations.get(expert).statement.selfDeclared.projects);

    const deletion = { version: 1, id: randomUUID(), endpoint: expert.access.endpoint, subjectId: expert.actor.subjectId,
      bindingId: expert.actor.bindingId, issuedAt: expert.now, expiresAt: expert.now + 300, action: 'request',
      scope: 'all-owned-service-data', reason: 'privacy', takeout: 'not-needed' };
    const receipt = await expert.deletion.submit(expert.actor, await expert.signForTest(JSON.stringify(deletion), 'galaxy-deletion-intent+jws'));
    assert.equal((await query()).items.some(item => item.subjectId === expert.actor.subjectId), false);
    await expert.deletion.submit(expert.actor, await expert.signForTest(JSON.stringify({ ...deletion, id: randomUUID(), action: 'cancel', requestId: receipt.id,
      expectedRevision: 1, scope: undefined, reason: undefined, takeout: undefined }), 'galaxy-deletion-intent+jws'));
    assert.ok((await query()).items.some(item => item.subjectId === expert.actor.subjectId), 'cancel restores live source consent');

    // A bounded deployment setting exercises real multi-window continuation
    // with actual signed profiles rather than inventing 200 malformed sources.
    const small = new DiscoveryV2Service(f.access, { profiles: f.profiles, notifications: f.notifications, history: f.history.v2, scanWindowLimit: 1 });
    const earliest = [f, ...others].sort((a, b) => a.actor.subjectId.localeCompare(b.actor.subjectId))[0];
    await save(earliest, { enabled: false });
    const page = await small.query(null, input), found = [];
    assert.equal(page.items.length, 0); assert.ok(page.nextAfter, 'empty window does not mean no other matches');
    while (page.nextAfter) { page = await small.query(null, { ...input, after: page.nextAfter }); found.push(...page.items); }
    assert.ok(found.length > 0); assert.equal(new Set(found.map(item => item.id)).size, found.length);
    assert.equal(found.some(item => item.subjectId === earliest.actor.subjectId), false);
    const expiring = await small.query(null, input); f.access.now = () => f.now + 901;
    await assert.rejects(small.query(null, { ...input, after: expiring.nextAfter }), /cursor_unavailable_restart/); f.access.now = () => f.now;
    const broken = new DiscoveryV2Service(f.access, { profiles: { readWithin: async () => { throw new Error('synthetic-source-failure'); } },
      notifications: f.notifications, history: f.history.v2 });
    await assert.rejects(broken.query(null, input), /synthetic-source-failure/, 'query failure must not masquerade as an empty result');
    return { actualHttp: true, anonymousAndPrivateReads: true, ephemeralReadOnly: true, actualHistory: true,
      noExpertHistoryGate: true, sourceAndWillingnessRevocation: true, pendingDeletionCancel: true, paginatedWindows: true };
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); if (!database) await f.db.close(); }
}
