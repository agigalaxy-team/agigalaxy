import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildersContinuityFixture } from './builders-client-continuity-workflow.mjs';
import { packFor } from './builder-support-v2-workflow.mjs';
import { configurationExample } from './configuration-v2-workflow.mjs';
import { preparePackUse } from "../../galaxy-web/src/features/tools/worker-pack-use-client.mjs";

// The caller's original host runs a fixed synthetic program. Galaxy has no
// execution callback, installation trigger, model provider or private inputs.
export async function verifyWorkerPackOriginalHostExecution() {
  const f = await buildersContinuityFixture(); let hostRuns = 0;
  const publish = async (path, event, action, objectId = event.operationId ?? event.eventId ?? event.id) => {
    const signed = await f.api.authorizePayload(event, { action, objectId, confirmed: true });
    const receipt = await f.api.call(path, signed); return { signed, receipt };
  };
  try {
    await f.client.submit(f.event, { confirmed: true, visibility: 'Public' });
    const builder = await f.client.read(f.event.builderId, true), manifestId = randomUUID();
    await f.client.submit({ id: manifestId, builderId: f.event.builderId, kind: 'pack-manifest',
      expectedRevision: builder.entry.revision, declarationId: builder.entry.declarationId,
      declarationHash: builder.entry.declarationHash, manifest: packFor(f.event.declaration) },
    { confirmed: true, visibility: 'Public' });
    const pack = await f.workerClient.manifest({ builderId: f.event.builderId, manifestId });
    await f.client.exportPack(f.event.builderId, manifestId);
    assert.equal(hostRuns, 0, 'manifest read/export never starts work');
    const config = configurationExample(f.f.actor);
    config.observedAt = new Date(f.f.now * 1000).toISOString();
    config.conditions.runtime = { name: 'Node', version: process.versions.node };
    config.conditions.environment = { name: 'synthetic-original-host', version: null };
    config.conditions.tools = [{ name: 'node:child_process-fixed-test-program', version: process.versions.node }];
    config.conditions.limitations = 'Only selected synthetic arithmetic task; no real model or external package attribution';
    await publish('/v2/configurations/events', config, 'configuration.publish');
    const caseId = randomUUID(), root = { schemaVersion: 2, kind: 'case-created', eventId: caseId,
      caseId, expectedVersion: 0, actorId: f.f.actor.subjectId, localRef: randomUUID(),
      title: '原宿主受控Pack使用链', summary: '明确选择的合成任务及运行条件', synthetic: true,
      source: { kind: 'local', reference: randomUUID() } };
    await publish('/v2/cases/events', root, 'case.teaser.publish');
    const attempt = { schemaVersion: 2, kind: 'attempt-start', eventId: randomUUID(), caseId,
      expectedVersion: 1, actorId: f.f.actor.subjectId, role: 'implementation',
      strategy: '用户原宿主明确运行一次固定合成算术程序', configurationRef: { id: config.id, version: 1 },
      inputScopeSummary: '固定合成输入1、2、3', permissionScope: ['selected-context'] };
    await publish('/v2/cases/events', attempt, 'case.teaser.publish');
    const initialFacts = await f.workerClient.caseFacts(caseId), selectedAttempt = initialFacts.attempts[0];
    const canceled = preparePackUse({ pack, caseView: initialFacts, attempt: selectedAttempt });
    await f.workerClient.prepare(canceled);
    assert.equal(hostRuns, 0, 'an abandoned association preview never starts a Worker');
    assert.equal(f.calls.filter(path => path === '/v2/builders/pack-uses/events').length, 0);
    hostRuns++;
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify({inputCount:3,total:[1,2,3].reduce((a,b)=>a+b,0),runtime:process.versions.node}))'],
      { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    assert.equal(stderr, ''); const observed = JSON.parse(stdout);
    assert.deepEqual(observed, { inputCount: 3, total: 6, runtime: process.versions.node });
    const result = { schemaVersion: 2, kind: 'result-recorded', eventId: randomUUID(), caseId,
      expectedVersion: 2, actorId: f.f.actor.subjectId, origin: { kind: 'attempt', id: attempt.eventId, version: 1 },
      scopeVersion: 1, deliverableRefs: [], reportedOutcome: 'succeeded',
      summary: '原宿主固定合成输入3项求和实际输出6，进程退出0',
      limitations: '有限运行者报告；不是独立第三方Pack性能、真人或模型能力验证' };
    await publish('/v2/cases/events', result, 'case.teaser.publish');
    const current = await f.workerClient.caseFacts(caseId), payload = preparePackUse({
      pack, caseView: current, attempt: current.attempts[0], result: current.results[0] });
    const preview = await f.workerClient.prepare(payload);
    assert.equal(hostRuns, 1); f.state.losePackUseAck = true;
    await assert.rejects(f.workerClient.execute(preview, { confirmed: true }), /Pack use ACK lost/);
    await f.connect();
    const receipt = await f.workerClient.reconcile(payload.operationId);
    assert.equal(receipt.state, 'acknowledged'); assert.equal(hostRuns, 1);
    assert.equal(f.calls.filter(path => path === '/v2/builders/pack-uses/events').length, 1);
    const view = await f.workerClient.get({ id: payload.id });
    assert.deepEqual(view.record.configuration, { id: config.id, version: 1 });
    assert.deepEqual(view.record.attempt, { id: attempt.eventId, version: 1 });
    assert.deepEqual(view.record.result, { id: result.eventId, version: 1 });
    assert.equal(view.sources.reportedOutcome, 'succeeded');
    assert.equal(view.sources.successfulReuseVerified, false);
    const row = (await f.f.db.query('SELECT payload_hash,payload_text FROM worker_pack_use_events WHERE operation_id=$1', [payload.operationId])).rows[0];
    assert.equal(row.payload_hash, preview.payloadHash); assert.equal(row.payload_text, preview.payloadJson);
    // Revoking configuration content never upgrades a historical association
    // into verified execution or leaks the withdrawn condition body.
    const configConsent = (await f.f.db.query('SELECT consent_id FROM configuration_events WHERE operation_id=$1', [config.operationId])).rows[0];
    await f.api.call('/v1/consents/' + configConsent.consent_id + '/revoke', {});
    const withdrawn = await f.workerClient.get({ id: payload.id });
    assert.equal(withdrawn.sources.configuration.sourceStatus, 'unavailable');
    assert.equal(withdrawn.sources.successfulReuseVerified, false);
    return { hostRuns, actualExitCode: 0, synthetic: true, modelExecuted: false,
      originalOperationRecovered: receipt.state, businessSubmissions: 1,
      configurationVersion: 1, attemptVersion: 1, resultVersion: 1,
      independentPackageExecutionVerified: false };
  } finally { await f.close(); }
}
