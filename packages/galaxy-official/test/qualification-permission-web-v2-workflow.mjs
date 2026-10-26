import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  fixture,
  nativeWork,
  task,
  ag,
  scopes,
} from './qualification-v2-workflow.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createBrowserClient } from '../src/browser-client.mjs';
import { createQualificationPermissionClient } from "../../galaxy-web/src/features/qualification-permissions/qualification-permission-client.mjs";
import {
  qualificationEvaluationInput,
  applicationFromDraft,
} from "../../galaxy-web/src/features/tasks/task-bounty-client.mjs";
import { digest } from '../src/shared/digest.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';
import { transaction } from "../src/infrastructure/database.mjs";
import { cleanupQualificationRequestsWithin } from '../src/operations/qualification-request-retention-v2.mjs';

// Isolated identities and signed synthetic history. No real experts, operators,
// paid work or production permission are inferred from these fixtures.
export async function verifyQualificationPermissionWebV2(
  database = null,
  options = {},
) {
  const now = Math.floor(Date.now() / 1000),
    { f, p } = await fixture(database, {
      ...options,
      now,
      extraScopes: ['notifications', 'data-export', 'data-delete'],
    }),
    admin = options.adminDatabase ?? f.db,
    worker = options.workerDatabase ?? f.db;
  let api;
  const browsers = [];
  try {
    f.qualificationRequests.qualification = f.qualification.v2;
    f.qualificationRequests.calculations = f.qualificationCalculations;
    const n = await serviceFixture(scopes, f.db, {
        ...options,
        now,
        migrateDatabase: false,
        syntheticCommunityQuota: false,
      }),
      work = await nativeWork(f, p),
      t = task(f, true);
    await f.assistance.createTask(n.actor, await ag(n, t, [p.actor.subjectId]));
    const q = await serviceFixture(
        [...scopes, 'notifications', 'data-export', 'data-delete'],
        f.db,
        {
          ...options,
          now,
          migrateDatabase: false,
          syntheticCommunityQuota: false,
        },
      ),
      work2 = await nativeWork(q, p);
    const planInput = {
      taskId: t.taskId,
      participationIds: [
        work.proposal.participationId,
        work2.proposal.participationId,
      ],
      expiresAt: new Date((now + 300) * 1000).toISOString(),
    };
    assert.equal(
      (await f.qualificationRequests.plan(p.actor, planInput)).authors.length,
      2,
    );
    const newTarget = async () => {
      const target = task(f, true);
      await f.assistance.createTask(
        n.actor,
        await ag(n, target, [p.actor.subjectId]),
      );
      return target;
    };
    const declinedTarget = await newTarget(),
      expiredTarget = await newTarget(),
      cancelTarget = await newTarget(),
      reconnectTarget = await newTarget();
    // A legitimate v1 history remains an independent v1 source, never a converted Participation.
    const legacyRoot = {
      kind: 'case',
      id: randomUUID(),
      localRef: randomUUID(),
      title: '原版本人协作',
      summary: '合成隔离旧数据',
      source: { kind: 'local', reference: randomUUID() },
      participants: [{ subjectId: f.actor.subjectId, role: 'requester' }],
    };
    await f.cases.submit(f.actor, await f.authorize(legacyRoot));
    const attempt = {
      kind: 'attempt',
      id: randomUUID(),
      caseId: legacyRoot.id,
      expectedVersion: 1,
      sequence: 1,
      approach: '有限诊断',
      configuration: { environment: 'test', version: '1', tools: [] },
    };
    await f.cases.submit(f.actor, await f.authorize(attempt));
    const legacy = {
      id: randomUUID(),
      caseId: legacyRoot.id,
      title: '原版接受过的诊断',
      problem: '合成测试',
      attemptedApproaches: ['已有有限诊断'],
      scope: '限定诊断',
      visibility: 'Private',
      collaboration: 'open-assistance',
      capabilityId: 'software-debugging',
      enrollmentExpiresAt: now + 500,
    };
    await f.assistance.create(
      f.actor,
      await f.authorize(legacy, 'assistance.publish', {
        viewers: [p.actor.subjectId],
      }),
    );
    let v = 1;
    const event = async (who, kind, fields = {}) => {
      const e = { id: randomUUID(), expectedVersion: v, kind, ...fields };
      const r = await f.assistance.submit(
        who.actor,
        legacy.id,
        await who.authorize(
          { assistanceId: legacy.id, event: e },
          'assistance.publish',
          {
            objectId: e.id,
            viewers: [f.actor.subjectId, p.actor.subjectId].filter(
              (x) => x !== who.actor.subjectId,
            ),
          },
        ),
      );
      v = r.version;
      return e;
    };
    const offer = await event(p, 'offer', {
      proposal: '本人诊断',
      scope: '限定诊断',
    });
    await event(f, 'select', { offerId: offer.id });
    await event(p, 'confirm');
    const delivery = await event(p, 'deliver', {
      attemptId: attempt.id,
      summary: '交付限定诊断',
      evidenceIds: [],
    });
    await event(f, 'accept', {
      deliveryId: delivery.id,
      summary: '接受限定工作',
    });
    const legacyTask = {
      ...task(f, true),
      qualification: { policyId: 'test-related-work', policyVersion: '1' },
    };
    await f.assistance.createTask(
      f.actor,
      await ag(f, legacyTask, [p.actor.subjectId]),
    );
    api = createApi({ ...f, rateLimit: 3000 });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + api.address().port;
    const controls = new Map();
    async function clientFor(who) {
      const storage = new Map(),
        getLocal = async (k) => structuredClone(storage.get(k)),
        putLocal = async (k, v) => storage.set(k, structuredClone(v)),
        control = { mode: null, posts: [], consents: 0 };
      const requestedScopes = [
          'binding',
          'consent',
          'assistance',
          'notifications',
          'data-export',
          'data-delete',
        ],
        key = who.genesis.genesisProof.publicKeyPem,
        deviceId = randomUUID(),
        bootstrap = {
          version: 2,
          kind: 'bootstrap',
          operationId: randomUUID(),
          subjectId: who.actor.subjectId,
          expectedEpoch: 0,
          previousEventHash: null,
          signerKeyId: digest(key),
          genesisProof: who.genesis.genesisProof,
          newDevice: {
            deviceId,
            publicKeyPem: key,
            scopes: ['manage-identity', ...requestedScopes],
          },
        };
      const c = await f.identityControl.challenge(bootstrap),
        signature = await who.signForTest(
          c.challenge,
          'galaxy-identity-control-v2+jws',
        );
      await f.identityControl.commit({
        operationId: bootstrap.operationId,
        controllerSignature: signature,
        newDeviceProof: signature,
      });
      const browser = createBrowserClient({
        endpoint: f.access.endpoint,
        trustedKeys: f.bindings.trustedKeys,
        sign: who.signForTest,
        now: () => now,
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          const auth = new Headers(init?.headers).get('Authorization');
          if (auth?.startsWith('Bearer ')) control.credential = auth.slice(7);
          if (path === '/v1/consents') {
            control.consents++;
            assert.ok(
              [...storage.values()].some(
                (s) =>
                  s?.active?.prepared?.signedIntent ===
                  JSON.parse(init.body).signedIntent,
              ),
            );
            if (control.mode === 'before-consent') {
              control.mode = null;
              throw Error('synthetic before Consent reached server');
            }
          }
          const business =
            path === '/v2/qualification/permission-requests/events' ||
            path === '/v2/qualification/calculation-permissions';
          if (business)
            control.posts.push({ path, submission: JSON.parse(init.body) });
          if(business&&control.beforeBusiness){const run=control.beforeBusiness;control.beforeBusiness=null;run();}const response = await fetch(origin + path, init);
          if (
            (control.mode === 'consent-ack' && path === '/v1/consents') ||
            (control.mode === 'business-ack' && business)
          ) {
            control.mode = null;
            assert.equal(response.status, 200, await response.clone().text());
            throw Error('synthetic lost exact ACK');
          }
          return response;
        },
      });
      const connect = () =>
        browser.connect(
          {
            subjectId: who.actor.subjectId,
            genesisProof: who.genesis.genesisProof,
            installationId: randomUUID(),
            scopes: requestedScopes,
            control: { deviceId, keyId: digest(key), epoch: 1 },
          },
          { confirmed: true },
        );
      await connect();
      browsers.push(browser);
      const runtime = { api: browser, getLocal, putLocal },
        helper = () =>
          createQualificationPermissionClient({
            runtime,
            subjectId: who.actor.subjectId,
            now: () => now,
          });
      controls.set(who, { control, browser, connect, storage, helper });
      return helper();
    }
    let candidate = await clientFor(p);
    let author = await clientFor(f);
    const secondAuthor = await clientFor(q);
    const cp = controls.get(p),
      ca = controls.get(f),
      call = (who, path, input) =>
        controls.get(who).browser.call(path, input, { authenticated: true });
    const legacyView = await cp.browser.call(
        '/v2/tasks/' + legacyTask.taskId,
        null,
        { method: 'GET', authenticated: true },
      ),
      catalog = await call(p, '/v2/qualification/candidates', {
        taskId: legacyTask.taskId,
        kind: 'legacy-assistance',
      });
    assert.equal(catalog.items.length, 1);
    assert.deepEqual(catalog.items[0].evidence, { assistanceIds: [legacy.id] });
    const oldQuery = qualificationEvaluationInput(
      legacyView,
      p.actor.subjectId,
      catalog.items,
    );
    assert.equal(oldQuery.path, '/v1/qualification/evaluate');
    assert.equal((await call(p, oldQuery.path, oldQuery.input)).eligible, true);
    const applied = applicationFromDraft(
      { proposal: '私有申请', scope: '限定范围', selected: catalog.items },
      legacyView,
    );
    assert.deepEqual(applied.qualificationEvidence, {
      proofIds: [],
      assistanceIds: [legacy.id],
    });
    assert.throws(
      () =>
        qualificationEvaluationInput(legacyView, p.actor.subjectId, [
          { kind: 'participation', id: work.proposal.participationId },
        ]),
      /旧规则/,
    );
    const plan = await candidate.plan(planInput),
      group = plan.authors.find((a) => a.sourceAuthorId === f.actor.subjectId);
    assert.equal(group.sourceAuthorId, f.actor.subjectId);
    assert.equal(plan.ready, false);
    assert.ok(plan.ownMaterials.length);
    const forgery = { ...plan.authors[0], sourceAuthorId: n.actor.subjectId },
      bad = await candidate.prepareRequest(plan, forgery);
    await assert.rejects(
      candidate.execute(bad, { confirmed: true }),
      /qualification_request_exact_author_sources_required/,
    );
    await candidate.stopLocalRetry(bad.operationId, { confirmed: true });
    const preview = await candidate.prepareRequest(plan, group);
    cp.control.mode = 'consent-ack';
    await assert.rejects(
      candidate.execute(preview, { confirmed: true }),
      /lost exact ACK/,
    );
    const initialConsents = cp.control.consents;
    await cp.connect();
    candidate = cp.helper();
    await candidate.retry(preview.operationId, { confirmed: true });
    assert.equal(cp.control.consents, initialConsents);
    const id = preview.payload.requestId;
    assert.equal((await candidate.request(id)).state, 'pending');
    assert.equal(
      (await candidate.plan(planInput)).ready,
      false,
      'request is never a permission',
    );
    const seen = await author.request(id);
    assert.equal(
      seen.target,
      null,
      'source author does not inherit private target read',
    );
    assert.equal(seen.participationIds, undefined);
    assert.equal(seen.role, 'source-author');
    assert.equal(seen.permissionGranted, false);
    assert.ok(
      seen.materials.every((m) => group.sourceRefs.some((r) => r.id === m.id)),
    );
    assert.equal(
      JSON.stringify(seen).includes(work.result.eventId),
      false,
      'other author material IDs absent',
    );
    await assert.rejects(
      f.qualificationRequests.read(n.actor, { requestId: id }),
      /unavailable/,
    );
    const duplicate = await candidate.prepareRequest(plan, group);
    await assert.rejects(
      candidate.execute(duplicate, { confirmed: true }),
      /cooldown/,
    );
    await candidate.stopLocalRetry(duplicate.operationId, { confirmed: true });
    const notifications = await call(f, '/v2/notifications/query', {});
    const note = notifications.items.find(
      (i) => i.object.type === 'qualification-request' && i.object.id === id,
    );
    assert.ok(note);
    assert.equal(
      (
        await call(f, '/v2/notifications/read', {
          id: note.id,
          reader: 'human',
        })
      ).read,
      true,
    );
    const grantPreview = await author.preparePermission(seen);
    ca.control.mode = 'business-ack';
    await assert.rejects(
      author.execute(grantPreview, { confirmed: true }),
      /lost exact ACK/,
    );
    const grantPosts = ca.control.posts.length;
    author = ca.helper();
    assert.equal(
      (await author.reconcile(grantPreview.operationId)).state,
      'acknowledged',
    );
    assert.equal(ca.control.posts.length, grantPosts);
    assert.equal(
      (await author.request(id)).state,
      'pending',
      'separate source permission does not silently respond to request',
    );
    const owned = await author.grants({ taskId: t.taskId });
    assert.equal(owned.items[0].state, 'recorded-current-intent');
    assert.equal(owned.items[0].payload.id, grantPreview.operationId);
    const link = await author.prepareResponse(
      await author.request(id),
      'record-permission',
      { grantId: grantPreview.operationId },
    );
    await author.execute(link, { confirmed: true });
    assert.equal((await candidate.request(id)).state, 'permission-recorded');
    assert.equal(
      (await candidate.plan(planInput)).ready,
      false,
      'first author permission does not authorize second author',
    );
    const secondGroup = plan.authors.find(
        (a) => a.sourceAuthorId === q.actor.subjectId,
      ),
      secondRequest = await candidate.prepareRequest(plan, secondGroup);
    await candidate.execute(secondRequest, { confirmed: true });
    const secondView = await secondAuthor.request(
      secondRequest.payload.requestId,
    );
    assert.equal(secondView.target, null);
    assert.ok(
      secondView.materials.every((m) =>
        secondGroup.sourceRefs.some((r) => r.id === m.id),
      ),
    );
    const secondGrant = await secondAuthor.preparePermission(secondView);
    await secondAuthor.execute(secondGrant, { confirmed: true });
    await secondAuthor.execute(
      await secondAuthor.prepareResponse(secondView, 'record-permission', {
        grantId: secondGrant.operationId,
      }),
      { confirmed: true },
    );
    const collected = await candidate.plan(planInput);
    assert.equal(collected.ready, true);
    const compute = await candidate.prepareCompute(collected);
    await candidate.execute(compute, { confirmed: true });
    const catalogCompute = await call(p, '/v2/qualification/candidates', {
      taskId: t.taskId,
      kind: 'calculation',
    });
    assert.equal(catalogCompute.items.length, 1);
    assert.equal(
      catalogCompute.items[0].evidence.calculationGrantId,
      compute.operationId,
    );
    const evidence = {
      ...compute.payload.evidence,
      calculationGrantId: compute.operationId,
    };
    const result = await f.qualification.v2.evaluate(n.actor, {
      taskId: t.taskId,
      subjectId: p.actor.subjectId,
      evidence,
      includeSimulation: true,
    });
    assert.equal(result.state, 'insufficient-evidence');
    assert.equal(result.simulation.state, 'satisfied');
    const bounded = JSON.stringify(result);
    for (const secret of [
      work.open.title,
      work.cid,
      work2.cid,
      f.actor.subjectId,
      q.actor.subjectId,
    ])
      assert.equal(
        bounded.includes(secret),
        false,
        'bounded result never exposes old text or third-party identity',
      );
    const cancel = await candidate.prepareResponse(
      await candidate.request(id),
      'cancel',
      { reason: '停止协调；原作者许可独立存在' },
    );
    await candidate.execute(cancel, { confirmed: true });
    assert.equal((await author.request(id)).state, 'cancelled');
    assert.equal(
      (await author.grants({ taskId: t.taskId })).items[0].state,
      'recorded-current-intent',
    );
    const revoke = await author.prepareRevoke(
      owned.items[0],
      '本人撤销这次限定用途',
    );
    await author.execute(revoke, { confirmed: true });
    assert.equal((await candidate.plan(planInput)).ready, false);
    await assert.rejects(
      f.qualification.v2.evaluate(n.actor, {
        taskId: t.taskId,
        subjectId: p.actor.subjectId,
        evidence,
        includeSimulation: true,
      }),
      /qualification_calculation_unavailable/,
    );
    async function requestAt(target) {
      const q = await candidate.plan({ ...planInput, taskId: target.taskId }),
        pr = await candidate.prepareRequest(
          q,
          q.authors.find((a) => a.sourceAuthorId === f.actor.subjectId),
        );
      await candidate.execute(pr, { confirmed: true });
      return pr;
    }
    const decline = await requestAt(declinedTarget);
    await author.execute(
      await author.prepareResponse(
        await author.request(decline.payload.requestId),
        'decline',
        { reason: '不同意此用途' },
      ),
      { confirmed: true },
    );
    assert.equal(
      (await candidate.request(decline.payload.requestId)).state,
      'declined',
    );
    const stopped = await requestAt(cancelTarget);
    await candidate.execute(
      await candidate.prepareResponse(
        await candidate.request(stopped.payload.requestId),
        'cancel',
        { reason: '本人不再申请' },
      ),
      { confirmed: true },
    );
    assert.equal(
      (await author.request(stopped.payload.requestId)).state,
      'cancelled',
    );
    const again = await candidate.plan({
        ...planInput,
        taskId: reconnectTarget.taskId,
      }),
      reauth = await candidate.prepareRequest(
        again,
        again.authors.find((a) => a.sourceAuthorId === f.actor.subjectId),
      );
    cp.control.mode = 'before-consent';
    await assert.rejects(
      candidate.execute(reauth, { confirmed: true }),
      /before Consent/,
    );
    await cp.connect();
    candidate = cp.helper();
    const review = await candidate.reviewAuthorization(reauth.operationId);
    assert.equal(review.state, 'reauthorization-required');
    await candidate.reauthorize(reauth.operationId, review, {
      confirmed: true,
    });
    assert.equal(
      (await candidate.request(reauth.payload.requestId)).requestId,
      reauth.payload.requestId,
    );
    const expiry = await requestAt(expiredTarget),
      data = await call(p, '/v1/data-exports/create', {
        id: randomUUID(),
        datasets: [
          'qualification-request-events',
          'qualification-request-receipts',
        ],
      });
    const exported = await call(p, '/v1/data-exports/page', {
      id: data.id,
      dataset: 'qualification-request-events',
    });
    assert.ok(exported.items.some((x) => x.id === expiry.operationId));
    assert.ok(exported.items.every((x) => x.subject_id === p.actor.subjectId));
    const renewedPlan=await candidate.plan({...planInput,taskId:expiredTarget.taskId,expiresAt:new Date((now+400)*1000).toISOString()}),renewed=await candidate.prepareRequest(renewedPlan,renewedPlan.authors.find(a=>a.sourceAuthorId===f.actor.subjectId));
    const originalNow=f.access.now;cp.control.beforeBusiness=()=>{f.access.now=()=>now+301;};
    try{await assert.rejects(candidate.execute(renewed,{confirmed:true}),/cooldown/,'short expiry cannot bypass the 24 hour request cooldown');assert.equal((await author.request(expiry.payload.requestId)).state,'expired');await candidate.stopLocalRetry(renewed.operationId,{confirmed:true});}finally{f.access.now=originalNow;}
    const erased = await transaction(worker, (db) =>
      cleanupQualificationRequestsWithin(db, now + 301),
    );
    assert.ok(erased.qualificationRequestBodies >= 8);
    assert.equal(
      (
        await admin.query(
          'SELECT payload_text FROM qualification_permission_request_events WHERE id=$1',
          [expiry.operationId],
        )
      ).rows[0].payload_text,
      '',
    );
    assert.equal(
      await candidate.reconcile(expiry.operationId).catch(() => null),
      null,
      'acknowledged journal correctly has no pending operation',
    );
    const receipt = await call(
      p,
      '/v2/qualification/permission-requests/receipt',
      { eventId: expiry.operationId, payloadHash: expiry.payloadHash },
    );
    assert.equal(receipt.state, 'acknowledged');
    assert.equal(receipt.currentReadPermissionConfirmed, false);
    assert.equal(
      (await author.request(expiry.payload.requestId)).state,
      'request-source-unavailable',
    );
    p.actor = await f.access.authenticate(cp.control.credential);
    const independent = (
      await admin.query(
        'SELECT * FROM qualification_permission_request_events WHERE id=$1',
        [link.operationId],
      )
    ).rows[0];
    const deletionCommand = await approveFixtureDeletion(p, admin, {
      auditUntil: now + 600,
    });
    const deleted = await executeDeletion(admin, deletionCommand, {
      now: () => now,
    });
    assert.ok(deleted.physicalDeletionPerformed);
    assert.deepEqual(
      (
        await admin.query(
          'SELECT * FROM qualification_permission_request_events WHERE id=$1',
          [link.operationId],
        )
      ).rows[0],
      independent,
      'deleting candidate never removes independently authored response',
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM qualification_permission_request_events WHERE subject_id=$1 AND payload_text<>''",
          [p.actor.subjectId],
        )
      ).rows[0].n,
      0,
    );
    const final = await transaction(worker, (db) =>
      cleanupQualificationRequestsWithin(db, now + 301 + 180 * 86400),
    );
    assert.ok(final.qualificationRequestReceipts >= 1);
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int n FROM qualification_permission_requests',
        )
      ).rows[0].n,
      0,
    );
    assert.ok(
      (
        await admin.query(
          'SELECT id FROM qualification_calculation_grants WHERE id=$1',
          [grantPreview.operationId],
        )
      ).rows.length,
      'request retention never erases independent source permission',
    );
    return {
      actualHttp: true,
      legacyCurrentAccepted: true,
      sourceAuthorSeparation: true,
      lostConsentAndBusinessAck: true,
      reauthorizationSameBusinessId: true,
      workerRetention: true,
    };
  } finally {
    for (const browser of browsers) browser.disconnect();
    if (api) {
      api.closeAllConnections();
      await new Promise((r) => api.close(r));
    }
    if (!database) await f.db.close();
  }
}
