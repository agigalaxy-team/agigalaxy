import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyContextV2 } from './context-v2-workflow.mjs';
import { cleanupProductV2Retention } from '../src/operations/lifecycle-retention-v2.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';

export async function verifyContextLifecycleV2({
  database = null,
  repositories,
  migrateDatabase = true,
  adminDatabase,
  workerDatabase,
} = {}) {
  return verifyContextV2({
    database,
    repositories,
    migrateDatabase,
    now: Math.floor(Date.now() / 1000) - 60,
    extraScopes: ['data-export', 'data-delete'],
    afterWorkflow: async ({ f, p, q, clock, ga, gb, fresh, accepted }) => {
      const admin = adminDatabase ?? f.db,
        worker = workerDatabase ?? f.db;
      const datasets = ['context-grants-v2', 'context-events-v2'];
      const ticket = await f.dataExport.create(f.actor, {
        id: randomUUID(),
        datasets,
      });
      const own = await f.dataExport.page(f.actor, {
        id: ticket.id,
        dataset: 'context-grants-v2',
      });
      assert.ok(
        own.items.some(
          (x) => x.id === ga.id && x.payload_text.includes('只有 A'),
        ),
        'author can export own original before its selected expiry',
      );
      assert.equal(
        own.items.find((x) => x.id === fresh.id).payload_text,
        '',
        'expired material omitted before worker runs',
      );
      assert.equal(
        own.items.find((x) => x.id === fresh.id).content_expired,
        true,
      );
      assert.ok(
        (
          await f.db.query(
            'SELECT payload_text FROM context_grants_v2 WHERE id=$1',
            [fresh.id],
          )
        ).rows[0].payload_text,
      );
      const recipientTicket = await p.dataExport.create(p.actor, {
        id: randomUUID(),
        datasets,
      });
      assert.equal(
        (
          await p.dataExport.page(p.actor, {
            id: recipientTicket.id,
            dataset: 'context-grants-v2',
          })
        ).items.length,
        0,
      );
      const responses = await p.dataExport.page(p.actor, {
        id: recipientTicket.id,
        dataset: 'context-events-v2',
      });
      assert.ok(responses.items.some((x) => x.id === accepted.payload.id));
      assert.equal(
        JSON.stringify(responses).includes('只有 A'),
        false,
        'response export never copies another author selected text',
      );
      const swept = await cleanupProductV2Retention(worker, {
        now: () => clock.now,
      });
      assert.equal(swept.removed.expiredContextBodies, 1);
      const expired = (
        await f.db.query(
          'SELECT payload_text,payload_hash,erased_at FROM context_grants_v2 WHERE id=$1',
          [fresh.id],
        )
      ).rows[0];
      assert.equal(expired.payload_text, '');
      assert.ok(expired.erased_at);
      assert.match(expired.payload_hash, /^[a-f0-9]{64}$/);
      assert.equal(
        (await cleanupProductV2Retention(worker, { now: () => clock.now }))
          .removed.expiredContextBodies,
        0,
      );
      const independent = (
        await f.db.query('SELECT * FROM context_events_v2 WHERE id=$1', [
          accepted.payload.id,
        ])
      ).rows[0];
      const command = await approveFixtureDeletion(f, admin, {
        auditUntil: clock.now + 180,
      });
      const deletion = await executeDeletion(admin, command, {
        now: () => clock.now,
      });
      assert.ok(deletion.physicalDeletionPerformed);
      const retained = (
        await f.db.query('SELECT * FROM context_grants_v2 WHERE id=$1', [ga.id])
      ).rows[0];
      assert.ok(
        retained,
        'independent recipient acceptance retains its minimal original grant relation',
      );
      assert.equal(retained.payload_text, '');
      assert.ok(retained.erased_at);
      assert.deepEqual(
        (
          await f.db.query('SELECT * FROM context_events_v2 WHERE id=$1', [
            accepted.payload.id,
          ])
        ).rows[0],
        independent,
      );
      assert.equal(
        (
          await f.db.query(
            "SELECT count(*)::int n FROM context_grants_v2 WHERE subject_id=$1 AND payload_text<>''",
            [f.actor.subjectId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal((await p.contextV2.get(p.actor, ga.id)).materials.length, 0);
      assert.equal((await q.contextV2.get(q.actor, gb.id)).materials.length, 0);
      assert.ok(
        (
          await f.db.query(
            "SELECT original_payload_hash FROM lifecycle_erasure_records WHERE table_name='context_grants_v2' AND object_key=$1",
            [ga.id],
          )
        ).rows[0],
      );
    },
  });
}
