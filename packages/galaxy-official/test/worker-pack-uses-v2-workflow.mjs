import {packUseEventSchema} from '../src/shared/worker-pack-uses-v2-schema.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { packFor } from './builder-support-v2-workflow.mjs';
import { configurationExample } from './configuration-v2-workflow.mjs';
import { digest } from '../src/shared/digest.mjs';
import { createApi } from '../src/http.mjs';
import { workerPackUseToolDefinitions } from '../src/adapters/mcp/personal/tools/worker-pack-uses-v2.mjs';
import { createBrowserClient } from '../src/browser-client.mjs';
import { createWorkerPackUseClient } from "../../galaxy-web/src/features/tools/worker-pack-use-client.mjs";
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';
const scopes = [
  'binding',
  'consent',
  'builders',
  'history',
  'case-teaser',
  'assistance',
  'evidence',
  'data-export',
  'data-delete',
];
export async function verifyWorkerPackUsesV2(database = null, options = {}) {
  const now = Math.floor(Date.now() / 1000),
    f = await serviceFixture(scopes, database, {
      ...options,
      now,
      syntheticCommunityQuota: false,
    }),
    p = await serviceFixture(scopes, f.db, {
      ...options,
      now,
      migrateDatabase: false,
      syntheticCommunityQuota: false,
    }),
    q = await serviceFixture(scopes, f.db, {
      ...options,
      now,
      migrateDatabase: false,
      syntheticCommunityQuota: false,
    });
  const api = createApi({ ...f, rateLimit: 1000 });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + api.address().port,
    call = async (who, path, body) => {
      const r = await fetch(origin + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(who ? { authorization: 'Bearer ' + who.credential } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
  const ok = async (who, path, body) => {
    const r = await call(who, path, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const sign = (who, e, action = 'builder.publish', more = {}) =>
      who.authorize(e, action, {
        objectId: e.operationId ?? e.eventId ?? e.id,
        ...more,
      }),
    publicView = { visibility: 'Public', purpose: 'public-profile' },
    members = [f, p, q].map((v) => v.actor.subjectId),
    privateView = (who) => ({
      viewers: members.filter((id) => id !== who.actor.subjectId),
    });
  const cg = (who, e) => sign(who, e, 'case.teaser.publish', privateView(who)),
    ag = (who, e, viewer) =>
      sign(who, e, 'assistance.publish', { viewers: [viewer] });
  try {
    const builderId = randomUUID(),
      declaration = builderDeclaration('worker', f.actor.subjectId),
      decl = {
        id: randomUUID(),
        builderId,
        expectedRevision: 0,
        kind: 'declare',
        declaration,
      };
    await f.builders.publish(
      f.actor,
      await sign(f, decl, 'builder.publish', publicView),
    );
    const manifest = {
      id: randomUUID(),
      builderId,
      expectedRevision: 1,
      kind: 'pack-manifest',
      declarationId: decl.id,
      declarationHash: digest(JSON.stringify(decl)),
      manifest: packFor(declaration),
    };
    const manifestGrant = await sign(
      f,
      manifest,
      'builder.publish',
      publicView,
    );
    await f.builders.v2.publish(f.actor, manifestGrant);
    const pack = {
      builderId,
      manifestId: manifest.id,
      manifestHash: digest(manifestGrant.payloadJson),
    };
    const emptyCount = (
      await f.db.query('SELECT count(*)::int n FROM case_events')
    ).rows[0].n;
    await ok(null, '/v2/builders/pack/manifest', pack);
    assert.equal(
      (await f.db.query('SELECT count(*)::int n FROM case_events')).rows[0].n,
      emptyCount,
    );
    const config = {
        ...configurationExample(p.actor),
        observedAt: new Date(now * 1000).toISOString(),
      },
      configGrant = await sign(
        p,
        config,
        'configuration.publish',
        privateView(p),
      );
    await p.configurations.submit(p.actor, configGrant);
    const task = {
      operationId: randomUUID(),
      taskId: randomUUID(),
      caseId: null,
      intent: 'proactive-review',
      title: '合成Pack协作',
      summary: '包作者、运行者及复核者分别记录',
      workContext: {
        goal: '核对准确运行关联',
        currentSituation: '准备工作',
        attemptRefs: [],
      },
      visibility: 'Private',
      collaboration: 'open-assistance',
      enrollmentExpiresAt: now + 1000,
    };
    await f.assistance.createTask(
      f.actor,
      await sign(f, task, 'assistance.publish', privateView(f)),
    );
    const caseId = randomUUID(),
      root = {
        schemaVersion: 2,
        kind: 'case-created',
        eventId: caseId,
        caseId,
        expectedVersion: 0,
        actorId: f.actor.subjectId,
        taskId: task.taskId,
        localRef: randomUUID(),
        title: '所选工作',
        summary: '最小合成数据范围',
        synthetic: true,
        source: { kind: 'active-task', reference: task.taskId },
      },
      first = {
        schemaVersion: 2,
        kind: 'intervention',
        eventId: randomUUID(),
        caseId,
        expectedVersion: 1,
        actorId: f.actor.subjectId,
        taskId: task.taskId,
        types: ['scope-clarification'],
        affectsAttemptIds: [],
        description: '明确范围',
        sourceRefs: [],
        observedEffect: '尚未产生修复',
      };
    await f.cases.createAndLinkTask(f.actor, {
      operationId: randomUUID(),
      taskId: task.taskId,
      expectedTaskVersion: 1,
      case: await cg(f, root),
      initialFact: await cg(f, first),
    });
    const participation = async (who, role) => {
      const view = await f.assistance.getTask(f.actor, task.taskId),
        e = {
          eventId: randomUUID(),
          kind: 'propose',
          expectedTaskVersion: view.version,
          participationId: randomUUID(),
          subjectId: who.actor.subjectId,
          role,
          scopeVersion: 1,
          agreedScope: '仅合成范围',
        };
      await f.assistance.proposeParticipation(
        f.actor,
        task.taskId,
        await ag(f, e, who.actor.subjectId),
      );
      await f.assistance.submitParticipationEvent(
        who.actor,
        e.participationId,
        await ag(
          who,
          {
            eventId: randomUUID(),
            kind: 'confirm',
            expectedParticipationVersion: 1,
            scopeVersion: 1,
          },
          f.actor.subjectId,
        ),
      );
      return e.participationId;
    };
    const pid = await participation(p, 'patch'),
      qid = await participation(q, 'verification');
    const attempt = {
      schemaVersion: 2,
      kind: 'attempt-start',
      eventId: randomUUID(),
      caseId,
      expectedVersion: 2,
      actorId: p.actor.subjectId,
      taskId: task.taskId,
      participationId: pid,
      participationScopeVersion: 1,
      role: 'implementation',
      strategy: '在本人环境使用所选Pack',
      configurationRef: { id: config.id, version: 1 },
      inputScopeSummary: '选定材料',
      permissionScope: ['selected-context'],
    };
    const attemptGrant = await cg(p, attempt);
    await p.cases.submitV2(p.actor, attemptGrant);
    const use = {
      schemaVersion: 2,
      kind: 'record',
      operationId: randomUUID(),
      id: randomUUID(),
      expectedVersion: 0,
      pack,
      caseId,
      attempt: { id: attempt.eventId, version: 1 },
      configuration: { id: config.id, version: 1 },
      result: null,
      evidenceRefs: [],
      verificationRefs: [],
      follows: null,
    };
    const useGrant = await sign(p, use, 'builder.publish', publicView),
      receipt = await ok(p, '/v2/builders/pack-uses/events', useGrant);
    assert.equal(receipt.version, 1);
    assert.deepEqual(
      await ok(p, '/v2/builders/pack-uses/events', useGrant),
      receipt,
    );
    assert.equal(
      (await ok(null, '/v2/builders/pack-uses/query', { builderId })).items
        .length,
      0,
      'public association does not disclose private Case facts',
    );
    const own = await ok(p, '/v2/builders/pack-uses/read', { id: use.id });
    assert.equal(own.sources.result, null);
    assert.equal(own.sources.reportedOutcome, 'unrecorded');
    const forged = { ...use, id: randomUUID(), operationId: randomUUID() };
    assert.equal(
      (await call(q, '/v2/builders/pack-uses/events', await sign(q, forged)))
        .status,
      403,
    );
    const duplicate = { ...use, id: randomUUID(), operationId: randomUUID() };
    assert.equal(
      (await call(p, '/v2/builders/pack-uses/events', await sign(p, duplicate)))
        .status,
      409,
    );
    const wrong = {
      ...use,
      operationId: randomUUID(),
      expectedVersion: 1,
      configuration: { id: config.id, version: 2 },
    };
    assert.equal(
      (await call(p, '/v2/builders/pack-uses/events', await sign(p, wrong)))
        .status,
      422,
    );
    const result = {
      schemaVersion: 2,
      kind: 'result-recorded',
      eventId: randomUUID(),
      caseId,
      expectedVersion: 3,
      actorId: p.actor.subjectId,
      taskId: task.taskId,
      participationId: pid,
      participationScopeVersion: 1,
      origin: { kind: 'attempt', ...use.attempt },
      scopeVersion: 1,
      deliverableRefs: [],
      reportedOutcome: 'partial',
      summary: '仅完成所选诊断',
      limitations: '不是独立Pack性能证明',
    };
    await p.cases.submitV2(p.actor, await cg(p, result));
    const base = {
        expectedVersion: 0,
        caseId,
        reportedBy: q.actor.subjectId,
        taskId: task.taskId,
        participationId: qid,
        participationScopeVersion: 1,
        synthetic: true,
        observedAt: new Date(now * 1000).toISOString(),
      },
      evidence = {
        ...base,
        kind: 'evidence',
        id: randomUUID(),
        operationId: randomUUID(),
        evidenceType: 'test-result',
        source: {
          originSystem: 'synthetic',
          externalStableId: randomUUID(),
          contentVersion: '1',
          issuer: q.actor.subjectId,
          originalAt: base.observedAt,
        },
        reportedSourceState: 'available',
        summary: '复核者自己的有限材料',
      },
      verification = {
        ...base,
        kind: 'verification',
        id: randomUUID(),
        operationId: randomUUID(),
        target: { type: 'result', id: result.eventId, version: 1 },
        scopeVersion: 1,
        method: 'local-test',
        scope: '所选诊断',
        conditions: { environment: 'synthetic' },
        observation: 'passed',
        summary: '有限范围报告通过',
        evidenceRefs: [{ id: evidence.id, version: 1 }],
        relationship: 'independent',
      };
    const eg = await sign(q, evidence, 'evidence.submit', privateView(q)),
      vg = await sign(q, verification, 'evidence.submit', privateView(q));
    await q.verificationRecords.submit(q.actor, eg);
    await q.verificationRecords.submit(q.actor, vg);
    const use2 = {
      ...use,
      operationId: randomUUID(),
      expectedVersion: 1,
      result: { id: result.eventId, version: 1 },
      evidenceRefs: [{ id: evidence.id, version: 1 }],
      verificationRefs: [{ id: verification.id, version: 1 }],
    };
    const views = await ok(p, '/v2/builders/pack-uses/candidates', { caseId });
    assert.equal(views.items[0].attempts[0].configurationRef.id, config.id);
    assert.equal(views.items[0].verifications[0].id, verification.id);
    await ok(
      p,
      '/v2/builders/pack-uses/events',
      await sign(p, use2, 'builder.publish', publicView),
    );
    const viewed = await ok(f, '/v2/builders/pack-uses/read', { id: use.id });
    assert.deepEqual(viewed.sources.roles, {
      packAuthorId: f.actor.subjectId,
      runnerId: p.actor.subjectId,
      configurationAuthorId: p.actor.subjectId,
      resultAuthorId: p.actor.subjectId,
      verificationAuthorIds: [q.actor.subjectId],
    });
    assert.equal(viewed.sources.successfulReuseVerified, false);
    assert.equal(
      viewed.sources.verifications[0].provenance
        .relationshipIndependentlyVerified,
      false,
    );
    await q.consents.revoke(q.actor, vg.consentId);
    const revoked = await ok(p, '/v2/builders/pack-uses/read', { id: use.id });
    assert.equal(revoked.sources.verifications[0].record, null);
    assert.equal(revoked.sources.result.summary, result.summary);
    await p.consents.revoke(p.actor, configGrant.consentId);
    const hidden = await ok(f, '/v2/builders/pack-uses/read', { id: use.id });
    assert.equal(hidden.sources.configuration.record, null);
    assert.equal(hidden.sources.result.summary, result.summary);
    const decl2 = {
      ...decl,
      id: randomUUID(),
      expectedRevision: 2,
      declaration: {
        ...declaration,
        release: {
          ...declaration.release,
          version: '0.2.0',
          buildHash: 'd'.repeat(64),
        },
      },
    };
    await f.builders.publish(
      f.actor,
      await sign(f, decl2, 'builder.publish', publicView),
    );
    const manifest2 = {
      ...manifest,
      id: randomUUID(),
      expectedRevision: 3,
      declarationId: decl2.id,
      declarationHash: digest(JSON.stringify(decl2)),
      manifest: packFor(decl2.declaration),
    };
    const mg2 = await sign(f, manifest2, 'builder.publish', publicView);
    await f.builders.v2.publish(f.actor, mg2);
    assert.equal(
      (await ok(p, '/v2/builders/pack-uses/read', { id: use.id })).sources.pack
        .versionStatus,
      'historical-version',
    );
    const config2 = {
      ...config,
      operationId: randomUUID(),
      expectedVersion: 1,
      title: '新配置版本',
    };
    await p.configurations.submit(
      p.actor,
      await sign(p, config2, 'configuration.publish', privateView(p)),
    );
    const attempt2 = {
      ...attempt,
      eventId: randomUUID(),
      expectedVersion: 4,
      configurationRef: { id: config.id, version: 2 },
    };
    await p.cases.submitV2(p.actor, await cg(p, attempt2));
    const upgrade = {
      ...use,
      id: randomUUID(),
      operationId: randomUUID(),
      pack: {
        builderId,
        manifestId: manifest2.id,
        manifestHash: digest(mg2.payloadJson),
      },
      attempt: { id: attempt2.eventId, version: 1 },
      configuration: { id: config.id, version: 2 },
      follows: { id: use.id, kind: 'upgrade' },
    };
    await browserWorkflow(p, origin, upgrade, f.bindings.trustedKeys);
    const upgraded = await ok(p, '/v2/builders/pack-uses/read', {
      id: upgrade.id,
    });
    assert.equal(upgraded.sources.verifications.length, 0);
    assert.equal(upgraded.sources.result, null);
    assert.equal(
      (
        await workerPackUseToolDefinitions(
          p,
          p.actor,
        ).galaxy_worker_pack_use_receipt.run({
          operationId: upgrade.operationId,
          payloadHash: digest(JSON.stringify(packUseEventSchema.parse(upgrade))),
        })
      ).state,
      'acknowledged',
    );
    const ticket = await p.dataExport.create(p.actor, {
      id: randomUUID(),
      datasets: ['worker-pack-uses', 'worker-pack-use-events'],
    });
    const exported = await p.dataExport.page(p.actor, {
      id: ticket.id,
      dataset: 'worker-pack-use-events',
    });
    assert.equal(
      JSON.stringify(exported).includes(verification.summary),
      false,
      'own export contains reference receipts, not foreign source body',
    );
    await p.consents.revoke(p.actor, attemptGrant.consentId);
    assert.equal(
      (await ok(p, '/v2/builders/pack-uses/read', { id: use.id })).record,
      null,
    );
    await ok(
      p,
      '/v2/builders/pack-uses/events',
      await sign(p, {
        schemaVersion: 2,
        kind: 'revoke',
        id: use.id,
        operationId: randomUUID(),
        expectedVersion: 2,
        reason: '撤回本人的来源关联',
      }),
    );
    assert.equal(
      (await ok(p, '/v2/builders/pack-uses/read', { id: use.id })).state,
      'revoked',
    );
    const admin = options.adminDatabase ?? f.db,
      command = await approveFixtureDeletion(p, admin, {
        auditUntil: now + 180,
      });
    await executeDeletion(admin, command, {
      now: () => now,
    });
    for (const table of ['worker_pack_uses', 'worker_pack_use_events'])
      assert.equal(
        (
          await admin.query(
            'SELECT count(*)::int n FROM ' + table + ' WHERE subject_id=$1',
            [p.actor.subjectId],
          )
        ).rows[0].n,
        0,
      );
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM verification_objects WHERE subject_id=$1',
          [q.actor.subjectId],
        )
      ).rows[0].n,
      2,
      'runner deletion does not delete independent verifier',
    );
    return {
      actualHttp: true,
      independentSubjects: 3,
      syntheticOnly: true,
      lostAcknowledgementRecovery: true,
      physicalOwnDeletion: true,
    };
  } finally {
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
    if (!database) await f.db.close();
  }
}
async function browserWorkflow(f, origin, payload, trustedKeys) {
  const storage = new Map(),
    getLocal = async (k) => structuredClone(storage.get(k)),
    putLocal = async (k, v) => storage.set(k, structuredClone(v));
  let loseConsent = true,
    loseBusiness = false,
    posts = 0,
    consentPosts = 0;
  const scopes = ['binding','consent','builders','history','case-teaser','assistance','evidence','data-export','data-delete'],
    key = f.genesis.genesisProof.publicKeyPem,
    deviceId = randomUUID(),
    upgrade = {
      version: 2,
      kind: 'bootstrap',
      operationId: randomUUID(),
      subjectId: f.actor.subjectId,
      expectedEpoch: 0,
      previousEventHash: null,
      signerKeyId: digest(key),
      genesisProof: f.genesis.genesisProof,
      newDevice: {
        deviceId,
        publicKeyPem: key,
        scopes: ['manage-identity', ...scopes],
      },
    };
  const challenge = await f.identityControl.challenge(upgrade),
    signature = await f.signForTest(
      challenge.challenge,
      'galaxy-identity-control-v2+jws',
    );
  await f.identityControl.commit({
    operationId: upgrade.operationId,
    controllerSignature: signature,
    newDeviceProof: signature,
  });
  const api = createBrowserClient({
    endpoint: f.access.endpoint,
    trustedKeys,
    sign: f.signForTest,
    now: () => f.now,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/consents') consentPosts++;
      if (path === '/v2/builders/pack-uses/events') posts++;
      const response = await fetch(origin + path, init);
      if (path === '/v1/consents' && loseConsent) {
        loseConsent = false;
        assert.equal(response.status, 200);
        throw Error('synthetic lost pack Consent ACK');
      }
      if (path === '/v2/builders/pack-uses/events' && loseBusiness) {
        loseBusiness = false;
        assert.equal(response.status, 200);
        throw Error('synthetic lost pack use ACK');
      }
      return response;
    },
  });
  const runtime = { api, getLocal, putLocal },
    connect = () =>
      api.connect(
        {
          subjectId: f.actor.subjectId,
          genesisProof: f.genesis.genesisProof,
          installationId: randomUUID(),
          scopes,
          control: { deviceId, keyId: digest(key), epoch: 1 },
        },
        { confirmed: true },
      );
  try {
    await connect();
    let client = createWorkerPackUseClient({
      runtime,
      subjectId: f.actor.subjectId,
      now: () => f.now,
    });
    const prepared = await client.prepare(payload);
    await assert.rejects(
      client.execute(prepared, { confirmed: true }),
      /lost pack Consent/,
    );
    assert.equal(posts, 0);
    const count = consentPosts;
    await connect();
    client = createWorkerPackUseClient({
      runtime,
      subjectId: f.actor.subjectId,
      now: () => f.now,
    });
    loseBusiness = true;
    await assert.rejects(
      client.retry(payload.operationId, { confirmed: true }),
      /lost pack use/,
    );
    assert.equal(consentPosts, count);
    const n = posts;
    assert.equal(
      (await client.reconcile(payload.operationId)).state,
      'acknowledged',
    );
    assert.equal(posts, n);
  } finally {
    await Promise.resolve(api.disconnect()).catch(() => {});
  }
}
