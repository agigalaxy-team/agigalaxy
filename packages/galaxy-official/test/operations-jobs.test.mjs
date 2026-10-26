import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate, transaction } from "../src/infrastructure/database.mjs";
import { queueFixture } from './operations-jobs-fixture.mjs';

test('real PG queue commits with its business transaction and survives process replacement', async () => {
  const db = new PGlite();
  let queue;
  try {
    await migrate(db);
    queue = queueFixture(db);
    await queue.jobs.start();
    const data = { publicationId: randomUUID() };
    await assert.rejects(transaction(db, async tx => {
      await queue.jobs.enqueue('content-publication', data, { key: 'rollback', db: tx });
      throw new Error('business transaction rolled back');
    }), /rolled back/);
    assert.equal((await db.query("SELECT count(*)::int n FROM galaxy_jobs.job WHERE name='content-publication'")).rows[0].n, 0);
    const id = await transaction(db, tx => queue.jobs.enqueue('content-publication', data, { key: 'one-publication', db: tx }));
    assert.equal(await queue.jobs.enqueue('content-publication', data, { key: 'one-publication' }), null);
    await queue.jobs.stop();
    queue = queueFixture(db);
    await queue.jobs.start();
    const [job] = await queue.boss.fetch('content-publication', { includeMetadata: true });
    assert.equal(job.id, id);
    assert.deepEqual(job.data, data);
    await queue.boss.complete('content-publication', job, { state: 'published' });
    assert.equal((await queue.jobs.get('content-publication', id)).state, 'completed');
    const publication = await queue.jobs.enqueue('content-publication', { publicationId: randomUUID() }, { key: 'requires-domain-cancel' });
    await assert.rejects(queue.jobs.cancel('content-publication', publication),e=>e.code==='site_publication_unavailable');
    assert.equal((await queue.jobs.get('content-publication',publication)).state,'created',
      'a missing publication-domain cancellation handler must not cancel only the queue flag');
    const stopped = await queue.jobs.enqueue('search-recovery', { jobId: randomUUID(),generation:1 }, { key: 'owner-stop' });
    assert.equal((await queue.jobs.cancel('search-recovery', stopped)).state, 'cancelled');
    await assert.rejects(queue.jobs.retry('search-recovery', stopped), e => e.code === 'operations_job_not_failed');
    assert.equal(JSON.stringify(await queue.jobs.list('content-publication')).includes('publicationId'), false,
      'operations list does not expose arbitrary payloads');
  } finally { await queue?.jobs.stop(); await db.close(); }
});
