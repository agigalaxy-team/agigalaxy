import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { workerReads } from '../../src/infrastructure/worker-reads.mjs';
import { verifyVisibilityAcceptance } from '../visibility-acceptance-workflow.mjs';
import { verifyContextWorkflow } from '../context-workflow.mjs';

test('isolated PostgreSQL HTTP visibility and selected Context/export access use limited roles', async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  const admin = new pg.Pool(), api = new pg.Pool({ max: 6, options: '-c role=galaxy_api', statement_timeout: 10000 }),
    worker = new pg.Pool({ options: '-c role=galaxy_evidence_worker', statement_timeout: 10000 });
  try {
    await migrate(admin);
    for (const role of ['api', 'worker']) await admin.query(await readFile(new URL(`../../src/infrastructure/${role}-role.sql`, import.meta.url), 'utf8'));
    const options = { migrateDatabase: false, repositories: apiReads, workerReads, workerDb: worker };
    console.log(JSON.stringify({ event: 'visibility_acceptance_postgres', ...await verifyVisibilityAcceptance(api, options) }));
    await verifyContextWorkflow(api, options);
    console.log(JSON.stringify({ event: 'selected_context_export_postgres', passed: true, syntheticOnly: true }));
  } finally { await worker.end();await api.end();await admin.end(); }
});
