import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { workerReads } from '../../src/infrastructure/worker-reads.mjs';
import { createApi } from '../../src/http.mjs';
import { serviceFixture } from '../service-fixture.mjs';
import { verifyAdverseRequests } from '../adverse-requests-workflow.mjs';
import { verifySearchIndex } from '../search-index-workflow.mjs';
import { verifyRevocationPropagation } from '../revocation-propagation-workflow.mjs';
import { verifyFailureSpool } from '../failure-spool-workflow.mjs';

test('isolated PostgreSQL adverse requests, disk-error rollback, stale projections and queued revocation', { timeout: 180000 }, async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  const controller = new pg.Pool();
  try {
    for (const scenario of ['requests', 'search', 'revocation', 'audit']) {
      const database = 'galaxy_adverse_' + scenario;
      await controller.query('CREATE DATABASE ' + database);
      const admin = new pg.Pool({ database }), api = new pg.Pool({ database, max: 8, options: '-c role=galaxy_api', statement_timeout: 10000 }),
        worker = new pg.Pool({ database, max: 4, options: '-c role=galaxy_evidence_worker', statement_timeout: 10000 });
      try {
        await migrate(admin);
        for (const role of ['api', 'worker']) await admin.query(await readFile(new URL(`../../src/infrastructure/${role}-role.sql`, import.meta.url), 'utf8'));
        const options = { migrateDatabase: false, repositories: apiReads, workerDb: worker, workerDatabase: worker, workerReads, adminDatabase: admin };
        if (scenario === 'requests') {
          console.log(JSON.stringify({ event: 'adverse_requests_postgres', ...await verifyAdverseRequests(api, options) }));
          await verifyDatabaseDiskFailure(api, admin, options);
        }
        if (scenario === 'search') { await verifySearchIndex(api, options);console.log(JSON.stringify({ event: 'search_rebuild_faults', passed: true })); }
        if (scenario === 'revocation') console.log(JSON.stringify({ event: 'queued_revocation_and_stale_cache', ...await verifyRevocationPropagation(api, options) }));
        if (scenario === 'audit') { await verifyFailureSpool(api, options);console.log(JSON.stringify({ event: 'audit_database_outage_recovery', passed: true })); }
      } finally { await worker.end();await api.end();await admin.end(); }
    }
  } finally { await controller.end(); }
});

async function verifyDatabaseDiskFailure(database, admin, options) {
  const f = await serviceFixture(undefined, database, options), logs = [];
  const api = createApi({ ...f, logger: value => logs.push(value) });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const root = { id: randomUUID(), kind: 'case', localRef: randomUUID(), title: 'Retry after storage failure', summary: 'Synthetic only',
    source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
  const authorized = await f.authorize(root);
  const request = () => fetch('http://127.0.0.1:' + api.address().port + '/v1/cases', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.credential }, body: JSON.stringify(authorized), signal: AbortSignal.timeout(5000) });
  const before = Number((await database.query('SELECT count(*) AS count FROM cases WHERE subject_id=$1', [f.actor.subjectId])).rows[0].count);
  try {
    await admin.query("CREATE FUNCTION fixture_disk_full() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private-storage-detail' USING ERRCODE='53100'; END $$; CREATE TRIGGER fixture_disk_full BEFORE INSERT ON case_events FOR EACH ROW EXECUTE FUNCTION fixture_disk_full()");
    const failed = await request(), body = await failed.json();assert.equal(failed.status, 500);assert.equal(body.error, 'internal_error');
    assert.equal(Number((await database.query('SELECT count(*) AS count FROM cases WHERE subject_id=$1', [f.actor.subjectId])).rows[0].count), before);
    assert.equal(Number((await database.query('SELECT count(*) AS count FROM case_events WHERE case_id=$1', [root.id])).rows[0].count), 0);
    assert.ok(!JSON.stringify({ body, logs }).includes('synthetic-private-storage-detail'));assert.ok(!JSON.stringify(logs).includes(f.credential));
    await admin.query('DROP TRIGGER fixture_disk_full ON case_events; DROP FUNCTION fixture_disk_full()');
    for (let index = 0; index < 2; index++) assert.equal((await request()).status, 200);
    assert.equal(Number((await database.query('SELECT count(*) AS count FROM case_events WHERE case_id=$1', [root.id])).rows[0].count), 1);
    assert.equal(Number((await database.query("SELECT count(*) AS count FROM audit_events WHERE object_id=$1 AND action='case.case'", [root.id])).rows[0].count), 1);
    console.log(JSON.stringify({ event: 'postgres_disk_error_rollback', injectedSqlstate: '53100', partialCaseAbsent: true,
      retryCommitsExactlyOnce: true, sanitizedError: true, physicalDiskFilled: false }));
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS fixture_disk_full ON case_events; DROP FUNCTION IF EXISTS fixture_disk_full()');
    api.closeAllConnections();await new Promise(resolve => api.close(resolve));
  }
}
