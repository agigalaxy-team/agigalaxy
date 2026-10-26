import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as z from 'zod/v4';
import { createGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { createLocalHelpStoreV2 } from "../src/clients/local/help-store-v2.mjs";
import { createHelpFlowV2 } from "../src/clients/flows/help-v2.mjs";
import { registerHelpTools } from '../../galaxy-edge-mcp/src/help-tools-v2.mjs';

const endpoint = 'https://help-fixture.example.org';
const now = 1791421200;
const genesis = () => createGalaxyGenesis({ originCode: '5', issuedAtMs: now * 1000,
  publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) });

async function fixture(t, hasTask) {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-help-participant-kinds-'));
  t.after(async () => {
    const withinTemp = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp), 'delete only this isolated test directory');
    await rm(directory, { recursive: true, force: true });
  });
  const identity = genesis(), actors = ['organization', 'service', 'unknown'].map(kind => ({ kind, id: genesis().id }));
  await writeFile(join(directory, 'galaxy-id.json'), JSON.stringify(identity), { mode: 0o600 });
  const caseId = randomUUID(), taskId = hasTask ? randomUUID() : null;
  const localTaskRef = 'original-conversation:synthetic-organization-and-service';
  let readable = true, reads = 0, writes = 0;
  // Trusted source-client contract fixture: explicit actors in an authorized
  // synthetic history page. No real organization, service or host is asserted.
  const page = { endpoint, items: [{ id: `case:${caseId}`, type: 'history',
    ref: { version: createHash('sha256').update(caseId).digest('hex') },
    source: { sourceKind: 'case', id: caseId, versionId: randomUUID(), version: 1, schemaVersion: 2 },
    record: { kind: 'case-history', caseId, synthetic: true,
      attempts: actors.map(actor => ({ actorId: actor.id, role: 'diagnosis' })), results: [],
      privateRawBody: 'RAW_HISTORY_NOT_FOR_LOCAL_CHOICE_STORAGE' } }] };
  const sources = { 'search-v2': { async query() { return readable ? structuredClone(page) : { endpoint, items: [] }; } } };
  const task = { schemaVersion: 2, taskId, caseId, version: 4, requesterId: identity.id,
    state: 'open', paused: false, participations: [], results: [] };
  const rejectWrite = async () => { writes++; throw new Error('query_or_selection_must_not_write'); };
  const actions = { async getTask(id) { reads++; assert.equal(id, taskId); return structuredClone(task); },
    createTask: rejectWrite, submitTaskEvent: rejectWrite, proposeParticipation: rejectWrite };
  const makeStore = () => createLocalHelpStoreV2({ dataDirectory: directory, endpoint, subjectId: identity.id, now: () => now });
  const flow = () => createHelpFlowV2({ store: makeStore(), sources, actions, now: () => now });
  return { directory, actors, caseId, taskId, localTaskRef, makeStore, flow,
    revokeSource() { readable = false; }, counts: () => ({ reads, writes }) };
}

for (const hasTask of [false, true]) {
  test(`Help keeps observed organization/service/unknown explanations through real local storage and ${hasTask ? 'existing Task' : 'local conversation'} return`, async t => {
    const f = await fixture(t, hasTask), flow = f.flow();
    let session = await flow.start({ localTaskRef: f.localTaskRef, caseId: f.caseId, taskId: f.taskId });
    const request = { requestId: randomUUID(), kind: 'search-v2', input: { type: 'history', query: {} } };
    const found = await flow.query(session.id, { requests: [request] });
    assert.equal(found.results[0].state, 'ready'); assert.equal(found.queryDoesNotPublish, true);
    session = found.session;
    const basis = found.results[0].basis[0];
    assert.deepEqual(basis.participantIds, f.actors.map(actor => actor.id));
    assert.equal(basis.capabilityVerified, false); assert.equal(basis.availability, 'unknown');
    const offers = f.actors.map(actor => ({ id: randomUUID(), path: 'open-assistance',
      helpDescription: '可围绕已观察的工作记录讨论诊断，是否接受需由主体决定',
      userFacingReason: actor.kind === 'unknown' ? '观察到主体 ID；主体类型尚未观察确认' : '用户模型依据当前可读来源解释主体类型；不代表能力认证',
      participants: [{ id: actor.id, kind: actor.kind, basisKey: basis.key }], basisKeys: [basis.key],
      interventionKinds: ['diagnosis'], environmentDifferences: ['实际环境尚待对照'], conditions: ['需单独确认意愿和授权范围'] }));
    session = await flow.compose(session.id, { expectedRevision: session.revision, offers });
    session = await flow.select(session.id, { expectedRevision: session.revision, offerIds: offers.map(offer => offer.id) });
    const persisted = await f.makeStore().get(session.id);
    assert.deepEqual(persisted.offers.map(offer => offer.participants[0].kind), ['organization', 'service', 'unknown']);
    assert.deepEqual(persisted.selectedHelpIds, offers.map(offer => offer.id));
    assert.ok(persisted.offers.every(offer => offer.availability === 'unknown' && offer.evidenceMeaning === 'references-not-capability-verification'));
    assert.equal(persisted.selectionEffect, 'local-choice-only'); assert.equal(persisted.cloudSync, 'off');
    assert.deepEqual(persisted.actionOperations, []); assert.deepEqual(persisted.linkedOperations, []);
    // Reopening the actual store must not depend on the composing process.
    const review = await f.flow().review(session.id);
    assert.ok(review.offers.every(offer => offer.state === 'current' && offer.offer));
    const revision = persisted.revision;
    for (const kind of ['organization', 'service', 'unknown']) {
      const unobserved = { ...offers[0], id: randomUUID(), participants: [{ id: genesis().id, kind, basisKey: basis.key }] };
      await assert.rejects(flow.compose(session.id, { expectedRevision: revision, offers: [unobserved] }), /help_participant_not_observed/);
    }
    await assert.rejects(flow.compose(session.id, { expectedRevision: revision,
      offers: [{ ...offers[0], id: randomUUID(), basisKeys: ['f'.repeat(64)] }] }), /help_basis_not_observed/);
    assert.equal((await f.makeStore().get(session.id)).revision, revision, 'failed composition does not mutate the local choice');
    const returned = await f.flow().returnToTask(session.id, { expectedRevision: revision });
    assert.equal(returned.handoff.localTaskRef, f.localTaskRef);
    assert.equal(returned.handoff.caseId, f.caseId); assert.equal(returned.handoff.taskId, f.taskId);
    assert.equal(returned.handoff.hostCallbackVerified, false); assert.equal(returned.successFactsCreated, false);
    assert.equal(returned.remoteOperationsCanceled, false);
    assert.equal(returned.state, hasTask ? 'refreshed' : 'no-acknowledged-task');
    if (hasTask) assert.equal(returned.remote.version, 4);
    assert.deepEqual(f.counts(), { reads: hasTask ? 1 : 0, writes: 0 });
    f.revokeSource();
    const revoked = await f.flow().review(session.id);
    assert.ok(revoked.offers.every(offer => offer.state === 'unavailable' && !Object.hasOwn(offer, 'offer')));
    const refreshed = await f.flow().query(session.id, { requests: [request] });
    await assert.rejects(f.flow().select(session.id, { expectedRevision: refreshed.session.revision,
      offerIds: offers.map(offer => offer.id) }), /help_selection_refresh_required/);
    const stored = await f.makeStore().get(session.id);
    assert.equal(JSON.stringify(stored).includes('RAW_HISTORY_NOT_FOR_LOCAL_CHOICE_STORAGE'), false);
    const scopedFile = join(f.directory, 'help-v2', createHash('sha256').update(JSON.stringify([endpoint, stored.subjectId])).digest('hex'), `${session.id}.json`);
    assert.deepEqual(JSON.parse(await readFile(scopedFile, 'utf8')), stored);
    assert.equal(f.counts().writes, 0);
  });
}

test('registered MCP compose JSON schema carries organization/service without inventing participant types', () => {
  const tools = new Map();
  registerHelpTools({ registerTool(name, meta, run) { tools.set(name, { meta, run }); } }, { flow: { start() {} } });
  const schema = tools.get('galaxy_help_compose').meta.inputSchema;
  const exported = z.toJSONSchema(schema);
  const kinds = exported.properties.offers.items.properties.participants.items.properties.kind.enum;
  assert.ok(kinds.includes('organization')); assert.ok(kinds.includes('service')); assert.ok(kinds.includes('unknown'));
  const offer = { id: randomUUID(), path: 'open-assistance', helpDescription: 'Discuss observed work', userFacingReason: 'Availability unconfirmed',
    participants: [{ id: genesis().id, kind: 'organization', basisKey: 'a'.repeat(64) }], basisKeys: ['a'.repeat(64)],
    interventionKinds: ['advice'], environmentDifferences: [], conditions: [] };
  const input = { sessionId: randomUUID(), expectedRevision: 2, offers: [offer] };
  assert.equal(schema.safeParse(input).success, true);
  assert.equal(schema.safeParse({ ...input, offers: [{ ...offer, participants: [{ ...offer.participants[0], kind: 'administrator' }] }] }).success, false);
});
