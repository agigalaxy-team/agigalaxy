import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { queueFixture } from './operations-jobs-fixture.mjs';
import { createInformationWatchWorker } from '../src/information-watch-worker.mjs';

const scopes = ['binding', 'consent', 'assistance', 'history', 'notifications'];
const command = now => ({ action: 'start', operationId: randomUUID(), watchId: randomUUID(), expectedRevision: 0,
  plan: { purpose: 'Follow permitted review requests', expiresAt: now + 10000, report: { mode: 'changes' },
    sources: [{ key: 'review', source: { kind: 'search', request: { type: 'task', query: { query: 'watch-fixture', limit: 10 } } } }] } });
async function queued(db, id) {
  const row = (await db.query('SELECT revision,check_revision FROM information_watches_v2 WHERE id=$1', [id])).rows[0];
  return { watchId: id, revision: row.revision, checkRevision: row.check_revision };
}

test('watch continues without the expired session, keeps private receipts and stops at current revocation', async () => {
  const f = await serviceFixture(scopes);
  const clock = { now: f.now }, queue = queueFixture(f.db);
  f.access.now = () => clock.now;
  const worker = createInformationWatchWorker({ services: f, jobs: queue.jobs, now: () => clock.now });
  try {
    await queue.jobs.start();
    const start = command(clock.now);
    await f.informationWatches.command(f.actor, start);
    const run = async () => worker.execute({ ...await queued(f.db, start.watchId), subjectId: f.actor.subjectId });
    assert.equal((await run()).changed, false);
    const task = { operationId: randomUUID(), taskId: randomUUID(), caseId: null, intent: 'proactive-review',
      workContext: { goal: 'Observe actual source changes', currentSituation: 'Synthetic isolated work', attemptRefs: [] },
      title: 'watch-fixture public work', summary: 'Private receipt must not contain this body', visibility: 'Public',
      collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 6000 };
    const grant = await f.authorize(task, 'assistance.publish', { visibility: 'Public', purpose: 'public-profile', objectId: task.operationId });
    await f.assistance.createTask(f.actor, grant);
    clock.now += 901;
    await assert.rejects(f.informationWatches.list(f.actor, {}), e => e.code === 'access_denied');
    const result = await run();
    assert.equal(result.changed, true);
    const events = (await f.db.query('SELECT changes FROM information_watch_changes_v2 WHERE watch_id=$1', [start.watchId])).rows;
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes(task.summary), false);
    assert.equal((await run()).state, 'not-due');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM information_watch_changes_v2 WHERE watch_id=$1', [start.watchId])).rows[0].n, 1);
    // Reconstruct the background component, not the browser session.
    const restored = createInformationWatchWorker({ services: f, jobs: queue.jobs, now: () => clock.now });
    await f.db.query('UPDATE bindings SET revoked_at=$2 WHERE id=$1', [f.actor.bindingId, new Date(clock.now * 1000).toISOString()]);
    clock.now += 901;
    assert.equal((await restored.execute({ ...await queued(f.db, start.watchId), subjectId: f.actor.subjectId })).state, 'authorization-required');
    assert.equal((await f.db.query('SELECT background_state FROM information_watches_v2 WHERE id=$1', [start.watchId])).rows[0].background_state, 'authorization-required');
    assert.equal((await restored.reconcile()).queued, 0);
  } finally { await queue.jobs.stop(); await f.db.close(); }
});

test('an in-flight old check cannot commit after pause, and expiry does not resume it', async () => {
  const f = await serviceFixture(scopes), queue = queueFixture(f.db);
  const clock = { now: f.now }; f.access.now = () => clock.now;
  const worker = createInformationWatchWorker({ services: f, jobs: queue.jobs, now: () => clock.now });
  try {
    await queue.jobs.start();
    const start = command(clock.now);
    await f.informationWatches.command(f.actor, start);
    const captured = { ...await queued(f.db, start.watchId), subjectId: f.actor.subjectId };
    const original = f.information.source.bind(f.information);
    f.information.source = async (...args) => {
      const page = await original(...args);
      await f.informationWatches.command(f.actor, { action: 'pause', operationId: randomUUID(), watchId: start.watchId, expectedRevision: 1 });
      return page;
    };
    assert.equal((await worker.execute(captured)).state, 'superseded');
    const row = (await f.db.query('SELECT state,baseline,check_revision FROM information_watches_v2 WHERE id=$1', [start.watchId])).rows[0];
    assert.equal(row.state, 'paused');
    assert.deepEqual(row.baseline, {});
    assert.equal(row.check_revision, 0);
    f.information.source = original;
    const managed = command(clock.now);
    await f.informationWatches.command(f.actor, managed);
    const job = (await f.db.query("SELECT id FROM galaxy_jobs.job WHERE name='information-watch' AND data->>'watchId'=$1", [managed.watchId])).rows[0];
    await queue.jobs.cancel('information-watch', job.id);
    assert.equal((await f.db.query('SELECT state FROM information_watches_v2 WHERE id=$1', [managed.watchId])).rows[0].state, 'paused');
    clock.now += 10001;
    assert.equal((await worker.execute(captured)).state, 'superseded');
    assert.equal((await worker.reconcile()).queued, 0);
  } finally { await queue.jobs.stop(); await f.db.close(); }
});
