import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyTaskCommentLifecycleV2 } from '../task-comments-lifecycle-v2-workflow.mjs';
test(
  'PostgreSQL actual Account quota, independent comment governance and lifecycle roles',
  { timeout: 120000 },
  async () => {
    assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
    const admin = new pg.Pool(),
      api = new pg.Pool({
        max: 8,
        options: '-c role=galaxy_api',
        statement_timeout: 15000,
      }),
      worker = new pg.Pool({
        options: '-c role=galaxy_evidence_worker',
        statement_timeout: 15000,
      });
    try {
      await migrate(admin, { roles: ['api'] });
      await admin.query(
        await readFile(
          new URL('../../src/infrastructure/worker-role.sql', import.meta.url),
          'utf8',
        ),
      );
      await verifyTaskCommentLifecycleV2({
        database: api,
        repositories: apiReads,
        migrateDatabase: false,
        adminDatabase: admin,
        workerDatabase: worker,
      });
      await assert.rejects(
        api.query("UPDATE task_comment_events_v2 SET payload_text=''"),
        /permission denied/,
      );
      await assert.rejects(
        worker.query("UPDATE task_comments_v2 SET review_state='approved'"),
        /permission denied/,
      );
      await assert.rejects(
        worker.query('DELETE FROM task_comments_v2'),
        /permission denied/,
      );
      console.log(
        JSON.stringify({
          event: 'task_comments_pg_verified',
          actualSyntheticOIDC: true,
          accountQuota: true,
          independentHandler: true,
          sourceDeletion: true,
          workerRole: true,
        }),
      );
    } finally {
      await worker.end();
      await api.end();
      await admin.end();
    }
  },
);
