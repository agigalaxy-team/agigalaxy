import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { runInformationCapacityV2 } from '../information-capacity-v2-workflow.mjs';

// Run only against a freshly provisioned disposable database selected by the
// owning integration thread. No automatic schema/role setup or remote target.
// PG credentials arrive through process injection and never enter the report.
assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
assert.equal(process.env.GALAXY_TEST_CAPACITY_ISOLATED, '1');
const expectedDatabase = process.env.GALAXY_TEST_CAPACITY_DATABASE;
assert.ok(expectedDatabase && expectedDatabase === process.env.PGDATABASE, 'Explicit exact isolated database required');
const admin = new pg.Pool({ max: 2, statement_timeout: 10000, application_name: 'galaxy-capacity-statistics' });
let runtime;
try {
  const actual = (await admin.query('SELECT current_database() AS name')).rows[0].name;
  assert.equal(actual, expectedDatabase);
  const pristine = (await admin.query('SELECT (SELECT count(*) FROM subjects)::int AS subjects, (SELECT count(*) FROM task_requests)::int AS tasks')).rows[0];
  assert.equal(pristine.subjects, 0, 'Use a fresh disposable database, never existing users'); assert.equal(pristine.tasks, 0);
  assert.ok(process.env.GALAXY_TEST_CAPACITY_API_USER, 'Owning launcher supplies a provisioned non-superuser LOGIN inheriting galaxy_api');
  assert.ok(process.env.GALAXY_TEST_CAPACITY_API_PASSWORD, 'API password must be injected only into the process');
  runtime = new pg.Pool({ user: process.env.GALAXY_TEST_CAPACITY_API_USER, password: process.env.GALAXY_TEST_CAPACITY_API_PASSWORD,
    max: 8, statement_timeout: 10000, application_name: 'galaxy-capacity-api', options: '-c role=galaxy_api' });
  let costInput = null;
  if (process.env.GALAXY_TEST_COST_INPUT_FILE) {
    const path = process.env.GALAXY_TEST_COST_INPUT_FILE; assert.ok(isAbsolute(path));
    const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 8192);
    costInput = JSON.parse(await readFile(path, 'utf8'));
  }
  const result = await runInformationCapacityV2(runtime, { isolated: true, migrateDatabase: false, repositories: apiReads, adminDatabase: admin, costInput });
  console.log(JSON.stringify({ event: 'information_capacity_isolated_postgres', ...result }));
  assert.equal(result.allMeasuredRequestsSucceeded, true, 'One or more observed experiment requests failed; report retains counts');
  assert.equal(result.allRequiredMeasurementsComplete, true, 'Required PostgreSQL observations were unavailable; report retains the gap');
} finally {
  if (runtime) await runtime.end(); await admin.end();
}
