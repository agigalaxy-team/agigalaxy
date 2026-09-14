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
import { taskToolDefinitions } from '../src/personal-mcp-task-tools-v2.mjs';
import { registerHelpTools } from '../../galaxy-edge-mcp/src/help-tools-v2.mjs';
import { helpOfferDraftSchema } from '../src/shared/help-schema-v2.mjs';

const id = () => randomUUID();
const draft = (path, fields = {}) => ({ id: id(), path, helpDescription: '用户可获得的具体帮助', userFacingReason: '面向用户的简短理由；不保存内部思考',
  participants: [], interventionKinds: ['diagnosis'], basisKeys: [], environmentDifferences: ['适用环境待用户核对'], conditions: ['是否愿意参与待联系确认'], ...fields });

test('local help uses actual authorized HTTP sources and Task receipts; four paths, newcomer, independent failures, original-task return', { timeout: 90000 }, async () => {
  const scopes = ['binding', 'consent', 'case-teaser', 'history', 'notifications', 'capsules', 'assistance'];
  // The fixture isolates Account quotas. No assertion here proves real OIDC or
  // public-account eligibility; those have a separate parent integration suite.
  // Retention compares stored timestamps with the service clock; keep the
  // synthetic clock in the same period as database-created event timestamps.
  const f = await serviceFixture(scopes, null, { now: Math.floor(Date.now() / 1000) }), newcomer = await serviceFixture(scopes, f.db, { migrateDatabase: false, now: f.now });
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-help-v2-'));
  await writeFile(join(directory, 'galaxy-id.json'), JSON.stringify(f.genesis));
  const api = createApi(f); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, endpoint = f.access.endpoint;
  const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
  sessions.adopt({ endpoint, subjectId: f.actor.subjectId, bindingId: f.actor.bindingId, scopes, expiresAt: f.now + 500,
    bindingExpiresAt: f.now + 900, takeCredential: () => f.credential });
  let failCandidates = false, losePublicationReceipt = false, httpRequests = 0;
  const send = async (url, options, method = 'POST') => {
    const path = new URL(url).pathname; httpRequests++;
    if (path === '/v1/discovery/query' && failCandidates) throw new Error('Synthetic query timeout');
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.credential}` },
      ...(method === 'POST' ? { body: options.bodyJson } : {}), signal: options.signal });
    const result = await response.json();
    if (response.status !== 200) throw Object.assign(new Error(result.error), { code: result.error });
    if (path === '/v2/tasks' && losePublicationReceipt) { losePublicationReceipt = false; throw new Error('Synthetic lost response after server commit'); }
    return result;
  };
  const runtime = () => createHelpRuntimeV2({ dataDirectory: directory, endpoint, subjectId: f.actor.subjectId, sessions,
    send, read: (url, options) => send(url, options, 'GET'), now: () => f.now });
  let flow = runtime();
  try {
    const project = who => ({ id: id(), kind: 'module', title: 'Parser review', summary: 'Synthetic chosen public project description',
      functions: ['document parsing'], technologies: who === f ? ['Python'] : ['Rust'], discoverable: true });
    const ownProject = project(f), expertProject = project(newcomer);
    for (const [who, value] of [[f, ownProject], [newcomer, expertProject]]) {
      const statement = { id: id(), expectedRevision: 0, selfDeclared: { displayName: 'Synthetic participant', projects: [value] } };
      await who.profiles.publish(who.actor, await who.authorize(statement, 'profile.publish', { visibility: 'Public', purpose: 'public-profile' }));
      await who.discovery.save(who.actor, { expectedRevision: (await who.discovery.preferences(who.actor)).revision, preferences: { enabled: true } });
    }
    const root = { id: id(), kind: 'case', localRef: id(), title: 'Synthetic source', summary: 'Selected source only',
      source: { kind: 'local', reference: id() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    await f.cases.submit(f.actor, await f.authorize(root));
    const attempt = { id: id(), kind: 'attempt', caseId: root.id, expectedVersion: 1, sequence: 1, approach: 'Synthetic approach', configuration: { environment: 'Node', version: '24', tools: [] } };
    await f.cases.submit(f.actor, await f.authorize(attempt));
    const result = { id: id(), kind: 'result', caseId: root.id, expectedVersion: 2, attemptId: attempt.id, outcome: 'succeeded', summary: 'Synthetic result', failureReason: '', limitations: ['Fixture'] };
    await f.cases.submit(f.actor, await f.authorize(result));
    const capsule = { id: id(), capsuleId: id(), kind: 'version', expectedRevision: 0, version: 1, title: 'Parser boundary review', problemPattern: 'Parsing a boundary',
      environment: { name: 'Node', version: '24' }, solutionStrategy: 'Inspect grammar transitions', tools: [], skills: [], mcpRefs: [],
      verificationMethod: 'Own synthetic observation', limitations: ['Not a real-world result'], capabilityId: 'parsing', applicableScope: 'Parser review', license: 'MIT', contributors: [],
      sourceResolution: { caseId: root.id, resultId: result.id, proofIds: [] }, redactionConfirmed: true };
    const capsuleConsent = await f.authorize(capsule, 'capsule.publish', { visibility: 'Public', purpose: 'public-profile' });
    await f.capsules.publish(f.actor, capsuleConsent);

    let session = await flow.start({ localTaskRef: 'original-conversation:parser-review' });
    assert.deepEqual(session.activeEntries, ['match', 'publish-task', 'participate-in-task']);
    assert.equal(session.paths.length, 4); assert.equal(session.linkedOperations.length, 0);
    const candidateQuery = { requestId: id(), kind: 'discovery', input: { projectId: ownProject.id } };
    const capsuleQuery = { requestId: id(), kind: 'search', input: { type: 'capsule', query: { query: 'Parser' } } };
    const found = await flow.query(session.id, { requests: [candidateQuery, capsuleQuery] }); session = found.session;
    assert.deepEqual(found.results.map(r => r.state), ['ready', 'ready']);
    assert.equal(found.results[0].data.items[0].subjectId, newcomer.actor.subjectId);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cases WHERE subject_id=$1', [newcomer.actor.subjectId])).rows[0].n, 0);
    const projectBasis = found.results[0].basis[0], capsuleBasis = found.results[1].basis[0];
    assert.equal(capsuleBasis.locator.versionId, capsule.id); assert.equal(capsuleBasis.locator.version, 1);
    const offers = [draft('continue-current-ai'), draft('capsule-or-history', { basisKeys: [capsuleBasis.key], helpDescription: '参考这份边界处理方法，用户模型先核对环境' }),
      draft('open-assistance', { basisKeys: [projectBasis.key], participants: [{ id: newcomer.actor.subjectId, kind: 'person', basisKey: projectBasis.key }], helpDescription: '该新参与者声明了相关模块，可以邀请诊断；是否接受未知' }),
      draft('bounty-or-expert', { helpDescription: '可另发有偿协助请求；资格及报价需通过任务规则确认' })];
    session = await flow.compose(session.id, { expectedRevision: session.revision, offers });
    assert.ok(session.paths.every(p => p.offerIds.length === 1));
    assert.ok(session.offers.every(o => o.availability === 'unknown' && o.generatedBy === 'user-agent'));
    assert.equal(helpOfferDraftSchema.safeParse({ ...offers[0], privateChainOfThought: 'must not be saved' }).success, false);
    await assert.rejects(flow.compose(session.id, { expectedRevision: session.revision, offers: [draft('open-assistance', { basisKeys: ['a'.repeat(64)] })] }), /not_observed/);
    session = await flow.select(session.id, { expectedRevision: session.revision, offerIds: [offers[1].id, offers[2].id] });
    assert.equal(session.selectionEffect, 'local-choice-only');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM capsule_uses')).rows[0].n, 0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM task_requests')).rows[0].n, 0);

    const task = { operationId: id(), taskId: id(), caseId: null, intent: 'proactive-review', workContext: { goal: 'Review parser', currentSituation: 'No failure observed', attemptRefs: [] },
      title: 'Synthetic review', summary: 'Only this selected summary is public', visibility: 'Public', collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 3600 };
    const signed = await f.authorize(task, 'assistance.publish', { objectId: task.operationId, visibility: 'Public', purpose: 'public-profile' });
    losePublicationReceipt = true;
    const unknown = await flow.publish(session.id, signed); session = unknown.session;
    assert.equal(unknown.publication.state, 'unknown'); assert.equal(session.taskId, null);
    failCandidates = true;
    const failed = await flow.query(session.id, { requests: [candidateQuery] });
    assert.equal(failed.results[0].state, 'failed'); assert.equal(failed.session.linkedOperations[0].state, 'unknown');
    await assert.rejects(flow.publish(session.id, signed), /reconcile_original_operation/);
    flow = runtime(); // Process restart: persisted identity/endpoint-scoped refs recover the operation.
    const reconciled = await flow.reconcile(session.id, task.operationId); session = reconciled.session;
    assert.equal(reconciled.receipt.state, 'acknowledged'); assert.equal(session.taskId, task.taskId);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM task_requests')).rows[0].n, 1);
    assert.equal(session.queries.find(q => q.requestId === candidateQuery.requestId).state, 'failed');
    const current = await flow.refresh(session.id); assert.equal(current.remote.contacts.responses.invitations.length, 0);

    const tools = taskToolDefinitions(f, f.actor), invite = { eventId: id(), expectedTaskVersion: current.remote.version, kind: 'invite',
      recipientId: newcomer.actor.subjectId, note: 'Synthetic diagnosis request', expiresAt: f.now + 1800 };
    const invitation = await f.authorize({ taskId: task.taskId, event: invite }, 'assistance.publish', { objectId: invite.eventId, viewers: [newcomer.actor.subjectId] });
    await tools.galaxy_task_v2_event.run({ taskId: task.taskId, ...invitation });
    const reply = { eventId: id(), expectedTaskVersion: 2, kind: 'invitation-reply', invitationId: invite.eventId, response: 'interested', message: 'New participant can help without history' };
    const signedReply = await newcomer.authorize({ taskId: task.taskId, event: reply }, 'assistance.publish', { objectId: reply.eventId, viewers: [f.actor.subjectId] });
    await taskToolDefinitions(f, newcomer.actor).galaxy_task_v2_event.run({ taskId: task.taskId, ...signedReply });
    const refreshed = await flow.refresh(session.id);
    assert.equal(refreshed.remote.contacts.responses.invitations[0].state, 'interested');
    assert.equal(refreshed.remote.contacts.suggestions.items.length, 0, 'local suggestion is not a cloud suggestion nor an application');
    const returned = await flow.returnToTask(session.id, { expectedRevision: refreshed.session.revision });
    assert.equal(returned.handoff.localTaskRef, 'original-conversation:parser-review');
    assert.equal(returned.remote.state, 'open'); assert.equal(returned.successFactsCreated, false); assert.equal(returned.remoteOperationsCanceled, false);

    const second = await flow.start({ localTaskRef: 'another-original-task' });
    const secondTask = { ...task, taskId: id(), operationId: id() };
    const secondSigned = await f.authorize(secondTask, 'assistance.publish', { objectId: secondTask.operationId, visibility: 'Public', purpose: 'public-profile' });
    const acknowledged = await flow.publish(second.id, secondSigned);
    assert.equal(acknowledged.publication.state, 'acknowledged');
    const separateFailure = await flow.query(second.id, { requests: [candidateQuery] });
    assert.equal(separateFailure.results[0].state, 'failed');
    assert.equal(separateFailure.session.linkedOperations[0].state, 'acknowledged');
    assert.equal(separateFailure.session.taskId, secondTask.taskId);
    await assert.rejects(flow.returnToTask(second.id, { expectedRevision: second.revision }), /session_changed/);
    const offline = createHelpRuntimeV2({ dataDirectory: directory, endpoint, subjectId: f.actor.subjectId });
    const notConfigured = await offline.query(second.id, { requests: [candidateQuery] });
    assert.equal(notConfigured.results[0].state, 'unavailable');
    assert.equal(notConfigured.session.linkedOperations[0].state, 'acknowledged');

    const wrongSession = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
    wrongSession.adopt({ endpoint, subjectId: newcomer.actor.subjectId, bindingId: newcomer.actor.bindingId, scopes,
      expiresAt: f.now + 500, bindingExpiresAt: f.now + 900, takeCredential: () => newcomer.credential });
    const wrongRuntime = createHelpRuntimeV2({ dataDirectory: directory, endpoint, subjectId: f.actor.subjectId, sessions: wrongSession,
      send, read: (url, options) => send(url, options, 'GET'), now: () => f.now });
    const beforeWrong = httpRequests;
    assert.equal((await wrongRuntime.query(second.id, { requests: [candidateQuery] })).results[0].state, 'failed');
    assert.equal(httpRequests, beforeWrong, 'other identity cannot query into this local HelpSession');
    wrongSession.close();

    await f.consents.revoke(f.actor, capsuleConsent.consentId);
    const empty = await flow.query(session.id, { requests: [capsuleQuery] });
    assert.equal(empty.results[0].state, 'empty');
    assert.equal(empty.session.offers.find(o => o.id === offers[1].id).sourceStatus, 'refresh-required');
    await assert.rejects(flow.select(session.id, { expectedRevision: empty.session.revision, offerIds: [offers[1].id] }), /refresh_required/);
    const local = JSON.stringify(await flow.get(session.id));
    assert.ok(!local.includes('Only this selected summary is public')); assert.ok(!local.includes(f.credential));
    assert.ok(!local.includes('Inspect grammar transitions')); assert.equal(JSON.parse(local).cloudSync, 'off');
    const registrations = new Map();
    registerHelpTools({ registerTool(name, meta, run) { registrations.set(name, { meta, run }); } }, { flow });
    const response = await registrations.get('galaxy_help_get').run({ sessionId: session.id });
    assert.equal(JSON.parse(response.content[0].text).id, session.id);
    assert.equal(registrations.size, 11); assert.ok(httpRequests >= 9);
    const legacy = { id: id(), caseId: root.id, title: 'Existing legacy assistance', problem: 'Existing issue', attemptedApproaches: [],
      scope: 'Legacy scope', visibility: 'Private', collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 3600 };
    await f.assistance.create(f.actor, await f.authorize(legacy, 'assistance.publish'));
    const legacySession = await flow.start({ localTaskRef: 'legacy-original', taskId: legacy.id, caseId: root.id });
    const legacyRefreshed = await flow.refresh(legacySession.id);
    assert.equal(legacyRefreshed.state, 'refreshed'); assert.equal(legacyRefreshed.remote.compatibility.v2Writes, false);
    const otherEndpoint = createHelpRuntimeV2({ dataDirectory: directory, endpoint: 'https://other.example.org', subjectId: f.actor.subjectId });
    await assert.rejects(otherEndpoint.get(session.id), /not_found/);
    await writeFile(join(directory, 'galaxy-id.json'), JSON.stringify(newcomer.genesis));
    await assert.rejects(flow.get(session.id), /identity_changed/);
    await writeFile(join(directory, 'galaxy-id.json'), JSON.stringify(f.genesis));
    assert.equal((await flow.forget(session.id)).remoteOperationsCanceled, false);
    assert.equal((await f.assistance.getTask(f.actor, task.taskId)).state, 'open');
  } finally {
    sessions.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close();
    // The exact mkdtemp directory is owned by this isolated test.
    await rm(directory, { recursive: true, force: true });
  }
});
