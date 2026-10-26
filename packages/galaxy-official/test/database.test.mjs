import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, transaction, validateMigrationRoles } from "../src/infrastructure/database.mjs";
import { migrations } from '../src/infrastructure/migrations.mjs';

test('PostgreSQL schema migration is repeatable and rejects unknown future schemas', async () => {
  const db = new PGlite();
  try {
    assert.equal(await migrate(db), migrations.at(-1).version);
    assert.equal(await migrate(db), migrations.at(-1).version);
    assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, migrations.length);
    await db.query('DELETE FROM schema_migrations WHERE version=3');
    await assert.rejects(migrate(db), /contiguous prefix/);
    await db.query('INSERT INTO schema_migrations(version) VALUES(3)');
    await db.query('INSERT INTO schema_migrations (version) VALUES (999)');
    await assert.rejects(migrate(db), /newer/);
  } finally { await db.close(); }
});

test('a real older migration prefix upgrades without replacing existing facts', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const migration of migrations.slice(0, 3)) {
      await db.exec(migration.sql);
      await db.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
    }
    await db.query("INSERT INTO subjects(id,public_key,genesis_proof) VALUES('old-fixture','unchanged-public-key','{}')");
    await db.query("INSERT INTO audit_events(actor,action,object_id,request_id,outcome) VALUES('old-fixture','legacy','old','old','accepted')");
    assert.equal(await migrate(db), migrations.at(-1).version);
    assert.equal((await db.query("SELECT public_key FROM subjects WHERE id='old-fixture'")).rows[0].public_key, 'unchanged-public-key');
    const legacy = (await db.query("SELECT context_version,client_id,binding_scopes,credential_scopes FROM audit_events WHERE action='legacy'")).rows[0];
    assert.deepEqual(legacy, { context_version: 0, client_id: null, binding_scopes: null, credential_scopes: null });
    await assert.rejects(db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,
      client_id,audience,scope,consent_id,binding_id,idempotency_key) VALUES('fixture','session.create','x','x','accepted',1,
      'client','https://fixture.example','binding','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','x')`), /audit_context_complete/);

    await assert.rejects(db.query("INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version) VALUES('fixture','incomplete','x','x','accepted',1)"), /audit_context_complete/);

    await assert.rejects(db.query("UPDATE audit_events SET binding_scopes='{}' WHERE action='legacy'"), /audit_binding_scopes_array/);
    await assert.rejects(db.query("UPDATE audit_events SET credential_scopes='{}' WHERE action='legacy'"), /audit_credential_scopes_array/);
    assert.equal((await db.query("SELECT caller_binding_id FROM audit_events WHERE action='legacy'")).rows[0].caller_binding_id, null);
    await assert.rejects(db.query("UPDATE audit_events SET caller_binding_id='11111111-1111-4111-8111-111111111111' WHERE action='legacy'"), /audit_caller_complete/);
    assert.equal((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.length, migrations.length);
  } finally { await db.close(); }
});

test('administrative role setup is explicit and rejects unknown or repeated roles before database work', async () => {
  assert.deepEqual(validateMigrationRoles([]), []);
  assert.deepEqual(validateMigrationRoles(['api','worker','deletion-review']), ['api','worker','deletion-review']);
  const untouched = { connect() { assert.fail('invalid role request must not connect'); } };
  for (const roles of [['owner'], ['api','api'], ['../api'], '', null]) {
    await assert.rejects(migrate(untouched, { roles }), /supported migration roles/);
  }
});

test('failed transaction rolls back facts and audit together; constraints reject invalid references', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    await assert.rejects(transaction(db, async client => {
      await client.query("INSERT INTO subjects(id, public_key, genesis_proof) VALUES ('fixture','public','{}')");
      await client.query("INSERT INTO audit_events(actor, action, object_id, request_id, outcome) VALUES ('fixture','bind','fixture','fixture','ok')");
      throw new Error('injected failure');
    }), /injected failure/);
    assert.equal((await db.query('SELECT * FROM subjects')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM audit_events')).rows.length, 0);
    await assert.rejects(db.query("INSERT INTO access_credentials(token_hash,binding_id,scopes,expires_at) VALUES ('fixture','00000000-0000-0000-0000-000000000001','[]',now())"));
  } finally { await db.close(); }
});






