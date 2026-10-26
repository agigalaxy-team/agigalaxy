import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { queueFixture } from './operations-jobs-fixture.mjs';
import { SearchIndex } from "../src/discovery/search-index.mjs";
import { ServiceError } from '../src/shared/service-error.mjs';

test('first-document exhaustion has durable bounded compensation and an exact-generation operator retry', async () => {
  const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'history']);
  let now = f.now;
  const queue = queueFixture(f.db);
  const make = () => new SearchIndex({ db: f.db, endpoint: f.access.endpoint, now: () => now, jobs: queue.jobs });
  try {
    await queue.jobs.start();
    let index = make();
    await index.configure({ enabled: true });
    const root = { id: randomUUID(), kind: 'case', localRef: randomUUID(), title: 'A source that has never been indexed',
      summary: 'Isolated recovery fixture', source: { kind: 'local', reference: randomUUID() },
      participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    await f.cases.submit(f.actor, await f.authorize(root, 'case.teaser.publish', { visibility: 'Public', purpose: 'public-profile' }));
    await f.db.query("UPDATE jobs SET state='completed' WHERE kind='search-index' AND payload->>'sourceType'<>'case'");
    for (let attempt = 0; attempt < 5; attempt++) {
      await index.processNext({ beforeCommit: () => { throw new Error('Synthetic temporary storage failure'); } });
      now += 301;
    }
    const failed = (await f.db.query("SELECT * FROM jobs WHERE kind='search-index' AND payload->>'sourceType'='case' AND payload->>'sourceId'=$1", [root.id])).rows[0];
    assert.equal(failed.state, 'failed');
    assert.equal((await f.db.query('SELECT 1 FROM search_documents WHERE source_id=$1', [root.id])).rows.length, 0);
    for (let attempt = 1; attempt <= 3; attempt++) {
      index = make();
      assert.equal((await index.recoverFailed()).queued, 1);
      assert.equal((await index.recoverFailed()).queued, 0, 'one queued compensation per source generation');
      const [job] = await queue.boss.fetch('search-recovery', { includeMetadata: true, ignoreStartAfter: true });
      assert.equal(job.data.recoveryAttempt, attempt);
      assert.equal((await index.recoverJob(job.data)).state, 'requeued');
      await queue.boss.complete('search-recovery', job, { state: 'requeued' });
      // Persisted boundary left by another processor exhausting that cohort.
      await f.db.query("UPDATE jobs SET state='failed',attempts=5 WHERE id=$1", [failed.id]);
    }
    index = make();
    assert.equal((await index.recoverFailed()).queued, 0, 'automatic compensation is bounded across restarts');
    const listed = await index.failures();
    assert.equal(listed.items.find(j => j.jobId === failed.id).automaticRecoveryExhausted, true);
    await assert.rejects(index.retryFailed({ jobId: failed.id, expectedGeneration: failed.payload.generation + 1 }), e => e.code === 'search_recovery_conflict');
    assert.equal((await index.retryFailed({ jobId: failed.id, expectedGeneration: failed.payload.generation })).state, 'pending');
    assert.equal((await index.processNext()).state, 'indexed');
    assert.ok((await index.candidates('case', {})).items.some(item => item.id === root.id));
    await f.db.query("UPDATE jobs SET state='pending',attempts=0,available_at=$2 WHERE id=$1", [failed.id, new Date(now * 1000).toISOString()]);
    index.build = async () => { throw new ServiceError('source_temporarily_unavailable', 503); };
    assert.equal((await index.processNext()).state, 'pending');
    assert.ok((await index.candidates('case', {})).items.some(item => item.id === root.id),
      'a temporary source failure preserves an otherwise valid projection');
    // Replaying an old compensation cannot put a completed source back in flight.
    assert.equal((await index.recoverJob({ jobId: failed.id, generation: failed.payload.generation, recoveryAttempt: 3 })).state, 'superseded');
  } finally { await queue.jobs.stop(); await f.db.close(); }
});
