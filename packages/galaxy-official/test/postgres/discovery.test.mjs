import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyDiscoveryWorkflow } from '../discovery-workflow.mjs';
test('project discovery runs through HTTP on PostgreSQL using the existing restricted API role', { timeout: 60000 }, async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  const admin = new pg.Pool(), api = new pg.Pool({ max: 8, options: '-c role=galaxy_api', statement_timeout: 10000 });
  try {
    await migrate(admin); await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql', import.meta.url), 'utf8'));
    await verifyDiscoveryWorkflow(api, { migrateDatabase: false, repositories: apiReads });
  } finally { await api.end(); await admin.end(); }
});
