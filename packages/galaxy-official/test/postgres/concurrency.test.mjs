import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { readFile } from 'node:fs/promises';
import { workerReads } from '../../src/infrastructure/worker-reads.mjs';
import { assertSupportedSchema, migrations } from '../../src/infrastructure/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { serviceFixture } from '../service-fixture.mjs';
import { EvidenceService } from '../../src/evidence.mjs';
import { ConsentReader } from '../../src/consent-reader.mjs';
import { inspectGithubRun } from '../../src/github-evidence.mjs';
import { transaction, migrate } from '../../src/database.mjs';

test('isolated PostgreSQL: concurrent binding, idempotency, worker leases, revocation, rollback and restore', async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1', 'Run scripts/test-postgres.mjs; external DBs are not accepted.');
  const db = new pg.Pool({ max: 8, statement_timeout: 10000 });
  db.close = () => db.end();
  let f;
  let workerDb;
  let apiDb;
  try {
    await migrate(db);
    await db.query(await readFile(new URL('../../src/infrastructure/api-role.sql', import.meta.url), 'utf8'));
    apiDb = new pg.Pool({ max: 8, options: '-c role=galaxy_api', statement_timeout: 10000 });
    f = await serviceFixture(['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'assistance'], apiDb,
      { migrateDatabase: false, repositories: apiReads });
    assert.equal((await apiDb.query('SELECT current_role')).rows[0].current_role, 'galaxy_api');
    assert.equal((await apiDb.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'read committed');
    await assert.rejects(apiDb.query('CREATE TABLE forbidden_fixture(id integer)'), /permission denied/);
    await assert.rejects(apiDb.query('UPDATE subjects SET public_key=public_key'), /permission denied/);
    await assert.rejects(apiDb.query('UPDATE case_events SET payload=payload'), /permission denied/);
    await assert.rejects(apiDb.query('DELETE FROM case_events'), /permission denied/);
    await assert.rejects(apiDb.query("UPDATE audit_events SET outcome='forged'"), /permission denied/);
    await assert.rejects(apiDb.query('DELETE FROM audit_events'), /permission denied/);
    await assert.rejects(apiDb.query('UPDATE evidence_submissions SET state=state'), /permission denied/);
    const request = await f.bindings.challenge({ subjectId: f.genesis.id, genesisProof: f.genesis.genesisProof,
      installationId: randomUUID(), scopes: ['binding'] });
    const bindInput = { challenge: request.challenge, clientSession: request.clientSession,
      signature: await f.signForTest(request.challenge, 'galaxy-binding-response+jws') };
    const bound = await Promise.all([f.bindings.bind(bindInput), f.bindings.bind(bindInput)]);
    assert.equal(bound[0].bindingId, bound[1].bindingId);
    assert.ok(apiDb.totalCount >= 2, 'Binding race must use multiple real connections');
    assert.equal(Number((await db.query('SELECT count(*) FROM bindings WHERE challenge_id=$1', [request.challengeId])).rows[0].count), 1);

    const parent = { id: randomUUID(), kind: 'case', localRef: 'case_pg_fixture', title: 'Synthetic PG case', summary: 'Synthetic only',
      source: { kind: 'local', reference: 'case_pg_fixture' }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    const grant = await f.authorize(parent);
    // Fail the last repository write, after Case/event/state writes. A separate
    // connection for any of those writes would leak facts across this rollback.
    await db.query(`CREATE FUNCTION fixture_fail_case_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'case.case' THEN RAISE EXCEPTION 'fixture audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION fixture_fail_case_audit()`);
    try {
      await assert.rejects(f.cases.submit(f.actor, grant), /fixture audit failure/);
      assert.equal(Number((await db.query('SELECT count(*) FROM cases WHERE id=$1', [parent.id])).rows[0].count), 0);
      assert.equal(Number((await db.query('SELECT count(*) FROM case_events WHERE case_id=$1', [parent.id])).rows[0].count), 0);
      assert.equal(Number((await db.query("SELECT count(*) FROM audit_events WHERE object_id=$1 AND action='case.case'", [parent.id])).rows[0].count), 0);
    } finally {
      await db.query('DROP TRIGGER fixture_audit_failure ON audit_events; DROP FUNCTION fixture_fail_case_audit()');
    }
    const submitted = await Promise.all([f.cases.submit(f.actor, grant), f.cases.submit(f.actor, grant)]);
    assert.deepEqual(submitted[0], submitted[1]);
    assert.equal(Number((await db.query('SELECT count(*) FROM case_events WHERE case_id=$1', [parent.id])).rows[0].count), 1);
    const help = { id: randomUUID(), caseId: parent.id, title: 'PG help', problem: 'Synthetic request',
      attemptedApproaches: [], scope: 'Inspect', visibility: 'Private', collaboration: 'open-assistance',
      enrollmentExpiresAt: f.now + 1000 };
    const helpGrant = await f.authorize(help, 'assistance.publish');
    const helpReceipts = await Promise.all([f.assistance.create(f.actor, helpGrant), f.assistance.create(f.actor, helpGrant)]);
    assert.deepEqual(helpReceipts[0], helpReceipts[1]);
    const cancelHelp = { assistanceId: help.id, event: { id: randomUUID(), expectedVersion: 1, kind: 'cancel', reason: 'Fixture completed' } };
    await f.assistance.submit(f.actor, help.id, await f.authorize(cancelHelp, 'assistance.publish', { objectId: cancelHelp.event.id }));
    assert.equal((await f.assistance.get(f.actor, help.id)).state, 'canceled');
    assert.equal(Number((await db.query('SELECT count(*) FROM assistance_events WHERE assistance_id=$1', [help.id])).rows[0].count), 2);
    const attempt = { id: randomUUID(), kind: 'attempt', caseId: parent.id, expectedVersion: 1, sequence: 1,
      approach: 'Fixture', configuration: { environment: 'postgres-test', version: '1', tools: [] } };
    await f.cases.submit(f.actor, await f.authorize(attempt));
    const result = { id: randomUUID(), kind: 'result', caseId: parent.id, expectedVersion: 2, attemptId: attempt.id,
      outcome: 'failed', summary: 'Synthetic failure retained', failureReason: 'Fixture failure', limitations: ['Synthetic'] };
    await f.cases.submit(f.actor, await f.authorize(result));
    const payload = { id: randomUUID(), caseId: parent.id, resultId: result.id, source: {
      provider: 'github-actions', owner: 'fixture', repository: 'example', runId: 1, attempt: 1, commit: 'a'.repeat(40) } };
    await f.evidence.submit(f.actor, await f.authorize(payload, 'evidence.submit'));
    await db.query(await readFile(new URL('../../src/infrastructure/worker-role.sql', import.meta.url), 'utf8'));
    workerDb = new pg.Pool({ max: 4, options: '-c role=galaxy_evidence_worker', statement_timeout: 10000 });
    assert.equal((await workerDb.query('SELECT current_role')).rows[0].current_role, 'galaxy_evidence_worker');
    assertSupportedSchema((await workerDb.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
    await assert.rejects(workerDb.query('SELECT * FROM access_credentials'), /permission denied/);
    await assert.rejects(workerDb.query('SELECT * FROM binding_challenges'), /permission denied/);
    await assert.rejects(workerDb.query('SELECT * FROM audit_events'), /permission denied/);
    await assert.rejects(workerDb.query("UPDATE audit_events SET outcome='forged'"), /permission denied/);
    await assert.rejects(workerDb.query('DELETE FROM audit_events'), /permission denied/);
    await assert.rejects(workerDb.query('UPDATE cases SET state=state'), /permission denied/);
    await assert.rejects(workerDb.query('DELETE FROM case_events'), /permission denied/);
    await assert.rejects(workerDb.query('UPDATE evidence_submissions SET payload_text=payload_text'), /permission denied/);
    await assert.rejects(workerDb.query('UPDATE jobs SET payload=payload'), /permission denied/);
    const worker = () => new EvidenceService(null, new ConsentReader({ now: () => f.now, readGrant: workerReads.readGrant }),
      { db: workerDb, endpoint: f.bindings.endpoint, now: () => f.now, readCase: workerReads.readCase });
    let calls = 0;
    const observe = (source, now) => {
      calls++;
      return inspectGithubRun(source, { id: source.runId, run_attempt: 1, head_sha: source.commit,
        repository: { full_name: 'fixture/example', private: false, id: 123 }, updated_at: new Date(now * 1000).toISOString(),
        status: 'completed', conclusion: 'failure' }, now);
    };
    const raced = await Promise.all([worker().processNext(observe), worker().processNext(observe)]);
    assert.equal(calls, 1);
    assert.equal(raced.filter(r => r.processed).length, 1);
    assert.ok(workerDb.totalCount >= 2, 'Worker race must use multiple real connections');
    // Exercise the actual Proof/consent lock order on separate connections.
    // Either the publication precedes revocation or it must be rejected; the
    // final read must always deny access, and deadlocks are not accepted errors.
    for (let i = 0; i < 3; i++) {
      const preview = await f.proofs.preview(f.actor, { id: randomUUID(), evidenceId: payload.id });
      const proofGrant = await f.authorize(JSON.parse(preview.payloadJson), 'proof.publish',
        { visibility: 'Public', purpose: 'public-profile' });
      const [publication, revocation] = await Promise.allSettled([
        f.proofs.publish(f.actor, proofGrant), f.consents.revoke(f.actor, proofGrant.consentId),
      ]);
      assert.equal(revocation.status, 'fulfilled');
      if (publication.status === 'rejected') assert.equal(publication.reason.code, 'consent_required');
      await assert.rejects(f.proofs.get(null, JSON.parse(preview.payloadJson).id), /not_found/);
    }

    const second = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 2 } };
    const consent = await f.authorize(second, 'evidence.submit');
    await f.evidence.submit(f.actor, consent);
    const revoked = await worker().processNext(async (source, now) => {
      await f.consents.revoke(f.actor, consent.consentId);
      return observe(source, now);
    });
    assert.equal(revoked.state, 'revoked');
    await assert.rejects(f.evidence.get(f.actor, second.id), /consent_required/);
    const third = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 3 } };
    await f.evidence.submit(f.actor, await f.authorize(third, 'evidence.submit'));
    const stale = await worker().processNext(async (source, now) => {
      await db.query("UPDATE jobs SET lease_id=$1,locked_until=$2 WHERE payload->>'evidenceId'=$3",
        [randomUUID(), new Date((f.now - 1) * 1000).toISOString(), third.id]);
      return observe(source, now);
    });
    assert.equal(stale.leaseLost, true);
    assert.equal((await db.query("SELECT * FROM audit_events WHERE action='evidence.observe' AND object_id=$1", [third.id])).rows.length, 0);
    assert.equal(Number((await db.query('SELECT count(*) FROM verification_attempts WHERE evidence_id=$1', [third.id])).rows[0].count), 0);
    assert.equal((await worker().processNext(observe)).state, 'observed');
    assert.equal(Number((await db.query('SELECT count(*) FROM verification_attempts WHERE evidence_id=$1', [third.id])).rows[0].count), 1);

    await assert.rejects(transaction(db, async tx => {
      await tx.query("INSERT INTO audit_events(actor,action,object_id,request_id,outcome) VALUES('fixture','rollback','fixture','fixture','fixture')");
      throw new Error('rollback fixture');
    }), /rollback fixture/);
    assert.equal(Number((await db.query("SELECT count(*) FROM audit_events WHERE action='rollback'")).rows[0].count), 0);

    const crashed = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 4 } };
    await f.evidence.submit(f.actor, await f.authorize(crashed, 'evidence.submit'));
    await db.query("UPDATE jobs SET state='running',attempts=5,lease_id=$1,locked_until=$2 WHERE payload->>'evidenceId'=$3",
      [randomUUID(), new Date((f.now - 1) * 1000).toISOString(), crashed.id]);
    await Promise.all([worker().processNext(observe), worker().processNext(observe)]);
    const exhaustionAudit = (await db.query("SELECT action FROM audit_events WHERE object_id=$1 AND action IN ('verification.exhausted','evidence.unavailable') ORDER BY sequence", [crashed.id])).rows;
    assert.deepEqual(exhaustionAudit.map(row => row.action), ['verification.exhausted', 'evidence.unavailable']);
    assert.equal((await db.query('SELECT * FROM verification_attempts WHERE evidence_id=$1', [crashed.id])).rows.length, 0);

    const revokedBinding = await Promise.all([1, 2].map(() =>
      f.bindings.revoke(bound[0].bindingId, f.actor.subjectId, randomUUID(), null, f.actor)));
    assert.ok(revokedBinding.every(value => value.state === 'revoked'));
    const revokeAudit = (await db.query("SELECT credential_scopes,caller_binding_id,caller_client_id FROM audit_events WHERE action='binding.revoke' AND object_id=$1", [bound[0].bindingId])).rows;
    assert.equal(revokeAudit.length, 1);
    assert.deepEqual(revokeAudit[0].credential_scopes, f.actor.scopes);
    assert.equal(revokeAudit[0].caller_binding_id, f.actor.bindingId);
    assert.notEqual(revokeAudit[0].caller_binding_id, bound[0].bindingId);
    assert.match(revokeAudit[0].caller_client_id, /^[0-9a-f-]{36}$/);

    const suffix = process.platform === 'win32' ? '.exe' : '';
    const dump = join(process.env.GALAXY_TEST_PG_ROOT, 'snapshot.dump');
    const exec = (name, args) => {
      const r = spawnSync(join(process.env.GALAXY_TEST_PG_BIN, name + suffix), args,
        { env: process.env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
      assert.equal(r.status, 0, `${name} exit ${r.status}`);
    };
    exec('pg_dump', ['--format=custom', '--file', dump, 'postgres']);
    await db.query('CREATE DATABASE galaxy_restore');
    exec('pg_restore', ['--exit-on-error', '--dbname=galaxy_restore', dump]);
    const restored = new pg.Pool({ database: 'galaxy_restore' });
    try {
      assert.equal(Number((await restored.query('SELECT count(*) FROM case_events WHERE case_id=$1', [parent.id])).rows[0].count), 3);
      assert.equal((await restored.query('SELECT revoked_at IS NOT NULL AS revoked FROM consents WHERE id=$1', [consent.consentId])).rows[0].revoked, true);
      assertSupportedSchema((await restored.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
    } finally { await restored.end(); }
    console.log('Verified real PostgreSQL multi-connection operations and isolated dump/restore; all data synthetic.');
  } finally { if (workerDb) await workerDb.end(); if (apiDb) await apiDb.end(); await db.end(); }
});

test('isolated PostgreSQL: old prefix upgrade, migration conflict rollback, gaps and future versions', async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  const admin = new pg.Pool({ max: 1 });
  let db;
  try {
    await admin.query('CREATE DATABASE galaxy_local');
    db = new pg.Pool({ database: 'galaxy_local', max: 3, statement_timeout: 10000 });
    await db.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const migration of migrations.slice(0, 3)) {
      await db.query(migration.sql);
      await db.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
    }
    await db.query("INSERT INTO subjects(id,public_key,genesis_proof) VALUES('old-fixture','original-key','{}')");
    // Migration 4 creates cases before case_events. Conflict at the second table
    // must roll back the first CREATE and all migration history changes.
    await db.query('CREATE TABLE case_events(conflict_marker text)');
    await assert.rejects(migrate(db), error => error.code === '42P07');
    assert.equal((await db.query("SELECT to_regclass('public.cases') AS relation")).rows[0].relation, null);
    assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version), [1, 2, 3]);
    await db.query('DROP TABLE case_events');
    const roles = ['api', 'worker', 'deletion-review'];
    // Fail role provisioning after the new schema and the API grants were
    // applied. All three must roll back together, including the version rows.
    await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_api') THEN CREATE ROLE galaxy_api NOLOGIN; END IF; END $$;
      CREATE FUNCTION public.galaxy_worker_lock_case(case_id uuid, owner_id text) RETURNS text
      LANGUAGE sql AS $$ SELECT 'synthetic-conflict'::text $$`);
    const privilege = async () => (await db.query("SELECT has_table_privilege('galaxy_api','subjects','INSERT') AS allowed")).rows[0].allowed;
    assert.equal(await privilege(), false);
    await assert.rejects(migrate(db, { roles }), error => error.code === '42P13');
    assert.equal((await db.query("SELECT to_regclass('public.cases') AS relation")).rows[0].relation, null);
    assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version), [1, 2, 3]);
    assert.equal(await privilege(), false);
    assert.equal((await db.query("SELECT to_regprocedure('public.galaxy_api_lock_subject(text)') AS function")).rows[0].function, null);
    await db.query('DROP FUNCTION public.galaxy_worker_lock_case(uuid,text)');
    const expected = migrations.at(-1).version;
    assert.deepEqual(await Promise.all([migrate(db, { roles }), migrate(db, { roles })]), [expected, expected]);
    assert.ok(db.totalCount >= 2, 'Concurrent migrations must use distinct connections');
    assert.equal((await db.query("SELECT public_key FROM subjects WHERE id='old-fixture'")).rows[0].public_key, 'original-key');
    assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version), migrations.map(m => m.version));
    assert.equal(await privilege(), true);
    const connection = new URL(`postgresql://${process.env.PGHOST}:${process.env.PGPORT}/galaxy_local`);
    connection.username = process.env.PGUSER; connection.password = process.env.PGPASSWORD;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GALAXY_') && name !== 'DATABASE_URL' && name !== 'NODE_TEST_CONTEXT'));
    Object.assign(env, { GALAXY_ENVIRONMENT: 'local', DATABASE_URL: connection.href });
    const runMigration = args => spawnSync(process.execPath, [fileURLToPath(new URL('../../src/migrate.mjs', import.meta.url)), ...args],
      { env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    const appliedBefore = (await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    const cli = runMigration(['--roles=api,worker,deletion-review']);
    assert.equal(cli.status, 0, 'actual migration CLI must succeed');
    const completed = cli.stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.event === 'migration_complete');
    assert.equal(completed.version, expected); assert.equal(completed.count, 3);
    assert.deepEqual((await db.query('SELECT * FROM schema_migrations ORDER BY version')).rows, appliedBefore);
    const rejected = runMigration(['--roles=unknown']);
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /migration_failed/);
    await db.query('DELETE FROM schema_migrations WHERE version=3');
    await assert.rejects(migrate(db), /contiguous prefix/);
    const gapped = (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
    assert.throws(() => assertSupportedSchema(gapped));
    await db.query('INSERT INTO schema_migrations(version) VALUES(3),(999)');
    await assert.rejects(migrate(db), /newer/);
    assert.equal((await db.query("SELECT public_key FROM subjects WHERE id='old-fixture'")).rows[0].public_key, 'original-key');
    const report = { event: 'schema_and_role_setup', schema: expected, oldPrefix: 3, schemaConflictRolledBack: true,
      roleConflictRolledBackSchemaAndGrants: true, concurrentSetupSerialized: true, oldFactsPreserved: true,
      schemaHistoryUnchangedOnReplay: true, actualMigrationCli: true, selectedRoles: roles,
      roleSelectionRejected: true, gapAndFutureRejected: true, dynamicDeployed: false };
    console.log(JSON.stringify(report));
    if (process.env.GALAXY_TEST_MIGRATION_EVIDENCE) await writeFile(process.env.GALAXY_TEST_MIGRATION_EVIDENCE, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  } finally { if (db) await db.end(); await admin.end(); }
});

