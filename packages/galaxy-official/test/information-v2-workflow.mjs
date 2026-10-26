import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { ServiceError } from '../src/shared/service-error.mjs';

import { informationToolDefinitions } from '../src/adapters/mcp/personal/tools/information-v2.mjs';
import { cleanupInformationWatchesWithin } from '../src/operations/information-watch-retention-v2.mjs';
import { createInformationClientV2 } from "../../galaxy-web/src/features/information/client.mjs";
import { createBrowserClient } from '../src/browser-client.mjs';
import { digest } from '../src/shared/digest.mjs';
import { productV2ExportSources } from '../src/infrastructure/lifecycle-export-v2.mjs';
import { productV2DeletionTargets } from '../src/infrastructure/lifecycle-registry-v2.mjs';
const scopes = [
  'binding',
  'consent',
  'assistance',
  'history',
  'notifications',
  'proof',
  'capsules',
  'builders',
  'data-export',
];
export async function informationWorkflow(database = null, options = {}) {
  const initial = Math.floor(Date.now() / 1000),
    clock = { now: initial };
  const f = await serviceFixture(scopes, database, {
      ...options,
      now: initial,
    }),
    other = await serviceFixture(scopes, f.db, {
      ...options,
      now: initial,
      migrateDatabase: false,
    });
  f.access.now = () => clock.now;
  // Only synthetic fixture session lifetime is extended to exercise 15-minute
  // observation windows without sleeping. It does not add scopes or represent
  // real browser session renewal (the browser case below uses its own session).
  await (options.adminDatabase ?? f.db).query(
    'UPDATE access_credentials SET expires_at=$2 WHERE token_hash=$1',
    [f.actor.credentialHash, new Date((initial + 12000) * 1000).toISOString()],
  );
  const api = createApi({ ...f, rateLimit: 2000 });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + api.address().port;
  const request = async (who, path, body) => {
    const res = await fetch(origin + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(who ? { authorization: 'Bearer ' + who.credential } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const ok = async (who, path, body) => {
    const r = await request(who, path, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const watches = (method, body) =>
    ok(f, '/v2/information/watches/' + method, body);
  let taskVersion = 1;
  const task = {
    operationId: randomUUID(),
    taskId: randomUUID(),
    caseId: null,
    intent: 'proactive-review',
    workContext: {
      goal: 'Inspect information source',
      currentSituation: 'No failed attempt',
      attemptRefs: [],
    },
    title: 'Selected public parser task',
    summary: 'REAL_TASK_DESCRIPTION_70',
    visibility: 'Public',
    collaboration: 'open-assistance',
    enrollmentExpiresAt: initial + 6000,
  };
  const publicGrant = { visibility: 'Public', purpose: 'public-profile' };
  const publicSubmission = await f.authorize(task, 'assistance.publish', {
    ...publicGrant,
    objectId: task.operationId,
  });
  const original = f.information.search.query.bind(f.information.search);
  try {
    await ok(f, '/v2/tasks', publicSubmission);
    const privateTask = {
      ...task,
      operationId: randomUUID(),
      taskId: randomUUID(),
      visibility: 'Private',
      title: 'Private unrelated task',
      summary: 'NEVER_LEAK_70',
    };
    await ok(
      other,
      '/v2/tasks',
      await other.authorize(privateTask, 'assistance.publish', {
        objectId: privateTask.operationId,
      }),
    );
    const taskSource = {
      key: 'tasks',
      source: {
        kind: 'search',
        request: { type: 'task', query: { query: 'parser', limit: 1 } },
      },
    };
    const query = {
      purpose: 'Find currently available help',
      sources: [
        taskSource,
        {
          key: 'history',
          source: {
            kind: 'search',
            request: {
              type: 'history',
              query: { query: 'unseenresourcezz', limit: 8 },
            },
          },
        },
      ],
    };
    const page = await ok(null, '/v2/information/query', query);
    assert.equal(page.items[0].items.length, 1);
    assert.equal(page.items[1].state, 'no-visible-data');
    assert.equal(JSON.stringify(page).includes('NEVER_LEAK_70'), false);
    assert.equal(page.helpPaths.length, 4);
    assert.equal(page.modelCalls, 0);
    const own = await ok(f, '/v2/information/query', query);
    assert.notEqual(
      page.queryId,
      own.queryId,
      'viewer is part of stable query scope',
    );
    assert.equal(
      (await ok(f, '/v2/information/query', { ...query, queryId: own.queryId }))
        .queryId,
      own.queryId,
    );
    f.information.search.query = async (a, x) =>
      x.type === 'history'
        ? Promise.reject(new ServiceError('synthetic source failure', 503))
        : original(a, x);
    const partial = await ok(f, '/v2/information/query', query);
    assert.equal(partial.items[0].state, 'available');
    assert.equal(partial.items[1].state, 'temporarily-unavailable');
    assert.equal(partial.partial, true);
    f.information.search.query = original;
    const start = {
      operationId: randomUUID(),
      watchId: randomUUID(),
      expectedRevision: 0,
      action: 'start',
      plan: {
        purpose: query.purpose,
        sources: [taskSource],
        expiresAt: initial + 10000,
        report: { mode: 'changes' },
      },
    };
    const started = await watches('command', start);
    assert.equal(started.revision, 1);
    assert.equal((await watches('command', start)).replayed, true);
    assert.equal(
      (
        await request(other, '/v2/information/watches/list', {
          watchId: start.watchId,
        })
      ).status,
      404,
    );
    const check = () =>
      watches('check', { watchId: start.watchId, expectedRevision: 1 });
    assert.equal(
      (await check()).changed,
      false,
      'first baseline is not a new-change notification',
    );
    assert.equal((await check()).state, 'not-due');
    const extend = async () => {
      const event = {
        eventId: randomUUID(),
        expectedTaskVersion: taskVersion,
        kind: 'extend-enrollment',
        enrollmentExpiresAt: task.enrollmentExpiresAt + taskVersion * 1000,
      };
      const submission = await f.authorize(
        { taskId: task.taskId, event },
        'assistance.publish',
        { viewers: [f.actor.subjectId], objectId: event.eventId },
      );
      const response = await ok(
        f,
        '/v2/tasks/' + task.taskId + '/events',
        submission,
      );
      taskVersion = response.version;
    };
    clock.now += 901;
    await extend();
    const changed = await check();
    assert.equal(changed.changed, true);
    const notification = (await f.inbox.query(f.actor, {})).items.find(
      (i) => i.id === 'information-change:' + changed.eventId,
    );
    assert.ok(notification);
    assert.equal(notification.receiptOnly, true);
    assert.equal(JSON.stringify(notification).includes(task.summary), false);
    await f.inbox.markRead(f.actor, { id: notification.id, reader: 'human' });
    assert.equal(
      (await watches('events', { watchId: start.watchId })).current.items[0]
        .items[0].record.request.title,
      task.title,
    );
    const before = (
      await f.db.query(
        'SELECT baseline FROM information_watches_v2 WHERE id=$1',
        [start.watchId],
      )
    ).rows[0].baseline;
    f.information.search.query = async () => {
      throw new ServiceError('synthetic watch source failure', 503);
    };
    clock.now += 901;
    assert.equal((await check()).state, 'partial-source-failure');
    assert.deepEqual(
      (
        await f.db.query(
          'SELECT baseline FROM information_watches_v2 WHERE id=$1',
          [start.watchId],
        )
      ).rows[0].baseline,
      before,
    );
    assert.equal(
      (await watches('list', { watchId: start.watchId })).items[0]
        .sourceCoverage[0].complete,
      false,
    );
    f.information.search.query = original;
    const pause = {
      action: 'pause',
      operationId: randomUUID(),
      watchId: start.watchId,
      expectedRevision: 1,
    };
    await watches('stop', pause);
    assert.equal(
      (await watches('check', { watchId: start.watchId, expectedRevision: 2 }))
        .state,
      'paused',
    );
    assert.equal(
      (await f.inbox.query(f.actor, {})).items.some(
        (i) => i.id === notification.id,
      ),
      false,
      'paused watches do not surface future alerts',
    );
    const eventsBefore = (
      await f.db.query(
        'SELECT count(*)::int n FROM information_watch_changes_v2 WHERE watch_id=$1',
        [start.watchId],
      )
    ).rows[0].n;
    const resume = await watches('command', {
      action: 'resume',
      operationId: randomUUID(),
      watchId: start.watchId,
      expectedRevision: 2,
    });
    let pausedDuring = false;
    f.information.search.query = async (a, x) => {
      const result = await original(a, x);
      if (!pausedDuring) {
        pausedDuring = true;
        await f.informationWatches.command(f.actor, {
          action: 'pause',
          operationId: randomUUID(),
          watchId: start.watchId,
          expectedRevision: 3,
        });
      }
      return result;
    };
    assert.equal(
      (
        await watches('check', {
          watchId: start.watchId,
          expectedRevision: resume.revision,
        })
      ).state,
      'superseded-during-check',
    );
    f.information.search.query = original;
    assert.equal(
      (
        await f.db.query(
          'SELECT count(*)::int n FROM information_watch_changes_v2 WHERE watch_id=$1',
          [start.watchId],
        )
      ).rows[0].n,
      eventsBefore,
    );
    // Daily mode produces only accumulated changes, at the user's explicit UTC time.
    const daily = {
      ...start,
      operationId: randomUUID(),
      watchId: randomUUID(),
      plan: {
        ...start.plan,
        report: {
          mode: 'daily',
          utcMinute: Math.floor((clock.now % 86400) / 60) + 3,
        },
      },
    };
    daily.plan.report.utcMinute %= 1440;
    await watches('command', daily);
    await watches('check', { watchId: daily.watchId, expectedRevision: 1 });
    await extend();
    clock.now += 901;
    const dailyChanged = await watches('check', {
      watchId: daily.watchId,
      expectedRevision: 1,
    });
    assert.equal(dailyChanged.changed, true);
    const dailyRow = (
      await f.db.query(
        'SELECT * FROM information_watch_changes_v2 WHERE id=$1',
        [dailyChanged.eventId],
      )
    ).rows[0];
    assert.ok(Date.parse(dailyRow.available_at) > clock.now * 1000);
    assert.equal(
      await f.informationWatches.notificationWithin(
        f.db,
        f.actor,
        dailyChanged.eventId,
      ),
      null,
    );
    const finish = await watches('stop', {
      action: 'end',
      operationId: randomUUID(),
      watchId: daily.watchId,
      expectedRevision: 1,
    });
    assert.equal(finish.state, 'ended');
    assert.equal(
      (
        await request(f, '/v2/information/watches/command', {
          action: 'resume',
          operationId: randomUUID(),
          watchId: daily.watchId,
          expectedRevision: 2,
        })
      ).status,
      409,
    );
    const durable = JSON.stringify(
      (await f.db.query('SELECT baseline,scan FROM information_watches_v2'))
        .rows,
    );
    assert.equal(
      durable.includes(task.summary),
      false,
      'observation stores only references, not source bodies',
    );
    await f.consents.revoke(f.actor, publicSubmission.consentId);
    const afterRevoke = await watches('events', { watchId: start.watchId });
    assert.equal(afterRevoke.current.items[0].items.length, 0);
    assert.equal(JSON.stringify(afterRevoke).includes(task.summary), false);
    assert.equal(
      JSON.stringify(afterRevoke.events).includes(task.taskId),
      false,
      'old source receipt does not redisclose a now-unavailable source ID',
    );
    clock.now = initial;
    await browserRecovery(f, origin, initial, clock, f.bindings.trustedKeys);
    assert.equal(Object.keys(informationToolDefinitions(f, f.actor)).length, 6);
    assert.ok(
      productV2ExportSources['information-watches'].fields.includes('t.plan'),
    );
    assert.equal(
      productV2ExportSources['information-change-receipts'].fields.includes(
        'changes',
      ),
      false,
    );
    for (const table of [
      'information_watches_v2',
      'information_watch_changes_v2',
      'information_watch_operations_v2',
    ])
      assert.equal(productV2DeletionTargets[table], 't.subject_id=$1');
    const removed = await cleanupInformationWatchesWithin(
      options.workerDatabase ?? f.db,
      initial + 110 * 86400,
    );
    assert.ok(removed.informationWatchReceipts >= 2);
    assert.equal(
      (await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,
      2,
      'expiry never deletes source Tasks',
    );
  } finally {
    f.information.search.query = original;
    await new Promise((r) => api.close(r));
    if (!database) await f.db.close();
  }
}

async function browserRecovery(f, origin, initial, clock, trustedKeys) {
  const publicKey = f.genesis.genesisProof.publicKeyPem,
    deviceId = randomUUID();
  const upgrade = {
    version: 2,
    operationId: randomUUID(),
    subjectId: f.actor.subjectId,
    kind: 'bootstrap',
    expectedEpoch: 0,
    previousEventHash: null,
    signerKeyId: digest(publicKey),
    genesisProof: f.genesis.genesisProof,
    newDevice: {
      deviceId,
      publicKeyPem: publicKey,
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
  let lose = true,
    writes = 0;
  const api = createBrowserClient({
    endpoint: f.access.endpoint,
    trustedKeys,
    sign: f.signForTest,
    now: () => clock.now,
    fetch: async (url, init) => {
      const path = new URL(url).pathname,
        res = await fetch(origin + path, init);
      if (path === '/v2/information/watches/command') {
        writes++;
        if (lose && res.status === 200) {
          lose = false;
          throw Error('synthetic lost watch acknowledgement');
        }
      }
      return res;
    },
  });
  const connect = () =>
    api.connect(
      {
        subjectId: f.actor.subjectId,
        genesisProof: f.genesis.genesisProof,
        installationId: randomUUID(),
        scopes,
        control: { deviceId, keyId: digest(publicKey), epoch: 1 },
      },
      { confirmed: true },
    );
  const memory = new Map(),
    runtime = {
      api,
      getLocal: async (k) => structuredClone(memory.get(k) ?? null),
      putLocal: async (k, v) => memory.set(k, structuredClone(v)),
      updateLocal: async (k, change) => {
        const value = change(structuredClone(memory.get(k) ?? null));
        memory.set(k, structuredClone(value)); return structuredClone(value);
      },
    };
  try {
    await connect();
    const c = createInformationClientV2({
        runtime,
        subjectId: f.actor.subjectId,
      }),
      command = {
        action: 'start',
        operationId: randomUUID(),
        watchId: randomUUID(),
        expectedRevision: 0,
        plan: {
          purpose: 'Explicit browser recovery',
          sources: [
            {
              key: 'tasks',
              source: {
                kind: 'search',
                request: { type: 'task', query: { limit: 8 } },
              },
            },
          ],
          expiresAt: clock.now + 900,
        },
      };
    await c.prepare(command);
    await assert.rejects(c.execute(command.operationId), /确认/);
    await assert.rejects(
      c.execute(command.operationId, { confirmed: true }),
      /lost watch/,
    );
    assert.equal((await c.pending())[0].state, 'result-unknown');
    await connect();
    await c.execute(command.operationId, { confirmed: true });
    assert.equal(writes, 1, 'lost ACK recovers same original operation');
  } finally {
    api.close();
  }
}
