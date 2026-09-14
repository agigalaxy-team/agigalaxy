import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyContextLifecycleV2 } from '../context-lifecycle-v2-workflow.mjs';

test(
  'PostgreSQL roles enforce Context owner export, expiry and independent response preservation',
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
      await verifyContextLifecycleV2({
        database: api,
        repositories: apiReads,
        migrateDatabase: false,
        adminDatabase: admin,
        workerDatabase: worker,
      });
      await assert.rejects(
        api.query("UPDATE context_grants_v2 SET payload_text=''"),
        /permission denied/,
      );
      await assert.rejects(
        worker.query('DELETE FROM context_events_v2'),
        /permission denied/,
      );
      console.log(
        JSON.stringify({
          event: 'context_lifecycle_pg_verified',
          ownerExport: true,
          expiryWorker: true,
          independentResponsePreserved: true,
          apiRole: true,
        }),
      );
    } finally {
      await worker.end();
      await api.end();
      await admin.end();
    }
  },
);
